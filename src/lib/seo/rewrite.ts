// Content Rewriter — rewrites an article (pasted text OR a URL) into N unique variants using
// the user's own multi-provider AI (Anthropic / OpenAI / Kimi / …, via fetchLLM). For each
// variant it can mask common "AI tells" and reports a uniqueness score vs the source. Built to
// refresh decaying pages and avoid duplicate content across a large affiliate network.

import { fetchLLM } from "@/lib/llm";
import { scrapeMany } from "@/lib/seo/scrape";
import { factDrift, criticalValues, type FactDrift } from "@/lib/seo/factDrift";
import { uniquenessPct, wordCount, keywordCoverage, type KeywordCoverage } from "@/lib/seo/textMetrics";
import { renderPolicy, type EditorialPolicy } from "@/lib/seo/policy";

export interface RewriteBody {
  text?: string;
  url?: string;
  variants?: number;
  language?: string;        // target language NAME (e.g. "Greek"); empty = keep source language
  tone?: string;            // optional tone hint
  maskAI?: boolean;         // strip common AI patterns (default true)
  bannedWords?: string[];   // domain vocabulary to avoid AT GENERATION TIME (see note below)
  /**
   * The queries this page is meant to rank for, with volumes where known.
   *
   * The tool had none of this. Rewriting a decaying page without knowing what it ranks for is how
   * a refresh loses the phrase that was earning the traffic: the meaning survives, the exact query
   * does not, and nothing in the pipeline notices because the facts all check out. Supplying them
   * turns that from an accident into a checked constraint — see `keywordCoverage` below.
   */
  targetKeywords?: { keyword: string; volume?: number | null; globalVolume?: number | null }[];
  /**
   * The editorial policy to write under. Rewrite was the one generator that ignored it entirely —
   * outline, text and analysis all render it, this did not — while `start_rewrite_job` advertised
   * "editorial policy ... applied" in its own description. Half of that promise was false.
   */
  policy?: EditorialPolicy;
  temperature?: number;     // sampling temperature; undefined = provider default
  autoRepair?: boolean;     // run a scoped fix pass when the value audit fails (default true)
  snippet?: boolean;        // also propose a refreshed title + meta description
  aiProvider?: string;
  aiApiKey?: string;
  model?: string;
  aiBaseUrl?: string;
  firecrawlKey?: string;
}

// `drift` is computed here rather than in the browser because in URL mode the source text only
// exists on the server — the client never sees what was scraped, so it could not check it.
export interface RewriteVariant {
  content: string; uniqueness: number; words: number; drift: FactDrift;
  /** heading counts per level, source vs output — the outline equivalent of the value check */
  structure?: StructureCheck;
  /** a scoped repair pass ran and measurably reduced the defect count */
  repaired?: boolean;
  /**
   * Which target queries the rewrite kept. Absent when the caller supplied no targets — an empty
   * report and "nothing to check" are different states and must not render the same.
   */
  coverage?: KeywordCoverage;
}

/** Refreshed search snippet alongside the current one, so the change is judged by comparison. */
export interface SnippetSuggestion {
  sourceTitle: string;
  sourceDescription: string;
  title: string;
  description: string;
}

export interface RewriteResult {
  ok: boolean;
  error?: string;
  data?: {
    sourceChars: number; sourceWords: number; title?: string;
    variants: RewriteVariant[];
    snippet?: SnippetSuggestion;
    /**
     * The exact source the variants were built from.
     *
     * Returned so the result editor can recompute uniqueness and value drift live while the user
     * edits. Without it a hand-edited draft would keep displaying the scores of the draft it
     * replaced — numbers that describe text no longer on screen are worse than no numbers.
     */
    source: string;
  };
}

// ─── AI-pattern masking ─────────────────────────────────────────────────────────
// Scope note, so nobody mistakes this for an anti-detection measure: substituting phrases in a
// FINISHED text does not move a statistical detector — those score the whole token distribution of
// a ~300-word window, and swapping a dozen connectives barely dents it. What this pass genuinely
// buys is readability: it strips the tics that make a draft feel machine-written to a human editor.
// The same vocabulary is far more effective supplied as `bannedWords` at generation time.
const PHRASE_MAP: [RegExp, string][] = [
  [/\bmoreover\b/gi, "also"],
  [/\bfurthermore\b/gi, "plus"],
  [/\badditionally\b/gi, "also"],
  [/\bin addition\b/gi, "also"],
  [/\bit is important to note that\b/gi, "note that"],
  [/\bit is worth noting that\b/gi, "note that"],
  [/\bit's worth noting that\b/gi, "note that"],
  [/\bit should be noted that\b/gi, "note that"],
  [/\bin conclusion,?\s*/gi, ""],
  [/\bin summary,?\s*/gi, ""],
  [/\bto sum up,?\s*/gi, ""],
  [/\bfirstly\b/gi, "first"],
  [/\bsecondly\b/gi, "second"],
  [/\bthirdly\b/gi, "third"],
  [/\bin today's (digital )?(age|world|landscape)\b/gi, "today"],
  [/\bwhen it comes to\b/gi, "for"],
  [/\bplays? a (crucial|vital|key|significant) role\b/gi, "matters"],
  [/\ba testament to\b/gi, "a sign of"],
  [/\bdelve into\b/gi, "look at"],
  [/\bnavigating\b/gi, "handling"],
];

export function maskAIPatterns(input: string): string {
  let out = input;
  // Em/en dashes → plain hyphen (a very common AI tell)
  out = out.replace(/\s*[—–]\s*/g, " - ");
  // Unicode bullets → simple markers (keep markdown "- " lists intact)
  out = out.replace(/^[•‣◦⁃∙]\s*/gm, "- ");
  out = out.replace(/[•‣◦⁃∙]/g, "-");
  for (const [re, rep] of PHRASE_MAP) out = out.replace(re, rep);
  // Capitalize a sentence start we may have emptied ("In conclusion, X" → "X")
  out = out.replace(/(^|[.!?]\s+)([a-z])/g, (_m, p, c) => p + c.toUpperCase());
  out = out.replace(/[ \t]{2,}/g, " ");
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const worker = async () => { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ─── Currency notation ──────────────────────────────────────────────────────────
// Asking the model to keep the source's notation does not work — a real run converted every "€30"
// into "30 EUR" despite an explicit instruction. That is fine by the value checker (both normalize
// to the same price) but it leaves a Greek page written in a notation its audience does not use.
// Mechanical transformations belong in code, not in a prompt: this one is deterministic, so it is
// applied deterministically instead of being requested and hoped for.
const CURRENCY_PAIRS: [string, string][] = [["€", "EUR"], ["$", "USD"], ["£", "GBP"], ["₽", "RUB"], ["₴", "UAH"]];

function normalizeCurrency(source: string, out: string): string {
  let result = out;
  for (const [sym, code] of CURRENCY_PAIRS) {
    const symBefore = new RegExp(`\\${sym}\\s?\\d`).test(source);
    const symAfter = new RegExp(`\\d\\s?\\${sym}`).test(source);
    if (!symBefore && !symAfter) continue;              // source doesn't use the symbol — leave it
    if (new RegExp(`\\b${code}\\b`).test(source)) continue; // source mixes both — not ours to decide
    const num = "(\\d[\\d.,\\s\\u00A0]*\\d|\\d)";
    result = result
      .replace(new RegExp(`${num}\\s*\\b${code}\\b`, "g"), (_m, n) => (symBefore ? `${sym}${n}` : `${n}${sym}`))
      .replace(new RegExp(`\\b${code}\\b\\s*${num}`, "g"), (_m, n) => (symBefore ? `${sym}${n}` : `${n}${sym}`));
  }
  return result;
}

// ─── Heading structure ──────────────────────────────────────────────────────────
// The value checker guards facts; nothing guarded the outline until now. A run quietly came back
// with seven H3s where the source had eight — invisible in the output, but it changes what the page
// covers, and on a page being refreshed to recover rankings that is the wrong kind of surprise.
export function headingCounts(md: string): number[] {
  const c = [0, 0, 0, 0, 0, 0];
  for (const m of md.matchAll(/^(#{1,6})\s+\S/gm)) c[m[1].length - 1]++;
  return c;
}

export interface StructureCheck { expected: number[]; got: number[]; ok: boolean }

function checkStructure(source: string, out: string): StructureCheck {
  const expected = headingCounts(source);
  const got = headingCounts(out);
  return { expected, got, ok: expected.every((n, i) => n === got[i]) };
}

// Pasted text and scraped pages get different budgets. A full landing page runs well past 14k
// characters, and truncating it there silently dropped everything below the fold — the rewrite came
// back "complete" while covering only the top third of the page.
const MAX_CHARS = 14_000;
const MAX_CHARS_URL = 40_000;

// Search-result truncation points. Shared with the UI counters so one number governs both.
export const SNIPPET_TITLE_MAX = 60;
export const SNIPPET_DESC_MAX = 160;

export async function rewriteContent(b: RewriteBody): Promise<RewriteResult> {
  const provider = String(b.aiProvider ?? "anthropic");
  const apiKey = String(b.aiApiKey ?? "");
  if (!apiKey) return { ok: false, error: "no_ai_key" };

  // Resolve source content: pasted text, or scrape the URL.
  let text = (b.text ?? "").trim();
  let title = "";
  let description = "";
  let fromUrl = false;
  if (!text && b.url) {
    fromUrl = true;
    try {
      const pages = await scrapeMany([b.url], b.firecrawlKey || undefined, 1);
      const p = pages[0];
      if (p) {
        // Refuse a page that yielded navigation instead of an article. Rewriting a menu produces
        // fluent, confident, worthless output — a failure that reads as success, which is exactly
        // the kind a tool must not hand back to the user.
        if (p.ok && p.boilerplateOnly) return { ok: false, error: "boilerplate_only" };
        // Markdown, not the flat sample: headings and tables are structure the rewrite must keep.
        text = String(p.contentMarkdown || p.textSample || "").trim();
        title = p.title || "";
        description = p.metaDescription || "";
      }
    } catch { /* fall through to no_content */ }
  }
  if (!text) return { ok: false, error: "no_content" };
  const cap = fromUrl ? MAX_CHARS_URL : MAX_CHARS;
  const truncated = text.length > cap;
  const source = truncated ? text.slice(0, cap) : text;

  const variants = Math.min(5, Math.max(1, Number(b.variants) || 1));
  const langName = (b.language || "").trim();
  const langLine = langName ? `Write the rewrite in ${langName}.` : `Write in the SAME language as the source.`;
  // Omitted when a policy exists, because renderPolicy already carries the tone as its override.
  const toneLine = b.tone && !b.policy ? `Tone: ${b.tone}.` : "";

  // Vocabulary constraint, when the caller supplies one from the local fingerprint model.
  // A CONCRETE list is the point: it removes specific high-signal tokens without telling the model
  // anything about how to write. Vague style directives ("write naturally", "vary your sentence
  // length", "sound human") do the opposite of what they promise — the model applies them as
  // explicit rules, which narrows its output distribution and makes the text MORE machine-typical,
  // not less. That is why no such instruction appears in this prompt.
  const banned = (b.bannedWords || []).map(w => String(w).trim()).filter(Boolean).slice(0, 80);
  const bannedLine = banned.length
    ? `Do not use these words or their inflected forms anywhere in the output: ${banned.join(", ")}. Express the same ideas with different wording. `
    : "";

  // Scraped pages arrive as Markdown with the heading tree intact, and that tree is the page's SEO
  // skeleton — dropping or merging headings silently changes what the page ranks for. Spelled out
  // explicitly because a model handed a long document will otherwise "tidy" the structure.
  const structureLine = /^#{1,6}\s/m.test(source)
    ? `Preserve the heading structure EXACTLY: same number of headings, same levels (# / ## / ###), same order. Rewrite heading text, never drop, merge, split or reorder a heading. If the source starts with an H1, your output must start with an H1 too. Keep every markdown table with all its rows. `
    : "";

  // Currency notation is a house style, not a fact. The value checker treats "€30" and "30 EUR" as
  // the same price, so a swap passes the audit — but a Greek page that suddenly mixes both reads as
  // sloppy, and nothing else in the pipeline would catch it.
  const currencyLine = /[€$£₽₴]/.test(source)
    ? `Keep currency notation exactly as the source writes it (symbol stays a symbol, code stays a code) — do not convert € into EUR or back. `
    : "";

  // Named, explicit list of every checkable value in the source. Telling a model to "preserve all
  // facts" is the kind of vague directive it acknowledges and then quietly violates on paragraph
  // forty; an enumerated list of the actual prices, durations and brand names is something it can
  // check itself against. This is prevention — the drift panel afterwards is only the audit.
  const mustKeep = criticalValues(source);
  const keepLine = mustKeep.length
    ? `These exact values MUST all appear in your output — every price, duration, percentage, phone number and brand name: ${mustKeep.join(", ")}. Do not drop, round, convert or re-unit any of them, and do not introduce values that are not in the source. `
    : "";

  // The queries the page is supposed to keep. Ordered by volume so the model knows which ones are
  // worth an exact match when a phrasing has to give: a rewrite that loses the top query has
  // failed even if every fact survived.
  const targets = (b.targetKeywords || [])
    .map(k => ({ keyword: String(k.keyword || "").trim(), volume: k.volume ?? null, globalVolume: k.globalVolume ?? null }))
    .filter(k => k.keyword)
    // Sort by the bigger of local/global — a phrase with zero local demand but worldwide demand is
    // still worth keeping, and ordering by local-only would bury it.
    .sort((a, z) => Math.max(z.volume ?? 0, z.globalVolume ?? 0) - Math.max(a.volume ?? 0, a.globalVolume ?? 0))
    .slice(0, 30);
  const targetLine = targets.length
    ? `This page ranks for these searches and must keep ranking for them — preserve each phrase verbatim at least once, in natural context, and do not paraphrase them away: ${targets.map(k => {
        const local = k.volume ? `${k.volume}/mo` : "0";
        const global = k.globalVolume ? `, global ${k.globalVolume}/mo` : "";
        return `"${k.keyword}" (${local}${global})`;
      }).join(", ")}. `
    : "";

  // Same block the outline and text steps render, in the same position — leading the prompt, so
  // brand, audience, voice and the words-to-avoid list frame everything that follows. The tone
  // argument is folded in as the override, exactly as buildTextPrompt does it, which is why
  // `toneLine` below stays empty when a policy is present: one source of tone, never two.
  const policyBlock = b.policy ? renderPolicy(b.policy, b.tone) + "\n\n" : "";

  const basePrompt = (i: number) =>
    policyBlock +
    `You are an expert SEO copywriter. Rewrite the content below so it is UNIQUE and original, ` +
    `while preserving the exact meaning, all facts, numbers, named entities, and links. ` +
    `Keep the same format as the input (HTML stays HTML, Markdown stays Markdown, plain stays plain). ` +
    `${structureLine}${currencyLine}${keepLine}${targetLine}${langLine} ${toneLine} ${bannedLine}` +
    (variants > 1 ? `This is variant #${i + 1} — make it clearly different from the other variants. ` : "") +
    `Output ONLY the rewritten content, with no preamble, notes, or explanations.\n\n` +
    `CONTENT:\n${source}`;

  // Targeted second pass, run only when the audit finds something wrong. It names the specific
  // values to restore or remove instead of asking for a whole re-rewrite, so the text that was
  // already correct is left alone.
  const repairPrompt = (draft: string, lost: string[], added: string[], st: StructureCheck) => {
    const levels = st.ok ? "" : st.expected
      .map((n, i) => (n === st.got[i] ? "" : `H${i + 1}: ${st.got[i]} present, ${n} required`))
      .filter(Boolean).join("; ");
    return `The text below is a rewrite of a source document. It has these defects:\n` +
      (lost.length ? `- MISSING values that were in the source and must be restored, in their proper context: ${lost.join(", ")}\n` : "") +
      (added.length ? `- INVENTED values that are NOT in the source and must be removed or corrected: ${added.join(", ")}\n` : "") +
      (levels ? `- WRONG heading count — restore the missing sections with real content, do not add empty headings (${levels})\n` : "") +
      `Fix ONLY these defects. Do not rewrite anything else, do not alter wording that is already correct. ` +
      `Output ONLY the corrected text, with no preamble or notes.\n\nTEXT:\n${draft}`;
  };

  const clean = (s: string) => s.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();

  const results = await pool(Array.from({ length: variants }), 2, async (_x, i): Promise<RewriteVariant | null> => {
    const raw = await fetchLLM(basePrompt(i), provider, apiKey, 8000, b.model || undefined, b.aiBaseUrl || undefined, b.temperature);
    let content = clean(raw ?? "");
    if (!content) return null;
    content = normalizeCurrency(source, content);

    // Audit, then repair once if needed. A single scoped pass is deliberate: repeated correction
    // rounds drift away from the source in other ways, and the repair is only kept when it actually
    // improves the total defect count — a "fix" that loses more than it restores is discarded.
    let drift = factDrift(source, content);
    let structure = checkStructure(source, content);
    let repaired = false;
    // Heading loss counts as a defect too, so a structurally-damaged draft triggers the same pass.
    const defects = (d: FactDrift, s: StructureCheck) =>
      d.numbers.lost.length + d.identifiers.lost.length + d.numbers.added.length + d.identifiers.added.length +
      s.expected.reduce((acc, n, i) => acc + Math.abs(n - s.got[i]), 0);

    if (b.autoRepair !== false && (!drift.clean || !structure.ok)) {
      const lost = [...drift.numbers.lost, ...drift.identifiers.lost].slice(0, 40);
      const added = [...drift.numbers.added, ...drift.identifiers.added].slice(0, 40);
      try {
        const fixRaw = await fetchLLM(repairPrompt(content, lost, added, structure), provider, apiKey, 8000, b.model || undefined, b.aiBaseUrl || undefined, b.temperature);
        const fixed = normalizeCurrency(source, clean(fixRaw ?? ""));
        if (fixed) {
          const d2 = factDrift(source, fixed);
          const s2 = checkStructure(source, fixed);
          if (defects(d2, s2) < defects(drift, structure)) {
            content = fixed; drift = d2; structure = s2; repaired = true;
          }
        }
      } catch { /* keep the audited original */ }
    }

    if (b.maskAI !== false) content = maskAIPatterns(content);
    // Computed after masking, because masking rewrites phrasing and could itself drop a target
    // phrase. Measuring before it would report a coverage the shipped text does not have.
    const coverage = targets.length ? keywordCoverage(source, content, targets) : undefined;
    return { content, uniqueness: uniquenessPct(source, content), words: wordCount(content), drift, structure, repaired, coverage };
  });

  const variantsOut = results.filter((r): r is RewriteVariant => !!r);
  if (!variantsOut.length) return { ok: false, error: "generation_failed" };

  // Snippet refresh. Requested explicitly (`snippet: true`) so an existing caller's cost and
  // latency don't change, and only meaningful when the source page actually has meta tags.
  let snippet: SnippetSuggestion | undefined;
  if (b.snippet && (title || description)) {
    try {
      const sPrompt =
        `You are an SEO specialist. Rewrite this page's search snippet so it reads freshly and earns clicks, ` +
        `keeping the same search intent, the same primary keyword and every factual claim (prices, guarantees, coverage). ` +
        `${langLine} Title: 50-${SNIPPET_TITLE_MAX} characters, counted exactly. ` +
        `Meta description: 150-${SNIPPET_DESC_MAX} characters, counted exactly — never exceed ${SNIPPET_DESC_MAX}. ` +
        `Do not invent facts that are absent from the current snippet or the page. ` +
        `Return STRICT JSON and nothing else: {"title":"...","description":"..."}\n\n` +
        `CURRENT TITLE: ${title || "(none)"}\nCURRENT DESCRIPTION: ${description || "(none)"}\n\n` +
        `PAGE CONTENT (for context, first 3000 chars):\n${source.slice(0, 3000)}`;
      const sRaw = await fetchLLM(sPrompt, provider, apiKey, 700, b.model || undefined, b.aiBaseUrl || undefined, b.temperature);
      const parse = (raw: string) => JSON.parse(clean(raw).replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
      let j = parse(sRaw ?? "");

      // Length limits are the whole point of a snippet — an over-long description is truncated by
      // the search engine mid-sentence, so "close enough" is not close enough. Models overshoot
      // routinely (the first real run came back at 172 characters against a 160 limit), so the
      // result is measured and, when it misses, sent back once with the exact overage named.
      const over = (s: string, max: number) => String(s || "").length > max;
      if (over(j?.title, SNIPPET_TITLE_MAX) || over(j?.description, SNIPPET_DESC_MAX)) {
        const fixes = [
          over(j?.title, SNIPPET_TITLE_MAX) ? `the title is ${String(j.title).length} characters and must be at most ${SNIPPET_TITLE_MAX}` : "",
          over(j?.description, SNIPPET_DESC_MAX) ? `the description is ${String(j.description).length} characters and must be at most ${SNIPPET_DESC_MAX}` : "",
        ].filter(Boolean).join("; ");
        const tighten =
          `Shorten this search snippet: ${fixes}. Count characters exactly. Keep the primary keyword, ` +
          `the price and the call to action; cut adjectives and filler first. ${langLine} ` +
          `Return STRICT JSON and nothing else: {"title":"...","description":"..."}\n\n${JSON.stringify(j)}`;
        try {
          const t2 = parse((await fetchLLM(tighten, provider, apiKey, 500, b.model || undefined, b.aiBaseUrl || undefined, b.temperature)) ?? "");
          // Only accept the retry if it is genuinely shorter and did not come back empty.
          if (t2?.title && t2?.description &&
              String(t2.title).length <= String(j.title || "").length &&
              String(t2.description).length <= String(j.description || "").length) j = t2;
        } catch { /* keep the first attempt; the UI flags the overage in red */ }
      }

      if (j?.title || j?.description) {
        snippet = {
          sourceTitle: title, sourceDescription: description,
          title: String(j.title || ""), description: String(j.description || ""),
        };
      }
    } catch { /* snippet is a bonus — never fail the rewrite over it */ }
  }

  return {
    ok: true,
    data: {
      sourceChars: source.length, sourceWords: wordCount(source),
      title: title || undefined, variants: variantsOut, snippet, source,
    },
  };
}
