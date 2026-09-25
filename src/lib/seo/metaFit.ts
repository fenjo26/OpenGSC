// Meta-tag fitting (wave-oct T1, docs/tasks/wave-oct/T1-meta-fit.md).
//
// Why this module exists: the "Title 50–60 characters" rule was written into the prompt three
// times and the model still shipped 66–80 — counting characters is a property of tokenization,
// not of prompt phrasing. So the length is now checked and enforced by CODE, in Unicode code
// points (`metaLength`), against the single source of truth in metaLimits.ts. The model gets at
// most two narrow repair calls, and everything it returns is validated by the same code before
// it is accepted.
//
// Purity note: everything except `fitMeta`'s repair calls is pure string work — no server
// imports at module level. `@/lib/llm` is loaded dynamically inside `fitMeta` so the block
// helpers stay safe to bundle anywhere; client components do not call `fitMeta` (they go
// through POST /api/seo/meta-fit).

import { META_LIMITS, metaLength, type MetaField, type MetaFitItem, type MetaFitResponse, type MetaFitResult } from "./metaLimits";
import { decodeHtmlEntities } from "./outlineFormat";
import { extractJson } from "./prompts";

// ─── normalization ───────────────────────────────────────────────────────────────

// Case- and diacritics-insensitive fold for comparisons (keyword position, containment).
const fold = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

/**
 * One candidate, cleaned to the form it would actually be published in: markdown residue
 * stripped, HTML entities decoded, whitespace collapsed, outer quotes removed. All length
 * math happens on the CLEANED string — counting the length of a value still carrying `**` or
 * `&eacute;` is how an "in band" title ships out of band.
 */
export function normalizeMetaValue(s: unknown): string {
  let v = decodeHtmlEntities(String(s ?? ""))
    .replace(/```+/g, " ")        // stray code fences
    .replace(/\*\*/g, "")         // bold markers
    .replace(/`/g, "")            // inline code markers
    .replace(/\s+/g, " ")
    .trim();
  // Outer quotes of any writing system the models emit: "…" '…' «…» „…" “…”
  let prev = "";
  while (prev !== v) {
    prev = v;
    v = v.replace(/^["'«»„“”‘’]+\s*/, "").replace(/\s*["'«»„“”‘’]+$/, "").trim();
  }
  return v;
}

// Short service words that must never end up dangling at the end of a trimmed title
// ("Stratégie … pour" is worse than a longer title). Per-language, lower-case, folded.
const STOP_WORDS: Record<string, string[]> = {
  en: ["and", "or", "for", "with", "without", "to", "of", "in", "on", "at", "by", "from", "the", "a", "an", "vs", "versus"],
  fr: ["de", "des", "du", "au", "aux", "et", "ou", "pour", "avec", "sans", "à", "en", "dans", "par", "sur", "le", "la", "les", "un", "une", "ni", "ne", "que", "chez", "sous"],
  es: ["de", "del", "y", "o", "u", "para", "con", "sin", "a", "en", "por", "sobre", "el", "la", "los", "las", "un", "una", "que"],
  de: ["und", "oder", "für", "mit", "ohne", "zu", "zur", "zum", "in", "im", "auf", "an", "von", "vom", "dem", "den", "der", "die", "das", "bei"],
  it: ["di", "del", "della", "dei", "e", "ed", "o", "od", "per", "con", "senza", "a", "in", "da", "su", "tra", "il", "lo", "la", "le", "un", "una", "che"],
  pt: ["de", "do", "da", "dos", "das", "e", "ou", "para", "com", "sem", "em", "no", "na", "por", "sobre", "o", "a", "os", "as", "um", "uma", "que"],
  ru: ["и", "или", "для", "с", "со", "без", "в", "на", "по", "от", "к", "у", "за", "из", "о", "об", "а", "но", "не", "как", "что"],
  uk: ["і", "та", "або", "для", "з", "без", "в", "у", "на", "по", "від", "до", "за", "із", "як", "що", "не"],
  el: ["και", "ή", "για", "με", "χωρίς", "σε", "από", "του", "της", "των", "το", "την", "τη", "τα", "ο", "η", "οι", "στις", "στο", "στην"],
};

// fitMetaLocal's contract signature has no language argument, so the tail cleaner matches
// against every list at once. A false positive needs a cut to land exactly before a word that
// is a service word in ANOTHER language ("…How Slots Die" vs German "die") — rarer than a
// dangling preposition, and only trimmed candidates are cleaned, never kept ones.
const STOP_WORDS_ALL: Set<string> = new Set(Object.values(STOP_WORDS).flat().map(fold));

// Trailing separators left behind by a cut ("Title :" / "Title —" / "Title &").
const TRAILING_SEP_RE = /[\s:|&,–—-]+$/u;

/**
 * Clean the tail of a cut candidate: no dangling separator, no dangling stop-word, nothing
 * empty. Applied repeatedly because stripping a stop-word can expose a separator and vice
 * versa ("… bonus : de" → "… bonus : " → "… bonus"). Never strips below one word.
 */
function cleanTrailing(s: string): string {
  let out = s;
  for (let guard = 0; guard < 12; guard++) {
    out = out.replace(TRAILING_SEP_RE, "").trim();
    // Dangling stop-word as the LAST word (only when more than one word would remain).
    const words = out.split(" ");
    if (words.length > 1 && STOP_WORDS_ALL.has(fold(words[words.length - 1]))) {
      out = words.slice(0, -1).join(" ");
      continue;
    }
    break;
  }
  return out.replace(TRAILING_SEP_RE, "").trim();
}

// ─── deterministic trimming ──────────────────────────────────────────────────────

// Cut order for titles. The LAST occurrence in the string is cut each time — the tail is the
// expendable part, the keyword lives at the head.
const TITLE_SEPARATORS = [" | ", " — ", " – ", " - ", " : ", ": ", ", ", " & "];

/** Last index of any separator (-1 when none). */
function lastSeparatorIndex(s: string): number {
  let best = -1;
  for (const sep of TITLE_SEPARATORS) {
    const i = s.lastIndexOf(sep);
    if (i > best) best = i;
  }
  return best;
}

/** Remove the last parenthesized group "(…)", keeping any text after it. Null when there is none. */
function cutLastParenGroup(s: string): string | null {
  const close = s.lastIndexOf(")");
  if (close === -1) return null;
  const open = s.slice(0, close).lastIndexOf("(");
  if (open <= 0) return null;
  return (s.slice(0, open) + s.slice(close + 1)).replace(/\s{2,}/g, " ");
}

const TERMINATORS = new Set([".", "!", "?", "…", "。", "！", "？"]);
const endsTerminated = (s: string): boolean => TERMINATORS.has(s.slice(-1));

/** Smallest-cut-first ladder for titles: last separator, then parenthesized group. */
function trimTitle(value: string, keyword: string, brand: string | undefined, min: number, max: number): string | null {
  const kw = fold(String(keyword ?? "").trim());
  const hasKeyword = (s: string) => !kw || fold(s).includes(kw);
  let cur = value;

  // The brand drops first: it is the one segment a title can lose without losing meaning.
  const brandRaw = String(brand ?? "").trim();
  if (brandRaw) {
    const fb = fold(brandRaw);
    if (fold(cur).includes(fb)) {
      const without = cur.replace(new RegExp(escapeRegExp(brandRaw), "gi"), "");
      const cleaned = cleanTrailing(without.replace(/\s{2,}/g, " ").replace(/^[\s:|&,–—-]+/u, ""));
      if (cleaned && hasKeyword(cleaned)) {
        const len = metaLength(cleaned);
        if (len >= min && len <= max) return cleaned;
        if (len >= min) cur = cleaned; // still too long — keep cutting from the brand-less base
        // below min already without the brand → the separator ladder below decides
      }
    }
  }

  // Cut the LAST separator, clean the tail, measure. Stop the moment a cut lands in band, or
  // when a cut drops below the band — later cuts are only shorter, so the 76→42 golden case
  // must end unfixable, never with an out-of-band trim.
  for (let guard = 0; guard < 12; guard++) {
    const len = metaLength(cur);
    if (len >= min && len <= max) return cur;
    if (len < min) return null;
    const cut = cutOnce(cur);
    if (cut == null) return null;
    const cleaned = cleanTrailing(cut);
    if (!cleaned || !hasKeyword(cleaned)) return null; // never trim the keyword away
    cur = cleaned;
  }
  return null;
}

function cutOnce(s: string): string | null {
  const sep = lastSeparatorIndex(s);
  if (sep > 0) return s.slice(0, sep);
  return cutLastParenGroup(s);
}

/**
 * Sentence-aware cut for descriptions: drop trailing sentence(s) first, then trailing clause
 * at `, ` / dashes / colon. The survivor must end with a sentence terminator — a description
 * that stops at a comma looks truncated in the SERP, which is the defect this module fixes.
 */
function trimDescription(value: string, min: number, max: number): string | null {
  // Candidate = prefix ending at each sentence terminator, smallest cut first.
  const ends: number[] = [];
  for (const m of value.matchAll(/[.!?…](?=\s|$)/gu)) ends.push(m.index! + m[0].length);
  for (let i = ends.length - 1; i >= 0; i--) {
    const cand = value.slice(0, ends[i]).trim();
    const len = metaLength(cand);
    if (len > max) continue;               // still too long → a smaller cut exists, try it
    if (len < min) return null;            // overshot below the band — smaller cuts only shrink
    return cand;
  }
  // No sentence cut landed in band: clause cuts from the end, shortest removal first, then
  // terminate the survivor with a period so it still reads finished.
  for (const sep of [", ", " — ", " – ", " - ", " : ", ": "]) {
    let idx = value.lastIndexOf(sep);
    while (idx > 0) {
      let cand = cleanTrailing(value.slice(0, idx));
      let len = metaLength(cand);
      if (!endsTerminated(cand) && len + 1 <= max) { cand += "."; len++; }
      if (len >= min && len <= max && endsTerminated(cand)) return cand;
      if (len < min) break;                // cutting more only gets shorter — next separator
      idx = value.slice(0, idx).lastIndexOf(sep);
    }
  }
  return null;
}

/** Word-boundary cut ≤ max (last resort — flagged as a concern, never silently shipped). */
export function forcedCut(value: string, max: number, endWithTerminator: boolean): string {
  const chars = Array.from(value);
  if (chars.length <= max) return cleanTrailing(value);
  const window = chars.slice(0, max + 1).join(""); // +1 so a boundary AT max is found inside
  const lastSpace = window.lastIndexOf(" ");
  let base = cleanTrailing(lastSpace > 0 ? window.slice(0, lastSpace) : chars.slice(0, max).join(""));
  if (endWithTerminator && base && !endsTerminated(base)) {
    if (metaLength(base) + 1 <= max) base += ".";
    else {
      const sp = base.lastIndexOf(" ");
      if (sp > 0) base = cleanTrailing(base.slice(0, sp)) + ".";
    }
  }
  return base || chars.slice(0, max).join("");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── fitMetaLocal ────────────────────────────────────────────────────────────────

/**
 * Pure. Best existing candidate or a deterministic trim; never calls a model.
 *
 * Returns `unfixable` with the ORIGINAL value whenever nothing lands inside the target band —
 * an out-of-band trim is exactly the defect this exists to prevent (the 76→42 golden case).
 */
export function fitMetaLocal(field: MetaField, value: string, options: string[], keyword: string, brand?: string): MetaFitResult {
  const { targetMin, targetMax, auditMin, auditMax } = META_LIMITS[field];
  const raw = String(value ?? "");
  const norm = normalizeMetaValue(raw);
  const result = (after: string, method: MetaFitResult["method"]): MetaFitResult => {
    const len = metaLength(after);
    return {
      field, before: raw, after, length: len, method,
      inBand: len >= targetMin && len <= targetMax,
      auditOk: len >= auditMin && len <= auditMax,
    };
  };

  if (norm && metaLength(norm) >= targetMin && metaLength(norm) <= targetMax) return result(norm, "kept");

  // Another existing option already in band: pick the one where the keyword sits earliest
  // (case/diacritics-insensitive). `pick()` used to take the first non-empty option and the
  // fitting one was often the second or third.
  const kw = fold(String(keyword ?? "").trim());
  const inBand = options
    .map(normalizeMetaValue)
    .filter((o) => o && metaLength(o) >= targetMin && metaLength(o) <= targetMax);
  if (inBand.length) {
    const pos = (s: string): number => {
      if (!kw) return 0;
      const i = fold(s).indexOf(kw);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return result([...inBand].sort((a, b) => pos(a) - pos(b))[0], "picked");
  }

  if (!norm) return result(raw, "unfixable");
  if (metaLength(norm) < targetMin) return result(raw, "unfixable"); // never pad short values with boilerplate

  const trimmed = field === "description"
    ? trimDescription(norm, targetMin, targetMax)
    : trimTitle(norm, keyword, brand, targetMin, targetMax);
  if (trimmed && metaLength(trimmed) >= targetMin && metaLength(trimmed) <= targetMax) {
    return result(trimmed, "trimmed");
  }
  return result(raw, "unfixable");
}

// ─── meta block (head of a generated article) ────────────────────────────────────

const META_LABEL = { title: /^title\s*:/i, description: /^meta\s+description\s*:/i, slug: /^url\s+slug\s*:/i };

/**
 * Parse the ```Title: …\nMeta Description: …\nURL Slug: …``` block at the head of an article
 * (the format `ensureMetaBlock` in generate.ts writes). Case-insensitive, with or without the
 * code fences, values taken verbatim to the end of each line. Null when no block is present.
 */
export function readMetaBlock(text: string): { title: string; description: string; slug: string } | null {
  if (!text) return null;
  const firstHeading = text.search(/^#{1,6}\s/m);
  const head = firstHeading > 0 ? text.slice(0, firstHeading) : (firstHeading === 0 ? "" : text);
  if (!/(^|\n)\s*(```)?\s*title\s*:/i.test(head)) return null;
  const out = { title: "", description: "", slug: "" };
  for (const line of head.split(/\r?\n/)) {
    const bare = line.trim().replace(/^```+/, "").replace(/```+$/, "").trim();
    if (META_LABEL.title.test(bare)) out.title = bare.replace(META_LABEL.title, "").trim();
    else if (META_LABEL.description.test(bare)) out.description = bare.replace(META_LABEL.description, "").trim();
    else if (META_LABEL.slug.test(bare)) out.slug = bare.replace(META_LABEL.slug, "").trim();
  }
  if (!out.title && !out.description && !out.slug) return null;
  return out;
}

const normalizeOneLine = (s: string): string => normalizeMetaValue(s).replace(/\s+/g, " ");

/**
 * Replace Title/Description inside an EXISTING head block (idempotent, keeps the fence style
 * and the slug line as they are). Returns the text unchanged when there is no block — callers
 * that must have one call `ensureMetaBlock` first.
 */
export function writeMetaBlock(text: string, meta: { title?: string; description?: string }): string {
  const block = readMetaBlock(text);
  if (!block) return text;
  const title = meta.title != null ? normalizeOneLine(meta.title) : block.title;
  const description = meta.description != null ? normalizeOneLine(meta.description) : block.description;
  const firstHeading = text.search(/^#{1,6}\s/m);
  const rest = firstHeading >= 0 ? text.slice(firstHeading) : "";
  const hadFence = /^\s*```/.test(text);
  const fence = hadFence ? "```\n" : "";
  const fenceEnd = hadFence ? "\n```" : "";
  const newHead = `${fence}Title: ${title}\nMeta Description: ${description}\nURL Slug: ${block.slug}${fenceEnd}\n\n`;
  const body = rest.replace(/^\s+/, "");
  return body ? newHead + body : newHead.trimEnd();
}

// ─── fitMeta (local first, then ≤2 repair calls) ─────────────────────────────────

/** The repair prompt is Russian, like every other prompt in the pipeline (it is operator-facing). */
function buildRepairPrompt(
  item: MetaFitItem,
  broken: { field: MetaField; value: string }[],
  failureLengths?: Map<MetaField, number[]>,
): string {
  const parts = broken.map(({ field, value }) => {
    const { targetMin, targetMax } = META_LIMITS[field];
    const label = field === "title" ? "Title" : "Meta Description";
    const opts = ((field === "title" ? item.titleOptions : item.descriptionOptions) ?? [])
      .map((o) => normalizeMetaValue(o)).filter(Boolean).slice(0, 5);
    const failed = failureLengths?.get(field);
    return `${label} (цель: строго ${targetMin}–${targetMax} символов; сейчас ${metaLength(value)}):
${value}${opts.length ? `\nДругие варианты из генератора (можно использовать как основу):\n${opts.map((o, i) => `${i + 1}. ${o}`).join("\n")}` : ""}${failed?.length ? `\nТвои предыдущие варианты были длиной ${failed.join(", ")} — все мимо полосы ${targetMin}–${targetMax}. Считай точнее.` : ""}`;
  });
  return `Ты — SEO-редактор. Значения мета-тегов ниже не попадают в лимит длины. Перепиши их короче (или длиннее, если указано, что короче полосы), чтобы длина КАЖДОГО варианта строго лежала в заданных границах. Считай символы точно — это главное требование; длина считается по Unicode-кодпоинтам.

Язык мета-тегов: ${item.language}. Не меняй язык и смысл; не выдумывай цифры, названия и факты, которых нет в исходном значении; главный ключ держи как можно ближе к началу Title; не добавляй слов-заполнителей.

Главный ключ страницы: ${item.keyword}

${parts.join("\n\n")}

Верни по 5 РАЗНЫХ вариантов на каждое поле — СТРОГИЙ JSON без обёрток и пояснений:
{ "title": ["…", "…", "…", "…", "…"], "description": ["…", "…", "…", "…", "…"] }
Если в задании только одно поле — второе верни как 5 копий исходного значения.`;
}

/**
 * Local first, then up to 2 repair calls when `llm.allow`. Everything the model returns is
 * validated BY CODE — the first variant whose measured length lands in the band wins; there is
 * no path by which an out-of-band string from the model reaches the article.
 */
export async function fitMeta(item: MetaFitItem, llm: { allow: boolean; provider?: string; apiKey?: string; model?: string; baseUrl?: string }): Promise<MetaFitResponse> {
  const out: MetaFitResponse = { llmCalls: 0 };
  if (item.id != null) out.id = String(item.id);

  const present = (value: string | undefined, options: string[] | undefined): boolean =>
    normalizeMetaValue(value) !== "" || (options ?? []).some((o) => normalizeMetaValue(o) !== "");
  const fields: MetaField[] = [];
  if (present(item.title, item.titleOptions)) fields.push("title");
  if (present(item.description, item.descriptionOptions)) fields.push("description");
  if (!fields.length) return out;

  for (const field of fields) {
    out[field] = fitMetaLocal(
      field,
      field === "title" ? String(item.title ?? "") : String(item.description ?? ""),
      (field === "title" ? item.titleOptions : item.descriptionOptions) ?? [],
      String(item.keyword ?? ""),
      item.brand,
    );
  }
  if (fields.every((f) => (out[f] as MetaFitResult).inBand) || !llm.allow || !llm.apiKey) return out;

  // ── repair calls: ONE call carries both fields; a second only when the first missed, with
  //    the rejected lengths named so the model can count better. Hard cap: 2 calls.
  const priorAttempts = new Map<MetaField, number[]>();
  const { fetchLLM } = await import("@/lib/llm");
  for (let call = 0; call < 2; call++) {
    const brokenNow = fields.filter((f) => !(out[f] as MetaFitResult).inBand);
    if (!brokenNow.length) break;
    const prompt = buildRepairPrompt(
      {
        ...item,
        title: normalizeMetaValue(item.title ?? ""),
        description: normalizeMetaValue(item.description ?? ""),
      },
      brokenNow.map((f) => ({ field: f, value: normalizeMetaValue((out[f] as MetaFitResult).after) })),
      call === 0 ? undefined : priorAttempts,
    );
    let raw: string | null = null;
    try {
      raw = await fetchLLM(prompt, String(llm.provider || "anthropic"), String(llm.apiKey), 1200, llm.model, llm.baseUrl, 0);
    } catch { break; }
    out.llmCalls++;
    const parsed = extractJson<Record<string, unknown>>(raw);
    if (!parsed) break;
    for (const field of brokenNow) {
      const variants = (Array.isArray(parsed[field]) ? parsed[field] as unknown[] : []).map((v) => normalizeMetaValue(v));
      priorAttempts.set(field, variants.map((v) => metaLength(v)).filter((n) => n > 0).slice(0, 5));
      const { targetMin, targetMax, auditMin, auditMax } = META_LIMITS[field];
      const hit = variants.find((v) => v && metaLength(v) >= targetMin && metaLength(v) <= targetMax);
      if (hit) {
        const len = metaLength(hit);
        out[field] = {
          field, before: (out[field] as MetaFitResult).before, after: hit, length: len, method: "llm",
          inBand: true, auditOk: len >= auditMin && len <= auditMax,
        };
      }
    }
  }

  // ── last resort, ONLY on the paid path: a forced word-boundary cut for values still over
  //    the ceiling (callers report it as a concern). Without llm.allow the honest answer is
  //    `unfixable` — the deterministic options are exhausted, and cutting without a repair
  //    attempt first would ship an awkward title the free path was never authorised to make.
  //    Too-SHORT values stay unfixable either way — padding with boilerplate is worse than a
  //    short description.
  if (llm.allow) {
    for (const field of fields) {
      const cur = out[field] as MetaFitResult;
      if (cur.inBand) continue;
      const base = normalizeMetaValue(cur.after);
      if (metaLength(base) > META_LIMITS[field].targetMax) {
        const cut = forcedCut(base, META_LIMITS[field].targetMax, field === "description");
        const len = metaLength(cut);
        out[field] = {
          field, before: cur.before, after: cut, length: len, method: "forced_cut",
          inBand: len >= META_LIMITS[field].targetMin && len <= META_LIMITS[field].targetMax,
          auditOk: len >= META_LIMITS[field].auditMin && len <= META_LIMITS[field].auditMax,
        };
      } else {
        out[field] = { ...cur, method: "unfixable" };
      }
    }
  }
  return out;
}
