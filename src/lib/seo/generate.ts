// Core SEO generation logic, factored out of the API routes so it can be reused by both
// the synchronous routes and the background-job runner. No HTTP / auth here — pure work.

import { fetchLLM, fetchLLMDetailed } from "@/lib/llm";
import { runSerp, heuristicIntent, heuristicSiteType } from "@/lib/seo/serp";
import { enrichKeywords, type KwSource } from "@/lib/seo/keywordSource";
import { scrapeMany } from "@/lib/seo/scrape";
import {
  buildOutlinePrompt, buildTextPrompt, buildAnalysisPrompt, buildFactScrubPrompt, buildSourceExtractPrompt,
  buildAutoFactCleanPrompt, buildWireframePrompt, buildSectionEnrichPrompt, buildStructureExpandPrompt,
  buildHeadingLocalizePrompt, buildTextExpandPrompt, buildTextTrimPrompt, buildSectionTextPrompt,
  buildFaqBackfillPrompt,
  enforceLinkPolicy, redactBannedWords, extractJson, extractJsonDetailed, CompetitorInput,
} from "@/lib/seo/prompts";
import { findRagFacts } from "@/lib/seo/rag";
import { decodeHtmlEntities } from "@/lib/seo/outlineFormat";

// Language-agnostic "this heading is a FAQ section" test — templates carry "H2: FAQ" and the
// localization pass renames it («FAQ : Tout savoir…», «Часто задаваемые вопросы»…).
const FAQ_LIKE_RE = /(^|[\s:—-])faq\b|questions?\s+fr[ée]quentes|frequently\s+asked|часто\s+задаваем|поширені\s+питання|вопросы\s+и\s+ответы/i;

// Apply fn to every string value IN PLACE (existing references like `meta` stay valid).
function deepMapStringsInPlace(obj: any, fn: (s: string) => string): void {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => { if (typeof v === "string") obj[i] = fn(v); else deepMapStringsInPlace(v, fn); });
    return;
  }
  if (obj && typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "string") obj[k] = fn(v);
      else deepMapStringsInPlace(v, fn);
    }
  }
}

export type GenResult = { ok: true; data: any } | { ok: false; error: string };

// Run async tasks with bounded concurrency (avoid hammering the provider with 20 parallel calls).
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

// Render a compact per-source facts object (from the map stage) into a short text block.
function renderExtract(j: any): string {
  const lines: string[] = [];
  if (j?.specs && typeof j.specs === "object" && !Array.isArray(j.specs)) {
    const s = Object.entries(j.specs).map(([k, v]) => `${k}=${v}`).join("; ");
    if (s) lines.push(`Спеки: ${s}`);
  }
  if (Array.isArray(j?.prices) && j.prices.length) lines.push(`Цены: ${j.prices.slice(0, 10).join("; ")}`);
  if (Array.isArray(j?.key_facts) && j.key_facts.length) lines.push(`Факты: ${j.key_facts.slice(0, 12).join("; ")}`);
  if (Array.isArray(j?.entities) && j.entities.length) lines.push(`Сущности: ${j.entities.slice(0, 12).join(", ")}`);
  if (Array.isArray(j?.headings_covered) && j.headings_covered.length) lines.push(`Темы: ${j.headings_covered.slice(0, 12).join("; ")}`);
  return lines.join("\n").slice(0, 1600);
}

// MAP stage: extract compact facts from each source separately (small, reliable, parallel calls),
// so the REDUCE stage (outline) builds from clean per-source facts instead of raw 20-page HTML.
async function mapExtractFacts(competitors: CompetitorInput[], keyword: string, country: string, provider: string, apiKey: string, model?: string, baseUrl?: string): Promise<void> {
  const targets = competitors.filter((c) => c.text_sample && String(c.text_sample).trim().length > 80).slice(0, 12);
  await runPool(targets, 2, async (c) => { // low concurrency — parallel bursts trip provider TPM limits (429)
    try {
      const raw = await fetchLLM(buildSourceExtractPrompt({ url: c.url, title: c.title || c.url, text: String(c.text_sample), keyword, country }), provider, apiKey, 1200, model, baseUrl);
      const j = extractJson(raw);
      const rendered = j ? renderExtract(j) : "";
      if (rendered) c.extracted = rendered;
    } catch { /* per-source extraction is best-effort */ }
  });
}

// Apply find→replace corrections over an object's STRING VALUES only (keys/structure untouched).
// Safe against JSON corruption because we never touch keys and rebuild the object in place.
function applyCorrections(obj: any, corrections: { find: string; replace: string }[]): any {
  if (typeof obj === "string") {
    let s = obj;
    for (const c of corrections) if (c.find) s = s.split(c.find).join(c.replace);
    return s;
  }
  if (Array.isArray(obj)) return obj.map((x) => applyCorrections(x, corrections));
  if (obj && typeof obj === "object") {
    const o: any = {};
    for (const k of Object.keys(obj)) o[k] = applyCorrections(obj[k], corrections);
    return o;
  }
  return obj;
}

// ─── Volume guard: make per-section word budgets actually sum to the target ──────
// Models sometimes copy the schema's example numbers into every section (e.g. [130,160]),
// so a 2500-word plan silently becomes ~1000 words of budgets — and the text step then
// honors those small budgets. Deterministic fix: if the sum of section budgets is far
// off the target, scale every section's word_count proportionally.
function toWcRange(v: any): [number, number] | null {
  if (Array.isArray(v) && v.length >= 2 && isFinite(+v[0]) && isFinite(+v[1]) && +v[1] > 0) return [+v[0], +v[1]];
  if (typeof v === "number" && isFinite(v) && v > 0) return [v, v];
  if (typeof v === "string") {
    const m = v.match(/\d+/g);
    if (m?.length) { const a = +m[0], b = +(m[1] ?? m[0]); if (b > 0) return [a, b]; }
  }
  return null;
}
// Each section's OWN contribution to the article: childless section → total; parent →
// self (its intro paragraphs) since a parent's total conventionally includes subsections.
function ownRanges(secs: any[]): ([number, number] | null)[] {
  const depth = (s: any) => (s?.h_level === "H4" ? 4 : s?.h_level === "H3" ? 3 : 2);
  const hasKids = (i: number) => i + 1 < secs.length && depth(secs[i + 1]) > depth(secs[i]);
  return secs.map((s: any, i: number) => {
    const total = toWcRange(s?.word_count_total);
    const self = toWcRange(s?.word_count_self);
    return hasKids(i) ? (self || (total ? [Math.round(total[0] * 0.3), Math.round(total[1] * 0.3)] as [number, number] : null)) : (total || self);
  });
}

// Sum of the outline's own per-section budgets — the volume the outline would really produce.
export function ownBudgetSum(outline: any): number {
  const secs: any[] = Array.isArray(outline?.sections) ? outline.sections : [];
  if (!secs.length) return 0;
  return Math.round(ownRanges(secs).reduce((acc, r) => acc + (r ? (r[0] + r[1]) / 2 : 0), 0));
}

export function normalizeWordBudgets(outline: any, target: number): boolean {
  if (!target || !Array.isArray(outline?.sections) || !outline.sections.length) return false;
  const secs: any[] = outline.sections;
  const depth = (s: any) => (s?.h_level === "H4" ? 4 : s?.h_level === "H3" ? 3 : 2);
  const hasKids = (i: number) => i + 1 < secs.length && depth(secs[i + 1]) > depth(secs[i]);
  const own = ownRanges(secs);
  const sum = own.reduce((acc: number, r: [number, number] | null) => acc + (r ? (r[0] + r[1]) / 2 : 0), 0);
  if (!sum) return false;
  const k = target / sum;
  if (k > 0.98 && k < 1.02) return false; // close enough
  // Scale every section's OWN budget…
  for (let i = 0; i < secs.length; i++) {
    const r = own[i]; if (!secs[i] || !r) continue;
    const scaled: [number, number] = [Math.round(r[0] * k), Math.round(r[1] * k)];
    secs[i].word_count_self = scaled;
    if (!hasKids(i)) secs[i].word_count_total = scaled;
  }
  // …then rebuild parents' totals as self + descendants' totals (bottom-up).
  for (let i = secs.length - 1; i >= 0; i--) {
    if (!hasKids(i)) continue;
    const self = toWcRange(secs[i].word_count_self) || [0, 0];
    let lo = self[0], hi = self[1];
    for (let j = i + 1; j < secs.length && depth(secs[j]) > depth(secs[i]); j++) {
      if (depth(secs[j]) === depth(secs[i]) + 1) {
        const t = toWcRange(secs[j].word_count_total);
        if (t) { lo += t[0]; hi += t[1]; }
      }
    }
    secs[i].word_count_total = [lo, hi];
  }
  return true;
}

// How many sections a word target calls for (~100 words each): more than that and every section
// becomes a 70-word stub, fewer and each one swells into walls of text the copywriter can only
// answer with 400-word blocks. Shared by the expansion pass and genOutline's completeness check
// so the two cannot disagree about what "enough structure" means.
export function targetSectionCount(targetWc?: number): number {
  return targetWc && targetWc >= 500
    ? Math.max(10, Math.min(34, Math.round(targetWc / 100)))
    : 26;
}

// Sub-intent labels ("H2 Τιμές Καθαρισμού…", "H3 Guarantees") that no heading in the outline
// covers. The model plans its sub-intents BEFORE it writes the sections, so when the response is
// cut short this list is the record of what the outline was supposed to contain — the cheapest
// possible brief for rebuilding the missing part.
function uncoveredSubIntents(outline: any, sections: any[]): string[] {
  const subs: any[] = Array.isArray(outline?.sub_intents) ? outline.sub_intents : [];
  if (!subs.length) return [];
  const norm = (s: string) => String(s || "").replace(/^\s*H[1-4]\s*[:.\-—]?\s*/i, "").replace(/\s+/g, " ").trim().toLowerCase();
  const have = sections.map((s: any) => norm(s?.heading));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const si of subs) {
    const label = norm(si?.section) || norm(si?.intent);
    if (!label || seen.has(label)) continue;
    // "Covered" is deliberately loose — the heading rarely matches the sub-intent label word for
    // word, so a containment test either way is what tells a rephrasing apart from an absence.
    if (have.some(h => h && (h.includes(label) || label.includes(h)))) continue;
    seen.add(label);
    out.push(String(si?.section || si?.intent).replace(/^\s*H[1-4]\s*[:.\-—]?\s*/i, "").trim());
  }
  return out;
}

// ─── Structure-expansion pass: deterministically graft model-proposed sections into the outline ──
// Two defects land here, and they need different repairs:
//   • FLAT   — enough sections, but H2s carry <2 child H3s. Typical with user templates, where
//              models are too conservative to add their own subsections despite instructions.
//   • DEFICIT — too few sections for the word target, whatever their depth. This is what a
//              response cut off mid-`sections` leaves behind, and the flatness test alone MISSES
//              it: the H2s that made it into the response can be perfectly deep, so the pass
//              declared the outline healthy and returned without adding anything, while the word
//              guard spread 2500 words across the 7 surviving sections.
// Deficit mode may append whole H2 blocks; flat mode stays H3-only, so template skeletons keep
// their exact shape.
async function expandOutlineStructure(outline: any, ctx: {
  keyword: string; language: string; country: string; provider: string; apiKey: string;
  model?: string; baseUrl?: string; pageGoal?: "informational" | "commercial" | "mixed"; paa?: string[];
  targetWc?: number;
}): Promise<boolean> {
  const sections: any[] = Array.isArray(outline?.sections) ? outline.sections : [];
  const maxSections = targetSectionCount(ctx.targetWc);
  if (!sections.length || sections.length >= maxSections) return false;
  // Count H3 children per H2; skip expansion when the outline is already deep.
  let thinH2 = 0, h2Count = 0;
  for (let i = 0; i < sections.length; i++) {
    if (sections[i]?.h_level !== "H2") continue;
    h2Count++;
    let kids = 0;
    for (let j = i + 1; j < sections.length && sections[j]?.h_level !== "H2"; j++) kids++;
    if (kids < 2) thinH2++;
  }
  if (!h2Count) return false;
  const isFlat = thinH2 >= Math.ceil(h2Count / 2);
  const isShort = sections.length < Math.round(maxSections * 0.7);
  if (!isFlat && !isShort) return false;

  const missingTopics = isShort ? uncoveredSubIntents(outline, sections) : [];
  const prompt = buildStructureExpandPrompt({
    keyword: ctx.keyword, language: ctx.language, country: ctx.country,
    pageGoal: ctx.pageGoal, paa: ctx.paa,
    maxAdd: maxSections - sections.length,
    sections: sections.map((s: any) => ({ h_level: s.h_level, heading: s.heading })),
    allowNewH2: isShort,
    missingTopics,
    targetSections: maxSections,
  });
  const raw = await fetchLLM(prompt, ctx.provider, ctx.apiKey, 6000, ctx.model, ctx.baseUrl);
  const parsed: any = extractJson(raw);
  const insertions: any[] = Array.isArray(parsed?.insertions) ? parsed.insertions : [];
  if (!insertions.length) return false;

  const have = new Set(sections.map((s: any) => String(s.heading || "").trim().toLowerCase()));
  const blank = (n: any, level: "H2" | "H3") => {
    const wc = toWcRange(n.word_count_total) || (level === "H2" ? [40, 80] : [80, 160]);
    return {
      h_level: level, heading: String(n.heading).trim(),
      word_count_total: wc, word_count_self: wc,
      entities_to_cover: [], keywords: [], summary: String(n.summary || ""),
      visual_elements: [], copywriter_notes: "", entity_connections: [],
      needs_real_experience: false,
    };
  };
  let added = 0;
  for (const ins of insertions) {
    const anchorRaw = String(ins?.after_heading || "").trim();
    const anchor = anchorRaw.toLowerCase();
    // "END" appends a whole new block after everything else — the only way to restore an H2 the
    // truncated response never got to, since there is no surviving heading to hang it under.
    const atEnd = isShort && (anchor === "end" || anchor === "«end»" || anchor === '"end"');
    let at: number;
    if (atEnd) {
      at = sections.length;
    } else {
      const idx = sections.findIndex((s: any) => String(s.heading || "").trim().toLowerCase() === anchor && s.h_level === "H2");
      if (idx === -1) continue;
      // Insert AFTER the anchor H2's existing H3 block (i.e. right before the next H2).
      at = idx + 1;
      while (at < sections.length && sections[at]?.h_level !== "H2") at++;
    }
    const newbies = (Array.isArray(ins.sections) ? ins.sections : [])
      .filter((n: any) => n?.heading && !have.has(String(n.heading).trim().toLowerCase()))
      .slice(0, 6)
      // An H2 is only honoured in deficit mode; otherwise everything grafts in as H3 exactly as
      // before, so a template skeleton can never sprout a top-level heading it did not ask for.
      .map((n: any) => blank(n, isShort && String(n?.h_level || "").toUpperCase() === "H2" ? "H2" : "H3"));
    newbies.forEach((n: any) => have.add(n.heading.trim().toLowerCase()));
    const room = Math.max(0, maxSections - sections.length);
    sections.splice(at, 0, ...newbies.slice(0, room));
    added += Math.min(newbies.length, room);
    if (sections.length >= maxSections) break;
  }
  return added > 0;
}

// ─── FAQ backfill: regenerate the FAQ block when the outline arrived without one ────
// Cheap, and it repairs two things at once: the article gets its question block back, and the
// word-budget guard downstream once again has something to reserve words FOR — without a `faq`
// array it reserves nothing and pushes the entire article target into the body sections.
async function backfillOutlineFaq(outline: any, ctx: {
  keyword: string; language: string; country: string; provider: string; apiKey: string;
  model?: string; baseUrl?: string; pageGoal?: "informational" | "commercial" | "mixed"; paa?: string[];
}): Promise<boolean> {
  if (Array.isArray(outline?.faq) && outline.faq.length >= 3) return false;
  const sections: any[] = Array.isArray(outline?.sections) ? outline.sections : [];
  const prompt = buildFaqBackfillPrompt({
    keyword: ctx.keyword, language: ctx.language, country: ctx.country, pageGoal: ctx.pageGoal,
    count: 8,
    headings: sections.map((s: any) => String(s?.heading || "")).filter(Boolean),
    subIntents: (Array.isArray(outline?.sub_intents) ? outline.sub_intents : [])
      .map((si: any) => String(si?.intent || "")).filter(Boolean),
    paa: ctx.paa,
  });
  const raw = await fetchLLM(prompt, ctx.provider, ctx.apiKey, 4000, ctx.model, ctx.baseUrl);
  const parsed: any = extractJson(raw);
  const faq = (Array.isArray(parsed?.faq) ? parsed.faq : [])
    .filter((f: any) => f && String(f.question || "").trim())
    .slice(0, 10)
    .map((f: any) => ({ question: String(f.question).trim(), answer_guideline: String(f.answer_guideline || "").trim() }));
  if (faq.length < 3) return false;
  outline.faq = faq;
  return true;
}

// ─── Heading localization pass: apply model-proposed renames deterministically ─────
// Template headings arrive in English and models keep them verbatim; this pass translates
// them into the article language and applies the narration voice, without touching order,
// structure or budgets. Renames are matched exactly and deduplicated before applying.
async function localizeOutlineHeadings(outline: any, ctx: {
  keyword: string; language: string; country: string; provider: string; apiKey: string;
  model?: string; baseUrl?: string; pageGoal?: "informational" | "commercial" | "mixed";
}): Promise<boolean> {
  const sections: any[] = Array.isArray(outline?.sections) ? outline.sections : [];
  if (!sections.length) return false;
  const prompt = buildHeadingLocalizePrompt({
    keyword: ctx.keyword, language: ctx.language, country: ctx.country,
    narration: outline?.meta?.narration === "first" ? "first" : outline?.meta?.narration === "third" ? "third" : undefined,
    pageGoal: ctx.pageGoal, h1: outline?.meta?.h1,
    titleOptions: Array.isArray(outline?.meta?.title_options) ? outline.meta.title_options : undefined,
    descriptionOptions: Array.isArray(outline?.meta?.description_options) ? outline.meta.description_options : undefined,
    headings: sections.map((s: any) => ({ h_level: s.h_level, heading: s.heading })),
  });
  const raw = await fetchLLM(prompt, ctx.provider, ctx.apiKey, 3000, ctx.model, ctx.baseUrl);
  const parsed: any = extractJson(raw);
  if (!parsed) return false;

  let changed = false;
  const have = new Set(sections.map((s: any) => String(s.heading || "").trim().toLowerCase()));
  const renames: any[] = Array.isArray(parsed.renames) ? parsed.renames : [];
  for (const r of renames) {
    const from = String(r?.from || "").trim();
    const to = String(r?.to || "").trim();
    if (!from || !to || from === to) continue;
    if (have.has(to.toLowerCase())) continue; // never create duplicate headings
    const sec = sections.find((s: any) => String(s.heading || "").trim() === from);
    if (!sec) continue;
    have.delete(from.toLowerCase());
    have.add(to.toLowerCase());
    sec.heading = to;
    changed = true;
  }
  const newH1 = String(parsed.h1 || "").trim();
  if (newH1 && newH1 !== String(outline?.meta?.h1 || "").trim()) {
    (outline.meta ||= {}).h1 = newH1;
    changed = true;
  }
  // Localized meta tags (Title/Description) — applied only when the model returned non-empty ones.
  const titles = (Array.isArray(parsed.title_options) ? parsed.title_options : []).map((x: any) => String(x || "").trim()).filter(Boolean);
  if (titles.length) { (outline.meta ||= {}).title_options = titles; changed = true; }
  const descs = (Array.isArray(parsed.description_options) ? parsed.description_options : []).map((x: any) => String(x || "").trim()).filter(Boolean);
  if (descs.length) { (outline.meta ||= {}).description_options = descs; changed = true; }
  return changed;
}

// ─── Section-enrichment pass: deepen per-section EAV detail in parallel batches ────
// A single outline call compresses detail when there are 15-30 sections (output-token
// budget), yielding one-entity sections and one-line summaries/notes. This pass re-runs
// sections through the model in batches of 5 (3 parallel workers), merging back the
// enriched fields — total outline size is no longer capped by one response.
async function enrichOutlineSections(outline: any, ctx: {
  keyword: string; language: string; country: string; provider: string; apiKey: string;
  model?: string; baseUrl?: string; tone?: string; persona?: string; ragFacts?: string;
  pageGoal?: "informational" | "commercial" | "mixed";
}): Promise<boolean> {
  const sections: any[] = Array.isArray(outline?.sections) ? outline.sections : [];
  if (!sections.length) return false;
  const globalEntities = (Array.isArray(outline?.entities) ? outline.entities : [])
    .map((e: any) => (typeof e === "string" ? e : e?.name)).filter(Boolean);
  const BATCH = 5;
  const batches: { start: number; items: any[] }[] = [];
  for (let i = 0; i < sections.length; i += BATCH) batches.push({ start: i, items: sections.slice(i, i + BATCH) });

  let enrichedAny = false;
  await runPool(batches, 2, async (batch) => { // low concurrency — parallel bursts trip provider TPM limits (429)
    try {
      const prompt = buildSectionEnrichPrompt({
        keyword: ctx.keyword, language: ctx.language, country: ctx.country,
        tone: ctx.tone, persona: ctx.persona, pageGoal: ctx.pageGoal,
        narration: outline?.meta?.narration === "first" ? "first" : outline?.meta?.narration === "third" ? "third" : undefined,
        h1: outline?.meta?.h1, globalEntities, ragFacts: ctx.ragFacts, sections: batch.items,
      });
      const raw = await fetchLLM(prompt, ctx.provider, ctx.apiKey, 8000, ctx.model, ctx.baseUrl);
      const parsed: any = extractJson(raw);
      const out: any[] = Array.isArray(parsed?.sections) ? parsed.sections : [];
      out.forEach((es: any, j: number) => {
        const target = sections[batch.start + j];
        if (!target || !es) return;
        // Heading sanity: merge only when it's clearly the same section (or model kept it).
        if (es.heading && target.heading && String(es.heading).trim() !== String(target.heading).trim()) return;
        // Merge ONLY the enrichable fields; structure and word budgets stay untouched.
        if (Array.isArray(es.entities_to_cover) && es.entities_to_cover.length) target.entities_to_cover = es.entities_to_cover;
        if (Array.isArray(es.keywords) && es.keywords.length) target.keywords = es.keywords;
        if (typeof es.summary === "string" && es.summary.trim().length > String(target.summary || "").length) target.summary = es.summary.trim();
        if (typeof es.copywriter_notes === "string" && es.copywriter_notes.trim().length > String(target.copywriter_notes || "").length) target.copywriter_notes = es.copywriter_notes.trim();
        if (Array.isArray(es.entity_connections) && es.entity_connections.length) target.entity_connections = es.entity_connections;
        if (Array.isArray(es.visual_elements) && es.visual_elements.length && !(target.visual_elements || []).length) target.visual_elements = es.visual_elements;
        enrichedAny = true;
      });
    } catch { /* per-batch enrichment is best-effort */ }
  });
  return enrichedAny;
}

// ─── Outline (structure) ─────────────────────────────────────────────────────────
export async function genOutline(b: any): Promise<GenResult> {
  const keyword = String(b.keyword ?? "").trim();
  if (!keyword) return { ok: false, error: "no_keyword" };
  // Mutable, because the head call may fall back to another provider (see below) and every
  // later pass — scrub, expand, localize, enrich — must follow it rather than keep hammering
  // the one that just failed.
  let provider = String(b.aiProvider ?? "anthropic");
  let apiKey = String(b.aiApiKey ?? "");
  if (!apiKey) return { ok: false, error: "no_ai_key" };

  const competitors: CompetitorInput[] = Array.isArray(b.competitors) ? b.competitors : [];
  if (!competitors.length && b.serpKey && b._autoFetched !== true) {
    return genOutlineAuto({ ...b, _autoFetched: true });
  }
  let model = b.model ? String(b.model) : undefined;
  let baseUrl = b.aiBaseUrl ? String(b.aiBaseUrl) : undefined;

  // MAP stage: extract compact facts per source (parallel) before assembling the outline.
  if (b.mapExtract !== false && competitors.length) {
    try { await mapExtractFacts(competitors, keyword, String(b.country ?? "us"), provider, apiKey, model, baseUrl); } catch { /* fall back to raw text grounding */ }
  }

  // Casino RAG: pull verified entity facts (slots/casinos/providers) from the knowledge base.
  const rag = b.useRag ? await findRagFacts(keyword) : null;

  const prompt = buildOutlinePrompt({
    keyword,
    language: String(b.language ?? "en"),
    country: String(b.country ?? "us"),
    competitors,
    policy: b.policy,
    paa: b.paa,
    related: b.related,
    tone: b.tone ? String(b.tone) : undefined,
    persona: b.persona ? String(b.persona) : undefined,
    additionalKeywords: b.additionalKeywords ? String(b.additionalKeywords) : undefined,
    lsiKeywords: b.lsiKeywords ? String(b.lsiKeywords) : undefined,
    targetWordCount: b.targetWordCount ? Number(b.targetWordCount) : undefined,
    manualTexts: Array.isArray(b.manualTexts) ? b.manualTexts : undefined,
    keywordsData: Array.isArray(b.keywordsData) ? b.keywordsData : undefined,
    keywordsSource: b.keywordsSource ? String(b.keywordsSource) : undefined,
    pageGoal: b.pageGoal === "commercial" || b.pageGoal === "informational" ? b.pageGoal : "mixed",
    narration: b.narration === "first" || b.narration === "third" ? b.narration : undefined,
    customTemplate: b.customTemplate ? String(b.customTemplate) : undefined,
    structureRules: b.structureRules ? String(b.structureRules) : undefined,
    ragFacts: rag?.rendered,
    bannedWords: Array.isArray(b.bannedWords) ? b.bannedWords : undefined,
    // Enrichment (default on) deepens every section afterwards — keep the skeleton lean so
    // one call fits the token budget and finishes well within the LLM timeout.
    lightSections: b.enrich !== false,
  });

  // The outline call must return parseable JSON, and sampling randomness is exactly what breaks
  // that — so the temperature the user picked for prose is capped here rather than passed through
  // raw. The retry below already covers the occasional malformed response; this keeps it rare.
  const outlineTemp = b.temperature === undefined || b.temperature === null
    ? undefined : Math.min(0.8, Math.max(0, Number(b.temperature)));

  // fetchLLMDetailed rather than fetchLLM: when the provider fails, its own reason is the only
  // thing that makes the failure actionable, and fetchLLM throws that reason away. A bare
  // "parse_failed" here cost real debugging time — it named the JSON parser for problems that
  // were actually an empty completion, a safety block or a refusal upstream.
  // Output budget for the outline call. 16000 was one flat number covering both the answer AND
  // whatever hidden reasoning the model does, and a 20-30 section EAV structure does not fit
  // underneath it once a reasoning model has taken its cut. What made that expensive rather than
  // merely annoying is that nothing NOTICED: the cut-off response was salvaged into valid JSON,
  // shipped as a finished outline missing the tail of its own section list plus `faq` and
  // `entity_analysis`, and the word guard then spread the whole article target across whatever
  // sections had survived. So: a larger first ask, and one retry at a larger ceiling still when
  // the answer comes back cut off.
  //
  // Overridable via `outlineMaxTokens` because the ceiling is also a DIAGNOSTIC. A gateway that
  // fails to report usage on long generations but serves short ones fine cannot be told apart
  // from a broken model without varying exactly this number, and recompiling to change a constant
  // makes that a deploy per experiment.
  const OUTLINE_TOKENS = Math.max(4000, Math.min(64000, Number(b.outlineMaxTokens) || 24000));
  const OUTLINE_TOKENS_RETRY = Math.min(64000, Math.round(OUTLINE_TOKENS * 1.35));
  const wantSections = targetSectionCount(Number(b.targetWordCount) || 0);
  const sectionCount = (o: any) => (Array.isArray(o?.sections) ? o.sections.length : 0);
  // Two signals, both definitive, neither previously visible: the provider saying it stopped at
  // the ceiling, and our own JSON salvage admitting it had to re-close open containers. A merely
  // THIN outline is not counted here — the expansion and FAQ passes below repair that far more
  // cheaply than paying for the whole call again.
  const cutOff = (repaired: boolean, finish?: string) => {
    const f = String(finish || "").toLowerCase();
    return repaired || f === "length" || f === "max_tokens" || f === "max_output_tokens";
  };

  let res = await fetchLLMDetailed(prompt, provider, apiKey, OUTLINE_TOKENS, model, baseUrl, outlineTemp);
  let raw = res.text;
  let parsed0 = extractJsonDetailed(raw);
  let outline = parsed0.data;
  let wasCutOff = !!outline && cutOff(parsed0.repaired, res.finishReason);
  if (!outline) {
    // Retry deterministically: if sampling is what mangled the JSON, repeating at the same
    // temperature just rolls the same dice again.
    res = await fetchLLMDetailed(prompt + (raw ? "\n\nПредыдущий ответ не распарсился. Верни ТОЛЬКО валидный JSON, без текста и без markdown-обёрток." : ""), provider, apiKey, OUTLINE_TOKENS, model, baseUrl, outlineTemp === undefined ? undefined : 0);
    raw = res.text;
    parsed0 = extractJsonDetailed(raw);
    outline = parsed0.data;
    wasCutOff = !!outline && cutOff(parsed0.repaired, res.finishReason);
  } else if (wasCutOff) {
    // Repeating the request at the SAME ceiling would reproduce the same truncation — the point
    // of this retry is the higher ceiling, not the reroll. Whichever attempt is more complete
    // wins, so a second truncation can only ever gain sections, never lose them.
    console.error(`[outline] response cut off (finish_reason: ${res.finishReason ?? "n/a"}, sections: ${sectionCount(outline)}/${wantSections}) — retrying with a larger token budget`);
    try {
      const res2 = await fetchLLMDetailed(prompt, provider, apiKey, OUTLINE_TOKENS_RETRY, model, baseUrl, outlineTemp);
      const parsed2 = extractJsonDetailed(res2.text);
      if (parsed2.data) {
        const cut2 = cutOff(parsed2.repaired, res2.finishReason);
        if (!cut2 || sectionCount(parsed2.data) > sectionCount(outline)) {
          res = res2; raw = res2.text; outline = parsed2.data; wasCutOff = cut2;
        }
      }
    } catch { /* keep the first attempt; the repair passes below still run */ }
  }
  // PROVIDER FALLBACK: the outline is the one step whose failure wastes everything before it —
  // the SERP call, the scrape and the per-source fact extraction are all already paid for by the
  // time it runs. When the configured provider cannot produce it for a reason that is about the
  // PROVIDER rather than the content (a gateway that discards a finished generation because it
  // could not read usage for billing; an upstream that is simply down), another configured
  // provider usually can, and the alternative to trying one is throwing the whole job away.
  //
  // Deliberately not attempted for content-policy refusals: every provider will refuse the same
  // prompt, so retrying elsewhere just bills the user twice for the same "no".
  let fellBackTo: string | undefined;
  const fallbacks: any[] = Array.isArray(b.aiFallbacks) ? b.aiFallbacks : [];
  const contentRefusal = /content|policy|safety|unsafe|sensitive|moderation/i.test(res.error ?? "");
  if (!outline && fallbacks.length && !contentRefusal) {
    for (const fb of fallbacks) {
      const fbProvider = String(fb?.aiProvider ?? "").trim();
      const fbKey = String(fb?.aiApiKey ?? "").trim();
      if (!fbProvider || !fbKey || fbProvider === provider) continue;
      console.error(`[outline] ${provider} failed (${res.error ?? "no parseable output"}) — retrying on ${fbProvider}`);
      try {
        const rf = await fetchLLMDetailed(prompt, fbProvider, fbKey, OUTLINE_TOKENS, fb.model ? String(fb.model) : undefined, fb.aiBaseUrl ? String(fb.aiBaseUrl) : undefined, outlineTemp);
        const pf = extractJsonDetailed(rf.text);
        if (!pf.data) continue;
        // Everything downstream now runs on whichever provider actually answered.
        res = rf; raw = rf.text; outline = pf.data;
        wasCutOff = cutOff(pf.repaired, rf.finishReason);
        provider = fbProvider; apiKey = fbKey;
        model = fb.model ? String(fb.model) : undefined;
        baseUrl = fb.aiBaseUrl ? String(fb.aiBaseUrl) : undefined;
        fellBackTo = fbProvider;
        break;
      } catch { /* try the next one */ }
    }
  }

  // Three genuinely different failures, three different messages. They used to collapse into
  // "generation_failed" / "parse_failed", which said nothing about which one had happened.
  if (!outline) {
    if (raw == null) return { ok: false, error: res.error ?? "generation_failed" };
    // Reaching here means the model DID return text that is not JSON — quote the head of it,
    // because that is the one piece of evidence needed to tell a wrapped//chatty answer apart
    // from a truncated one, and it is otherwise never persisted anywhere.
    const head = raw.trim().replace(/\s+/g, " ").slice(0, 300);
    return { ok: false, error: `parse_failed — the model returned text that is not valid JSON. First 300 chars: ${head}` };
  }

  // Knowledge-based fact scrub: actively correct wrong/fabricated specifics baked into the outline
  // (e.g. "8-inch" → "7.9-inch", invented colors → generalized) BEFORE the text inherits them.
  if (b.factScrub !== false) {
    try {
      const scrubPrompt = buildFactScrubPrompt({ outline, keyword, country: String(b.country ?? "us") });
      const scrubRaw = await fetchLLM(scrubPrompt, provider, apiKey, 4000, model, baseUrl);
      const parsed: any = extractJson(scrubRaw);
      const corrections = Array.isArray(parsed?.corrections)
        ? parsed.corrections
            .filter((c: any) => c && typeof c.find === "string" && c.find.trim() && typeof c.replace === "string" && c.find !== c.replace)
            .slice(0, 40)
        : [];
      if (corrections.length) {
        outline = applyCorrections(outline, corrections);
        (outline as any)._scrub = { applied: corrections.length };
      }
    } catch { /* scrub is best-effort; never block outline on it */ }
  }

  // Deterministically stamp region/voice into meta so the text step inherits them reliably.
  const meta = ((outline as any).meta ||= {});
  meta.country = String(b.country ?? "us");
  meta.language = String(b.language ?? "en");
  // Self-describing outline: genText and every later consumer fall back to this when no
  // keyword was passed alongside (the UI posts keyword + outline as separate fields).
  meta.keyword = keyword;
  if (b.narration === "first" || b.narration === "third") meta.narration = b.narration;
  if (b.structureRules && String(b.structureRules).trim()) meta.structureRules = String(b.structureRules).trim();
  // Recorded rather than thrown away: the repair passes below usually make a truncated response
  // whole again, but "this outline was rebuilt from a cut-off answer" is exactly the context
  // needed when someone later asks why a generation looks thin, and it costs one boolean.
  if (wasCutOff) { (outline as any)._truncated = true; meta.truncated = true; }
  // Which provider actually wrote this, when it was not the configured one. Without it a
  // successful job hides the fact that the primary provider is broken, and nobody fixes it.
  if (fellBackTo) { (outline as any)._fallback_provider = fellBackTo; meta.fallback_provider = fellBackTo; }
  // EXPAND pass (default on): if the outline is flat (most H2s have <2 child H3s — typical
  // with user templates), graft model-proposed H3 subsections deterministically. Runs BEFORE
  // the volume guard so budgets are redistributed across the new sections too. Off with expand:false.
  if (b.expand !== false) {
    try {
      const grown = await expandOutlineStructure(outline, {
        keyword, language: String(b.language ?? "en"), country: String(b.country ?? "us"),
        provider, apiKey, model, baseUrl,
        pageGoal: b.pageGoal === "commercial" || b.pageGoal === "informational" ? b.pageGoal : "mixed",
        paa: Array.isArray(b.paa) ? b.paa : undefined,
        targetWc: Number(b.targetWordCount) || Number(meta.target_word_count) || 0,
      });
      if (grown) (outline as any)._expanded = true;
    } catch { /* expansion is best-effort */ }
  }

  // LOCALIZE pass (default on): translate/style headings into the article language with the
  // chosen narration voice — template skeletons arrive in English and models keep them
  // verbatim otherwise. Runs before enrichment so opening lines match the final headings.
  if (b.localizeHeadings !== false) {
    try {
      const renamed = await localizeOutlineHeadings(outline, {
        keyword, language: String(b.language ?? "en"), country: String(b.country ?? "us"),
        provider, apiKey, model, baseUrl,
        pageGoal: b.pageGoal === "commercial" || b.pageGoal === "informational" ? b.pageGoal : "mixed",
      });
      if (renamed) (outline as any)._localized = true;
    } catch { /* localization is best-effort */ }
  }

  // FAQ BACKFILL (default on): `faq` sits at the tail of the outline schema, so it is the first
  // casualty of any short response — and its absence is not a cosmetic one. The article loses the
  // block that earns People-Also-Ask and AI-answer citations, and the volume guard immediately
  // below reserves words only for questions that exist, so an empty `faq` pushes the entire word
  // target into the body and inflates every section. Runs BEFORE that guard for exactly that
  // reason. Off with faqBackfill:false.
  if (b.faqBackfill !== false) {
    try {
      const built = await backfillOutlineFaq(outline, {
        keyword, language: String(b.language ?? "en"), country: String(b.country ?? "us"),
        provider, apiKey, model, baseUrl,
        pageGoal: b.pageGoal === "commercial" || b.pageGoal === "informational" ? b.pageGoal : "mixed",
        paa: Array.isArray(b.paa) ? b.paa : undefined,
      });
      if (built) (outline as any)._faq_backfilled = true;
    } catch { /* backfill is best-effort; an outline without FAQ is still usable */ }
  }

  // Volume guard: stamp the requested target and rescale section budgets if the model
  // under-budgeted them. The USER's explicit target is authoritative; a MODEL-emitted
  // meta.target_word_count is distrusted when implausible (e.g. junk like 247) — in that
  // case we adopt the sum of the outline's own budgets instead of shrinking a healthy outline.
  const explicitWc = Number(b.targetWordCount) || 0;
  let targetWc = explicitWc;
  if (!targetWc) {
    const modelWc = Number(meta.target_word_count) || 0;
    targetWc = modelWc >= 500 ? modelWc : (ownBudgetSum(outline) || modelWc);
  }
  if (targetWc > 0) {
    meta.target_word_count = targetWc;
    // FAQ answers are written ON TOP of the sections — reserve their words (~50/question)
    // out of the section budgets, reference-tool style ("Available for Content").
    const faqReserve = Math.min(Math.round(targetWc * 0.25), (Array.isArray((outline as any).faq) ? (outline as any).faq.length : 0) * 50);
    if (normalizeWordBudgets(outline, Math.max(300, targetWc - faqReserve))) (outline as any)._wc_rescaled = true;
  }

  // ENRICH pass (default on): deepen every section's EAV detail in parallel batches —
  // role-annotated entities, 4-6 sentence summaries, rich copywriter notes with a
  // ready opening line, weighted triplets. Off with enrich:false.
  if (b.enrich !== false) {
    try {
      const ok = await enrichOutlineSections(outline, {
        keyword, language: String(b.language ?? "en"), country: String(b.country ?? "us"),
        provider, apiKey, model, baseUrl,
        tone: b.tone ? String(b.tone) : undefined,
        persona: b.persona ? String(b.persona) : undefined,
        ragFacts: rag?.rendered,
        pageGoal: b.pageGoal === "commercial" || b.pageGoal === "informational" ? b.pageGoal : "mixed",
      });
      if (ok) (outline as any)._enriched = true;
    } catch { /* enrichment is best-effort */ }
  }
  // Persist the real competitor facts that grounded the outline, so the TEXT step is built on the
  // SAME sources (fact-check then just confirms, instead of cleaning up). Kept compact for size.
  const carriedSources = competitors
    .filter((c) => c.text_sample && String(c.text_sample).trim())
    .sort((a, b) => (b.site_type === "official_store" ? 1 : 0) - (a.site_type === "official_store" ? 1 : 0))
    .slice(0, 6)
    .map((c) => ({
      title: (c.site_type === "official_store" ? "[ОФИЦИАЛЬНЫЙ] " : "") + (c.title || c.url),
      url: c.url,
      domain: (c.url.match(/^https?:\/\/([^/]+)/)?.[1] || "").replace(/^www\./, ""),
      snippet: String(c.text_sample).replace(/\s+/g, " ").trim().slice(0, c.site_type === "official_store" ? 3500 : 2500),
    }));
  if (carriedSources.length) (meta as any).sources = carriedSources;
  // Consolidated FACTS BANK from the map stage — the article is written from it AND the auto
  // fact-clean later verifies against it (so fact-check confirms instead of re-searching).
  const factsBank = competitors
    .filter((c) => c.extracted && String(c.extracted).trim())
    .sort((a, b) => (b.site_type === "official_store" ? 1 : 0) - (a.site_type === "official_store" ? 1 : 0))
    .slice(0, 8)
    .map((c) => ({
      source: c.url,
      domain: (c.url.match(/^https?:\/\/([^/]+)/)?.[1] || "").replace(/^www\./, ""),
      official: c.site_type === "official_store",
      facts: String(c.extracted).trim().slice(0, 1600),
    }));
  // SANITIZE: decode HTML entities the passes occasionally emit (&eacute; → é) and drop
  // stray H1-level sections — the H1 lives in meta, an H1 section duplicates it in every view.
  deepMapStringsInPlace(outline, decodeHtmlEntities);

  // STALE-YEAR fix (deterministic): headings/titles/FAQ questions saying "pour 2025" /
  // "в 2024" mean "current year" — models leak their training-era year despite the prompt
  // date line. Only heading-like fields are touched (summaries/notes may cite history),
  // and phrases like "depuis 2024 / founded in 2023" are preserved.
  const NOW_YEAR = new Date().getFullYear();
  const fixYear = (s: string) => typeof s === "string"
    ? s.replace(/(depuis|since|lancé en|founded in|est\.|основан[оа]?\s+в|запущен[оа]?\s+в|créé en|вышл[аио]\s+в)\s+(202[0-5])\b/gi, "$1 §KEEP$2§")
        .replace(/\b202[0-5]\b/g, String(NOW_YEAR))
        .replace(/§KEEP(202[0-5])§/g, "$1")
    : s;
  for (const sec of (Array.isArray((outline as any).sections) ? (outline as any).sections : [])) {
    sec.heading = fixYear(sec.heading);
    if (Array.isArray(sec.keywords)) sec.keywords = sec.keywords.map(fixYear);
  }
  if (meta.h1) meta.h1 = fixYear(meta.h1);
  if (Array.isArray(meta.title_options)) meta.title_options = meta.title_options.map(fixYear);
  if (Array.isArray(meta.description_options)) meta.description_options = meta.description_options.map(fixYear);
  for (const q of (Array.isArray((outline as any).faq) ? (outline as any).faq : [])) {
    if (q?.question) q.question = fixYear(q.question);
  }
  if (Array.isArray((outline as any).sections)) {
    const secsAll: any[] = (outline as any).sections;
    const hasFaqArr = Array.isArray((outline as any).faq) && (outline as any).faq.length > 0;
    for (let i = secsAll.length - 1; i >= 0; i--) {
      if (String(secsAll[i]?.h_level || "").toUpperCase() === "H1") {
        if (!meta.h1 && secsAll[i].heading) meta.h1 = secsAll[i].heading;
        secsAll.splice(i, 1);
        continue;
      }
      // The FAQ lives ONLY in the faq[] array — a sections[] entry titled "FAQ…" (template
      // artifact) duplicates it and gets written as a prose section with its own questions.
      if (hasFaqArr && FAQ_LIKE_RE.test(String(secsAll[i]?.heading || ""))) secsAll.splice(i, 1);
    }
  }

  // RAG facts join the facts bank FIRST (highest trust) so both the text step and the
  // auto fact-clean verify against the knowledge base, not only scraped competitors.
  if (rag?.bankEntry) factsBank.unshift(rag.bankEntry as any);
  if (factsBank.length) (meta as any).facts_bank = factsBank;
  if (b.useRag) (meta as any).use_rag = true;
  return { ok: true, data: outline };
}

// ─── TOC heading label per language (deterministic — never trust the model for this fixed
// string: the one-shot prompt used to show a literal Russian example `<strong>Содержание</strong>`
// and models copied it verbatim regardless of article language; even the old chunked-path list
// only covered ru/uk/fr). Extend this map rather than relying on the LLM to translate one word.
const TOC_LABELS: Record<string, string> = {
  ru: "Содержание", uk: "Зміст", fr: "Sommaire", es: "Índice", de: "Inhalt", it: "Indice",
  pt: "Índice", pl: "Spis treści", tr: "İçindekiler", nl: "Inhoud", ro: "Cuprins", cs: "Obsah",
  sk: "Obsah", hu: "Tartalom", bg: "Съдържание", el: "Περιεχόμενα", ar: "المحتويات",
  ja: "目次", ko: "목차", zh: "目录", sv: "Innehåll", da: "Indhold", no: "Innhold", fi: "Sisällys",
};
function tocLabelFor(language: string): string {
  const lang = String(language || "").toLowerCase();
  for (const code of Object.keys(TOC_LABELS)) if (lang.startsWith(code)) return TOC_LABELS[code];
  return "Contents";
}

// Guarantee the TOC heading is in the article's own language, whatever the writer produced and
// whatever any later pass (expand/trim/fact-clean) did to it. Runs as a final deterministic
// override, same idea as ensureMetaBlock below.
export function ensureTocLabel(text: string, language: string): string {
  if (!text || !/<div class="toc">/i.test(text)) return text;
  const label = tocLabelFor(language);
  return text.replace(/(<div class="toc">\s*<strong>)([^<]*)(<\/strong>)/i, (_m, pre, _old, post) => `${pre}${label}${post}`);
}

// ─── Chunked article writer: H2-units → chunks of ~4 sections → parallel small calls ──
// Returns the assembled article body (H1 + sections + FAQ) or null → caller falls back to
// the single-shot path. Each chunk sees the full article map so nothing gets duplicated.
// Spread the sampling temperature slightly across chunks when a base temperature is set.
//
// Chunked writing gives us a lever a single-shot article doesn't have: each chunk is its own
// completion, so nudging the temperature per chunk widens the token distribution of the finished
// article rather than of one call. Statistical detectors score ~300-word windows and average them,
// so a text assembled from calls that sampled slightly differently is not the same object as a text
// sampled uniformly. The offsets are deliberately small — this is meant to add variance, not to
// swing individual chunks into the incoherent range where quality collapses.
//
// Indexed rather than random so a rerun of the same outline stays reproducible.
const CHUNK_TEMP_OFFSETS = [0, 0.1, -0.08, 0.05, -0.05, 0.12];
function chunkTemp(base: number | undefined, i: number): number | undefined {
  if (base === undefined) return undefined;
  return Math.max(0, Math.round((base + CHUNK_TEMP_OFFSETS[i % CHUNK_TEMP_OFFSETS.length]) * 100) / 100);
}

// What the chunked writer reports back. It is no longer just "the article or nothing": a chunk
// that fails after retries costs the caller a decision, and the decision needs to know how much
// of the article actually exists and why the rest does not.
interface ChunkedTextResult {
  text: string | null;
  wroteChunks: number;
  totalChunks: number;
  /** Headings whose chunk never came back — what the shipped article is missing. */
  missingHeadings: string[];
  /** The provider's own reason for the last failed chunk, for the error the user finally sees. */
  lastError?: string;
}

async function writeTextInChunks(outline: any, ctx: {
  keyword: string; language: string; tone: string; provider: string; apiKey: string;
  model?: string; baseUrl?: string; ragFacts?: string;
  sources?: { title: string; snippet: string; url: string; domain: string }[];
  sourceMode?: "off" | "facts" | "cited"; includeToc?: boolean; temperature?: number;
  bannedWords?: string[];
}): Promise<ChunkedTextResult> {
  // FAQ-like sections[] entries are dropped up front (defensive — outlines saved before the
  // sanitizer existed still carry the template's "H2: FAQ" duplicate): the FAQ is rendered
  // exclusively from the faq[] array by the dedicated call below.
  const hasFaqArr = Array.isArray(outline?.faq) && outline.faq.length > 0;
  const secs: any[] = (Array.isArray(outline?.sections) ? outline.sections : [])
    .filter((s: any) => !(hasFaqArr && FAQ_LIKE_RE.test(String(s?.heading || ""))));
  if (!secs.length) return { text: null, wroteChunks: 0, totalChunks: 0, missingHeadings: [] };
  const meta = outline.meta || {};

  // Per-section spec with a SINGLE word_count = the section's OWN contribution (a parent's
  // total includes its children — passing both made models write the intro at full total
  // AND the children at theirs, overshooting the article by ~35-40%).
  const own = ownRanges(secs);
  const specs: any[] = secs.map((s: any, i: number) => ({
    h_level: s.h_level, heading: s.heading,
    word_count: own[i] || [60, 100],
    entities_to_cover: s.entities_to_cover, keywords: s.keywords, summary: s.summary,
    copywriter_notes: s.copywriter_notes, entity_connections: s.entity_connections,
    visual_elements: s.visual_elements, needs_real_experience: s.needs_real_experience,
  }));

  // EDITORIAL FOLDING (reference-tool behavior): the outline is a research artifact — the
  // article doesn't have to render every H3 as a heading. When the outline has more sections
  // than the word target supports (~100 words/heading), the THINNEST H3s are folded into
  // their parent as subtopics covered in prose, so headings stay meaty and volume converges.
  const foldTarget = Number(meta.target_word_count) || 0;
  const maxRender = foldTarget >= 500 ? Math.max(10, Math.min(34, Math.round(foldTarget / 100))) : specs.length;
  if (specs.length > maxRender) {
    const h3idx = specs.map((s, i) => ({ s, i })).filter(x => x.s.h_level !== "H2");
    h3idx.sort((a, b) => (a.s.word_count?.[1] || 0) - (b.s.word_count?.[1] || 0));
    const toFold = new Set(h3idx.slice(0, specs.length - maxRender).map(x => x.i));
    for (let i = specs.length - 1; i >= 0; i--) {
      if (!toFold.has(i)) continue;
      let p = i - 1;
      while (p >= 0 && toFold.has(p)) p--;
      if (p < 0) continue;
      const s = specs[i], parent = specs[p];
      (parent.subtopics ||= []).unshift({ topic: s.heading, summary: s.summary, keywords: s.keywords });
      parent.word_count = [
        (parent.word_count?.[0] || 0) + (s.word_count?.[0] || 0),
        (parent.word_count?.[1] || 0) + (s.word_count?.[1] || 0),
      ];
      if (Array.isArray(s.visual_elements) && s.visual_elements.length && !(parent.visual_elements || []).length) parent.visual_elements = s.visual_elements;
      specs.splice(i, 1);
    }
  }

  // TABLE budget: exactly 1-2 tables per article, never one per section. Keep at most the
  // first 2 table-marked specs (older outlines over-mark), and if none is marked — assign
  // ONE to the most table-natural section by heading. FAQ is Q&A format, not tabular — never
  // let it carry a table, whether the mark came from the enrich pass (which just picks the
  // "most tabular" headings and doesn't know to skip FAQ) or from the keyword fallback below
  // (whose regex includes words like "bonus"/"limit"/"retrait" that commonly appear IN an FAQ
  // heading too, e.g. "FAQ — Bonus & Retraits").
  const isFaqHeading = (h: any) => /\bfaq\b|frequently asked/i.test(String(h || "").trim());
  for (const s of specs) if (isFaqHeading(s.heading)) s.visual_elements = [];
  const hasTableVe = (s: any) => (Array.isArray(s.visual_elements) ? s.visual_elements : [])
    .some((v: any) => typeof v === "object" ? /table/i.test(String(v?.type || "")) : /table|таблиц/i.test(String(v)));
  let tablesKept = 0;
  for (const s of specs) {
    if (!hasTableVe(s)) continue;
    tablesKept++;
    if (tablesKept > 2) s.visual_elements = []; // strip extras — no table spam
  }
  if (tablesKept === 0) {
    const tabular = /bonus|бонус|payment|paiement|paie|dépôt|deposit|депозит|retrait|withdraw|вывод|метод|cotes|коэффициент|odds|rtp|provider|провайдер|logiciel|jeux|games|слот|slot|сравн|compar|таблиц|limit|лимит/i;
    const pick = specs.find(s => !isFaqHeading(s.heading) && tabular.test(String(s.heading || "")));
    if (pick) pick.visual_elements = [{ type: "table", title: "", description: "сводная таблица по данным секции (только реальные значения из спеки/базы знаний/источников)" }];
  }


  // Units = H2 with its H3 children (never split a unit across chunks).
  const units: any[][] = [];
  for (const s of specs) {
    if (s.h_level === "H2" || !units.length) units.push([s]);
    else units[units.length - 1].push(s);
  }
  // Greedy chunks of ~2-3 units / ≤5 sections.
  const chunks: any[][] = [];
  for (const u of units) {
    const last = chunks[chunks.length - 1];
    if (last && last.length + u.length <= 5) last.push(...u);
    else chunks.push([...u]);
  }

  const allHeadings = specs.map((s: any) => ({ h_level: s.h_level, heading: s.heading }));
  const faq = Array.isArray(outline.faq) ? outline.faq : [];
  const verdictRe = /verdict|вердикт|итог|conclusion|заключение|avis final|final|raisons|choisir|pourquoi|почему|avantages|преимуществ/i;

  const parts: (string | null)[] = new Array(chunks.length).fill(null);
  let lastChunkError: string | undefined;
  const writeChunk = async ({ c, i }: { c: any[]; i: number }) => {
    const lo = c.reduce((a: number, s: any) => a + (s.word_count?.[0] || 0), 0);
    const hi = c.reduce((a: number, s: any) => a + (s.word_count?.[1] || 0), 0);
    const prompt = buildSectionTextPrompt({
      keyword: ctx.keyword, language: ctx.language, country: meta.country,
      tone: ctx.tone, narration: meta.narration === "first" ? "first" : meta.narration === "third" ? "third" : undefined,
      h1: meta.h1, allHeadings, sections: c,
      // FAQ is NEVER written by a chunk — it's rendered by a dedicated call below. Chunks
      // renamed/localized the FAQ heading and melted questions into prose too often.
      ragFacts: ctx.ragFacts, sources: ctx.sources, sourceMode: ctx.sourceMode,
      isVerdictChunk: c.some((s: any) => verdictRe.test(String(s.heading || ""))),
      chunkBudget: hi > 0 ? [lo, hi] : undefined,
      bannedWords: ctx.bannedWords,
    });
    // Detailed rather than plain: when a chunk fails, the provider's own reason is what makes the
    // final error actionable ("cheaperinference 502: …" instead of a bare generation_failed).
    const attempt = await fetchLLMDetailed(prompt, ctx.provider, ctx.apiKey, 6000, ctx.model, ctx.baseUrl, chunkTemp(ctx.temperature, i));
    const raw = attempt.text;
    if (!raw) { if (attempt.error) lastChunkError = attempt.error; return; }
    let md = raw.trim().replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    // Models sometimes prefix a stray H1 / meta block despite instructions — strip anything
    // before the first H2/H3 (the assembler owns H1, TOC and meta).
    const firstH = md.search(/^#{2,3}\s/m);
    if (firstH > 0) md = md.slice(firstH);
    // Per-chunk volume guard: a small chunk trims reliably (unlike a whole article). If the
    // chunk overshot its summed budget by >25%, one scoped trim pass brings it back.
    // The last chunk also carries the FAQ (~55 words/question) — include that in its allowance
    // so the scoped trim doesn't squeeze the sections to make room for FAQ.
    const hiEff = hi + (i === chunks.length - 1 ? faq.length * 55 : 0);
    const cw = md.split(/\s+/).filter(Boolean).length;
    if (hiEff > 0 && cw > hiEff * 1.15) {
      try {
        const cut = await fetchLLM(
          buildTextTrimPrompt({ article: md, targetWords: Math.round((lo + hiEff) / 2), currentWords: cw, language: ctx.language }),
          ctx.provider, ctx.apiKey, 6000, ctx.model, ctx.baseUrl,
        );
        if (cut) {
          const cmd = cut.trim().replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
          const nw = cmd.split(/\s+/).filter(Boolean).length;
          const heads = (s: string) => (s.match(/^#{2,3}\s/gm) || []).length;
          if (nw < cw * 0.95 && heads(cmd) === heads(md)) md = cmd;
        }
      } catch { /* keep the long version */ }
    }
    // Sanity: the chunk must contain at least its first section heading.
    const first = String(c[0]?.heading || "").trim();
    if (first && md.toLowerCase().includes(first.slice(0, Math.min(30, first.length)).toLowerCase())) parts[i] = md;
  };
  await runPool(chunks.map((c, i) => ({ c, i })), 2, writeChunk);

  // A failed chunk is retried ON ITS OWN, and this is the whole point of the change. One null
  // part used to discard every sibling chunk that had already been written AND paid for; the
  // caller then paid a third time for a single-shot rewrite of the entire article. A quarter of
  // an hour of work and real credits could be lost to one transient gateway error on one chunk.
  // The common causes — 429, gateway 5xx — clear on their own, so the missing chunks are simply
  // re-run, sequentially so the retry cannot re-trip the rate limit that caused the failure.
  for (let round = 0; round < 2; round++) {
    const missing = parts.map((p, i) => (p == null ? i : -1)).filter(i => i >= 0);
    if (!missing.length) break;
    console.error(`[text] ${missing.length}/${chunks.length} chunks missing — retry round ${round + 1}${lastChunkError ? ` (last: ${lastChunkError})` : ""}`);
    await new Promise(r => setTimeout(r, 10_000 * (round + 1)));
    for (const i of missing) await writeChunk({ c: chunks[i], i });
  }

  // Frozen BEFORE the FAQ pass, which rewrites `parts` in place and would otherwise turn a
  // still-missing chunk into an empty string indistinguishable from a written one.
  const missingIdx = parts.map((p, i) => (p == null ? i : -1)).filter(i => i >= 0);
  const missingHeadings = missingIdx.flatMap(i => chunks[i].map((s: any) => String(s.heading || "")).filter(Boolean));
  const wroteChunks = chunks.length - missingIdx.length;
  if (!wroteChunks) return { text: null, wroteChunks: 0, totalChunks: chunks.length, missingHeadings, lastError: lastChunkError };

  // FAQ: single, deterministic path. (1) Strip ANY FAQ-ish section a chunk may have written
  // anyway — matched by meaning, not by the literal "## FAQ" heading (models localize it:
  // «Questions Fréquentes…», «Часто задаваемые вопросы»…). (2) Render the FAQ with one
  // dedicated call that reliably yields the canonical shape: «## FAQ» → «### Question» →
  // answer → next question. (3) canonFaq strips any stray intro prose after the heading.
  const FAQ_HEADING_RE = /^##\s+.*(faq|questions?\s+fr[ée]quentes|frequently\s+asked|часто\s+задаваем|поширені\s+питання|вопросы\s+и\s+ответы)/im;
  const stripFaqSection = (md: string) => {
    const m = md.match(FAQ_HEADING_RE);
    if (!m || m.index == null) return md;
    const after = md.slice(m.index);
    const next = after.slice(2).search(/^##\s/m); // next H2 after this heading
    return (md.slice(0, m.index) + (next === -1 ? "" : after.slice(2 + next))).trim();
  };
  const canonFaq = (md: string) => md
    .replace(/^(##\s*FAQ[^\n]*)\n+[\s\S]*?(?=^###\s)/m, "$1\n\n"); // strip prose between H2 and 1st question
  if (faq.length) {
    for (let i = 0; i < parts.length; i++) if (parts[i] != null) parts[i] = stripFaqSection(parts[i] as string);
    try {
      const faqPrompt = `Сегодня ${new Date().toISOString().slice(0, 10)} — если уместен год, только текущий (${new Date().getFullYear()}). Ты пишешь FAQ-секцию статьи по теме "${ctx.keyword}" на языке ${ctx.language}. Верни ТОЛЬКО markdown секции строго такой формы: первая строка — ровно «## FAQ», затем СРАЗУ первый вопрос — НИКАКОГО вводного абзаца между ними. Каждый вопрос — «### Вопрос», под ним ответ 40-60 слов по answer_guideline (конкретика, без воды). Все ${faq.length} вопросов, СТРОГО В ЗАДАННОМ ПОРЯДКЕ. Заголовок секции НЕ переименовывай — ровно «## FAQ». Без преамбулы и \`\`\`-обёрток.\nВОПРОСЫ: ${JSON.stringify(faq)}`;
      const faqRaw = await fetchLLM(faqPrompt, ctx.provider, ctx.apiKey, 2500, ctx.model, ctx.baseUrl);
      if (faqRaw) {
        let faqMd = faqRaw.trim().replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
        // Normalize a localized heading to the canonical one, then enforce the shape.
        faqMd = faqMd.replace(FAQ_HEADING_RE, "## FAQ");
        if (!/^##\s*FAQ/m.test(faqMd) && /^###\s/m.test(faqMd)) faqMd = "## FAQ\n\n" + faqMd;
        if (/^##\s*FAQ/m.test(faqMd) && (faqMd.match(/^###\s/gm) || []).length >= Math.min(faq.length, 2)) {
          parts.push(canonFaq(faqMd));
        }
      }
    } catch { /* best-effort — article ships without FAQ in the worst case */ }
  }

  // Deterministic assembly: H1 → (optional TOC) → sections → FAQ came with the last chunk.
  const pick = (v: any) => Array.isArray(v) ? (v.find((x: any) => x && String(x).trim()) || "") : (v || "");
  const h1 = pick(meta.h1) || pick(meta.title_options) || ctx.keyword;
  const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
  const tocLabel = tocLabelFor(ctx.language);
  const hasFaqH2 = secs.some((s: any) => s.h_level === "H2" && /^faq/i.test(String(s.heading || "").trim()));
  const toc = ctx.includeToc
    ? `<div class="toc"><strong>${tocLabel}</strong><ul>${secs.filter((s: any) => s.h_level === "H2").map((s: any) => `<li><a href="#${slug(String(s.heading))}">${s.heading}</a></li>`).join("")}${faq.length && !hasFaqH2 ? `<li><a href="#faq">FAQ</a></li>` : ""}</ul></div>\n\n`
    : "";
  const body = parts.filter((p): p is string => p != null && p.trim().length > 0).join("\n\n");
  return {
    text: `# ${h1}\n\n${toc}${body}`,
    wroteChunks, totalChunks: chunks.length, missingHeadings, lastError: lastChunkError,
  };
}

// ─── Volume guard (final word on article length) ──────────────────────────────────
// Models undershoot AND overshoot the target, and the auto-fact-clean pass can also nudge
// length while correcting numbers — so this MUST run after every other content-shaping pass,
// never before. Below ~85% of target → one expansion pass. Above ~115% (the plan's own ±15%
// tolerance, tightened from the previous 1.25x which was looser than what users are told to
// expect) → iterative trim passes, looping until within range or the model stops cooperating.
async function enforceVolumeTarget(text: string, targetWc: number, ctx: {
  language: string; provider: string; apiKey: string; model?: string; baseUrl?: string;
}): Promise<string> {
  if (!targetWc || targetWc < 500 || !text) return text;
  // Full-structure invariant: H2 AND H3 counts must survive any volume pass untouched.
  // (H2-only checks let passes "improve" the FAQ — dropping ### questions, adding intros.)
  const allHeadsOf = (s: string) => (s.match(/^#{2,3}\s/gm) || []).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < targetWc * 0.85) {
    try {
      let expanded = await fetchLLM(
        buildTextExpandPrompt({ article: text, targetWords: targetWc, currentWords: words, language: ctx.language }),
        ctx.provider, ctx.apiKey, 14000, ctx.model, ctx.baseUrl,
      );
      if (expanded) {
        expanded = expanded.trim().replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
        const newWords = expanded.split(/\s+/).filter(Boolean).length;
        // Accept only a real improvement that kept EVERY heading (H2+H3, incl. FAQ questions).
        if (newWords > words * 1.1 && allHeadsOf(expanded) === allHeadsOf(text)) {
          text = stripForeignScripts(expanded, ctx.language);
        }
      }
    } catch { /* expansion is best-effort */ }
  } else if (words > targetWc * 1.15) {
    // Verbose models under-cut on the first pass — iterate (max 3, up from 2) until within
    // range. Per-pass acceptance loosened from ≥10% to ≥5% reduction so the guard doesn't give
    // up after one modest cut and ship an article that's still well over budget.
    for (let pass = 0; pass < 3; pass++) {
      const cur = text.split(/\s+/).filter(Boolean).length;
      if (cur <= targetWc * 1.15) break;
      try {
        let trimmed = await fetchLLM(
          buildTextTrimPrompt({ article: text, targetWords: targetWc, currentWords: cur, language: ctx.language }),
          ctx.provider, ctx.apiKey, 14000, ctx.model, ctx.baseUrl,
        );
        if (!trimmed) break;
        trimmed = trimmed.trim().replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
        const newWords = trimmed.split(/\s+/).filter(Boolean).length;
        // Accept any real reduction that kept the FULL structure — H2 AND H3 counts equal
        // (H2-only check let the model "trim" by deleting FAQ ### questions) — and didn't
        // over-cut (still ≥70% of target).
        const allHeads = (s: string) => (s.match(/^#{2,3}\s/gm) || []).length;
        if (newWords < cur * 0.95 && newWords >= targetWc * 0.7 && allHeads(trimmed) === allHeads(text)) {
          text = stripForeignScripts(trimmed, ctx.language);
        } else break; // model refused to cut further / structure changed — stop iterating
      } catch { break; }
    }
  }
  return text;
}

// ─── Article text ─────────────────────────────────────────────────────────────────
export async function genText(b: any): Promise<GenResult> {
  if (!b.outline) return { ok: false, error: "no_outline" };
  const provider = String(b.aiProvider ?? "anthropic");
  const apiKey = String(b.aiApiKey ?? "");
  if (!apiKey) return { ok: false, error: "no_ai_key" };

  const keyword = String(b.keyword ?? b.outline?.meta?.keyword ?? "");
  // Language falls back to the outline's OWN stamped language (genOutline writes it into meta),
  // not to a hard-coded one: a Greek outline that reaches genText without an explicit language
  // must not be instructed to write Russian. Callers that pass a language always win.
  const language = String(b.language ?? b.outline?.meta?.language ?? "en");
  const sourceMode = (b.sourceMode === "facts" || b.sourceMode === "cited") ? b.sourceMode : "off";

  let sources: { title: string; snippet: string; url: string; domain: string }[] = [];
  let effMode: "off" | "facts" | "cited" = sourceMode;
  if (sourceMode !== "off" && b.serpKey && keyword) {
    try {
      const serp = await runSerp(String(b.serpProvider || "serper"), String(b.serpKey), keyword, { gl: b.gl, hl: b.hl, num: 10, engine: "google" });
      const top = (serp.results || []).slice(0, Math.max(1, Math.min(10, Number(b.scrapeCount ?? 6))));
      let scraped: any[] = [];
      try { scraped = await scrapeMany(top.map(r => r.url), b.firecrawlKey ? String(b.firecrawlKey) : undefined, 4); } catch {}
      sources = top.map(r => {
        const sc = scraped.find(s => s.url === r.url);
        const ev = sc?.ok ? `${sc.metaDescription || ""} ${sc.textSample || ""}`.trim().slice(0, 4000) : "";
        return { title: r.title, url: r.url, domain: r.domain, snippet: ev || r.snippet };
      });
    } catch {}
  }
  // Fallback: if no live sources were gathered, ground the text on the facts the outline was built
  // on. Prefer the consolidated facts bank (clean per-source facts); else the raw carried sources.
  if (!sources.length) {
    const bank = Array.isArray(b.outline?.meta?.facts_bank) ? b.outline.meta.facts_bank : [];
    if (bank.length) {
      sources = bank.map((x: any) => ({ title: (x.official ? "[ОФИЦИАЛЬНЫЙ] " : "") + (x.domain || x.source), url: x.source, domain: x.domain || "", snippet: x.facts }));
      effMode = "facts";
    } else {
      const carried = Array.isArray(b.outline?.meta?.sources) ? b.outline.meta.sources : [];
      if (carried.length) { sources = carried; effMode = "facts"; }
    }
  }

  // Slim the outline the writer actually needs: keep meta + sections + faq + price table; drop the
  // heavy analysis blocks (entity_analysis/sub_intents/entities/…) and the carried sources from meta
  // (they're already fed via the sources block) so we don't bloat/duplicate the prompt → no timeouts.
  const full = (b.outline || {}) as any;
  const { sources: _carried, facts_bank: _bank, ...metaSlim } = (full.meta || {});
  void _carried; void _bank;
  
  // Deep-copy to avoid mutating cached memory
  const slimOutline = {
    meta: metaSlim ? JSON.parse(JSON.stringify(metaSlim)) : {},
    sections: full.sections ? JSON.parse(JSON.stringify(full.sections)) : [],
    faq: full.faq ? JSON.parse(JSON.stringify(full.faq)) : [],
    price_table_template: full.price_table_template,
  };

  const secsList: any[] = slimOutline.sections;
  const depth = (s: any) => (s?.h_level === "H4" ? 4 : s?.h_level === "H3" ? 3 : 2);
  const hasKids = (i: number) => i + 1 < secsList.length && depth(secsList[i + 1]) > depth(secsList[i]);

  // 1. Convert FAQ list to H3 sections under the H2 FAQ section
  const faqList = Array.isArray(slimOutline.faq) ? slimOutline.faq : [];
  if (faqList.length > 0) {
    let faqH2Idx = secsList.findIndex((s: any) => s.h_level === "H2" && (/\bfaq\b|frequently asked|questions\s+fréquentes|часто\s+задаваемые/i.test(s.heading)));
    if (faqH2Idx === -1) {
      const faqTitle = "FAQ";
      secsList.push({
        h_level: "H2",
        heading: faqTitle,
        word_count_self: [30, 50],
        word_count_total: [30, 50],
        summary: "Section de foire aux questions.",
        copywriter_notes: "Introduire brièvement la section FAQ."
      });
      faqH2Idx = secsList.length - 1;
    }
    
    const faqSubsections = faqList.map((f: any) => ({
      h_level: "H3",
      heading: f.question,
      word_count_self: [40, 60],
      word_count_total: [40, 60],
      summary: f.answer_guideline || "Répondre à la question.",
      copywriter_notes: `Répondre à la question de manière concise en 40-60 mots.`
    }));
    
    secsList.splice(faqH2Idx + 1, 0, ...faqSubsections);
    slimOutline.faq = [];
  }

  // 2. Trim parent H2 summaries to prevent duplicate text generation and word count overshoot
  for (let i = 0; i < secsList.length; i++) {
    const s = secsList[i];
    if (s.h_level === "H2" && hasKids(i)) {
      s.summary = "Короткое вводное предложение (1-2 предложения) для перехода к подразделам.";
      s.copywriter_notes = "Напиши ровно один короткий вводный абзац (1-2 предложения), чтобы плавно ввести читателя в тему и подготовить переход к подразделам. Не раскрывай конкретные детали подразделов здесь, пиши максимально лаконично.";
    }
  }

  // Volume guard for outlines saved before this fix (or edited by hand): if the sum of
  // section budgets is far below the target word count, rescale so the writer isn't
  // silently capped at a fraction of the plan. Implausibly small targets (junk emitted
  // by the model into meta) are ignored rather than shrinking a healthy outline.
  const textTargetWc = Number(b.targetWordCount) || Number(metaSlim?.target_word_count) || 0;
  const textFaqReserve = Math.min(Math.round(textTargetWc * 0.25), (Array.isArray(slimOutline.faq) ? slimOutline.faq.length : 0) * 50);
  if (textTargetWc >= 500) normalizeWordBudgets(slimOutline, Math.max(300, textTargetWc - textFaqReserve));
  else if (textTargetWc > 0) (slimOutline.meta as any).target_word_count = ownBudgetSum(slimOutline) || textTargetWc;

  // Casino RAG: re-retrieve knowledge-base facts for the text step (fresh + full-length),
  // honoring either the explicit flag or the outline generated with RAG enabled.
  let ragFacts: string | undefined;
  if (b.useRag === true || (b.useRag !== false && full.meta?.use_rag)) {
    const rag = await findRagFacts(keyword || String(full.meta?.keyword ?? ""));
    if (rag) ragFacts = rag.rendered;
  }

  const model = b.model ? String(b.model) : undefined;
  const baseUrl = b.aiBaseUrl ? String(b.aiBaseUrl) : undefined;

  // CHUNKED writer (default on for 10+ sections, off with chunkedText:false): the article is
  // written 3-5 sections per call — one giant prompt degrades mid-generation (prose decays
  // into lists, tables get invented values). Falls back to single-shot if any chunk fails.
  let text: string | null = null;
  let incomplete = false;
  let missingHeadings: string[] = [];
  let chunked: ChunkedTextResult | null = null;
  const secCount = Array.isArray(slimOutline.sections) ? slimOutline.sections.length : 0;
  if (b.chunkedText !== false && b.promptType !== "custom" && secCount >= 10) {
    try {
      chunked = await writeTextInChunks(slimOutline, {
        keyword: keyword || String(slimOutline.meta?.keyword ?? ""),
        language, tone: String(b.tone ?? "neutral, expert"),
        provider, apiKey, model, baseUrl,
        ragFacts, sources, sourceMode: effMode, includeToc: b.includeToc === true,
        temperature: b.temperature === undefined || b.temperature === null ? undefined : Number(b.temperature),
        bannedWords: Array.isArray(b.bannedWords) ? b.bannedWords : undefined,
      });
    } catch { chunked = null; }
  }

  if (chunked?.text) {
    if (chunked.wroteChunks >= chunked.totalChunks) {
      text = chunked.text;
    } else if (chunked.wroteChunks >= Math.ceil(chunked.totalChunks * 0.7)) {
      // Most of the article exists and has already been paid for. Rewriting it single-shot would
      // spend the budget a second time AND produce worse prose — one giant prompt is precisely
      // the degradation the chunked writer exists to avoid. Ship what was written, name what was
      // not, and let the caller regenerate just the gap.
      text = chunked.text;
      incomplete = true;
      missingHeadings = chunked.missingHeadings;
      console.error(`[text] shipping incomplete article: ${chunked.wroteChunks}/${chunked.totalChunks} chunks, missing: ${missingHeadings.join(" | ")}`);
    }
  }

  if (!text) {
    // Errors the provider has already told us not to retry — an empty wallet, a bad key, an
    // oversized body. A single-shot attempt after those spends minutes to fail identically, so
    // the chunk failures' own reason is returned instead.
    if (/\b(401|402|403|413)\b|insufficient_balance|invalid_api_key/i.test(chunked?.lastError || "")) {
      return { ok: false, error: `generation_failed: ${chunked!.lastError}` };
    }
    const prompt = buildTextPrompt({
      outlineJson: slimOutline,
      policy: b.policy,
      tone: String(b.tone ?? "neutral, expert"),
      language,
      custom: b.custom ? String(b.custom) : undefined,
      promptType: b.promptType === "custom" ? "custom" : "service",
      sources,
      sourceMode: effMode,
      includeToc: b.includeToc === true,
      ragFacts,
      bannedWords: Array.isArray(b.bannedWords) ? b.bannedWords : undefined,
    });
    // Detailed variant here (not the plain fetchLLM used elsewhere): this is the last-resort
    // single-shot attempt — if it also fails, its error detail (e.g. a provider content-policy
    // rejection like z.ai's "potentially unsafe or sensitive content") is what we surface below,
    // instead of a bare "generation_failed" that sends users digging through server logs.
    const r = await fetchLLMDetailed(prompt, provider, apiKey, 12000, model, baseUrl,
      b.temperature === undefined || b.temperature === null ? undefined : Number(b.temperature));
    text = r.text;
    // Prefer the single-shot's own reason, but fall back to the chunk writer's — when the
    // chunked path is the one that did the real work, its error is the informative one.
    const why = r.error || chunked?.lastError;
    if (!text) return { ok: false, error: why ? `generation_failed: ${why}` : "generation_failed" };
  }
  if (!text) return { ok: false, error: "generation_failed" };

  const banned = [
    ...String(b.policy?.restrictions?.wordsToAvoid ?? "").split(","),
    ...String(b.policy?.restrictions?.topicsToAvoid ?? "").split(","),
  ];
  text = enforceLinkPolicy(text, banned, effMode);

  let redacted = 0;
  if (b.hardRedact) { const r = redactBannedWords(text, banned); text = r.text; redacted = r.count; }

  text = stripForeignScripts(text, language);

  // AUTO fact-clean: verify the finished article against the facts bank and fix contradictions /
  // fabrications / number mismatches in one pass — so the article ships clean (fact-check then just
  // confirms). Runs BEFORE the volume guard (moved from after it): fact-clean can add clarifying
  // words while correcting numbers, and previously ran last with only a floor check on character
  // length (>85%) — nothing stopped it from silently re-inflating an article the guard had just
  // trimmed back to budget. The guard now always gets the last word on length. Best-effort: if it
  // fails, keep the original text. Toggle off with autoFactCheck:false.
  let autoCleaned = false;
  const bank = Array.isArray(b.outline?.meta?.facts_bank) ? b.outline.meta.facts_bank : [];
  if (b.autoFactCheck !== false && bank.length && text) {
    try {
      const bankText = bank.map((x: any, i: number) => `[${i + 1}]${x.official ? " (ОФИЦИАЛЬНЫЙ)" : ""} ${x.domain || x.source}\n${x.facts}`).join("\n\n");
      let cleaned = await fetchLLM(buildAutoFactCleanPrompt({ article: text, factsBank: bankText, language }), provider, apiKey, 12000, model, baseUrl);
      if (cleaned && cleaned.trim().length > text.length * 0.85) {
        cleaned = cleaned.trim().replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
        // Structure invariant: every heading (H2+H3, incl. FAQ questions) must survive.
        const heads = (s: string) => (s.match(/^#{2,3}\s/gm) || []).length;
        if (heads(cleaned) === heads(text)) {
          text = stripForeignScripts(cleaned, language);
          autoCleaned = true;
        }
      }
    } catch { /* keep original text */ }
  }

  // VOLUME guard (default on, symmetric) — see enforceVolumeTarget() above. Runs LAST, after
  // fact-clean, so it's the final word on article length. Off with expandText:false.
  // Skipped when sections are missing: the guard would read the gap as "the writer undershot"
  // and pad the surviving sections to cover words that belong to text nobody wrote.
  const finalTargetWc = Number(b.targetWordCount) || Number(slimOutline.meta?.target_word_count) || 0;
  if (b.expandText !== false && finalTargetWc >= 500 && !incomplete) {
    text = await enforceVolumeTarget(text, finalTargetWc, { language, provider, apiKey, model, baseUrl });
  }

  // Guarantee the SEO meta block is present (deterministic — don't trust the model to emit it).
  text = ensureMetaBlock(text, b.outline?.meta);
  // Guarantee the TOC label matches the article's language (deterministic — the writer, or any
  // later expand/trim/fact-clean pass, could otherwise leave/reintroduce a wrong-language word).
  text = ensureTocLabel(text, language);

  return {
    ok: true,
    data: {
      text, usedSources: sources.length, redacted, autoCleaned,
      // Present only when sections are genuinely absent, so existing consumers see the same
      // shape they always did for a complete article.
      ...(incomplete ? { incomplete: true, missingHeadings, chunkError: chunked?.lastError } : {}),
    },
  };
}

// Safety net: models occasionally leak characters from another writing system into the article
// (e.g. a stray Chinese token in an English text). Strip CJK/kana/hangul runs when the target
// language doesn't use them, then tidy the spacing/punctuation left behind.
// Guarantee the SEO meta block (Title/Description/Slug) sits at the very top of the article.
// The model is asked to emit it, but doesn't always comply — so we add it deterministically from
// the outline meta if it's missing (the data is known, no need to trust the LLM for this).
export function ensureMetaBlock(text: string, meta: any): string {
  if (!text) return text;
  const firstHeading = text.search(/^#{1,6}\s/m);
  const head = firstHeading > 0 ? text.slice(0, firstHeading) : (firstHeading === 0 ? "" : text);
  if (/(^|\n)\s*(```)?\s*title\s*:/i.test(head)) return text; // already has a meta block
  const pick = (v: any) => Array.isArray(v) ? (v.find((x: any) => x && String(x).trim()) || "") : (v || "");
  const title = pick(meta?.title_options) || pick(meta?.title);
  const desc = pick(meta?.description_options) || pick(meta?.description);
  const slug = pick(meta?.slug_options) || pick(meta?.slug);
  if (!title && !desc && !slug) return text;
  const block = "```\nTitle: " + title + "\nMeta Description: " + desc + "\nURL Slug: " + slug + "\n```";
  return block + "\n\n" + text.replace(/^\s+/, "");
}

export function stripForeignScripts(text: string, language: string): string {
  if (/^(zh|ja|ko)/i.test(language || "")) return text; // target language legitimately uses these
  if (!/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/.test(text)) return text;
  return text
    .replace(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.:;!?])/g, "$1")
    .replace(/([:：])\s+([.,;!?])/g, "$2");
}

// ─── Wireframe (Landing-flow block skeleton) ─────────────────────────────────────
export async function genWireframe(b: any): Promise<GenResult> {
  if (!b.outline) return { ok: false, error: "no_outline" };
  const provider = String(b.aiProvider ?? "anthropic");
  const apiKey = String(b.aiApiKey ?? "");
  if (!apiKey) return { ok: false, error: "no_ai_key" };
  const model = b.model ? String(b.model) : undefined;
  const baseUrl = b.aiBaseUrl ? String(b.aiBaseUrl) : undefined;

  const prompt = buildWireframePrompt({
    keyword: String(b.keyword ?? b.outline?.meta?.keyword ?? ""),
    language: String(b.language ?? b.outline?.meta?.language ?? "en"),
    country: String(b.country ?? b.outline?.meta?.country ?? "us"),
    outline: b.outline,
    structureMode: b.structureMode,
    myStructure: Array.isArray(b.myStructure) ? b.myStructure : undefined,
    targetWordCount: b.targetWordCount ? Number(b.targetWordCount) : undefined,
  });

  let raw = await fetchLLM(prompt, provider, apiKey, 8000, model, baseUrl);
  let wireframe = extractJson(raw);
  if (!wireframe || !Array.isArray((wireframe as any).blocks)) {
    raw = await fetchLLM(prompt + "\n\nПредыдущий ответ не распарсился. Верни ТОЛЬКО валидный JSON, без текста и без markdown-обёрток.", provider, apiKey, 8000, model, baseUrl);
    wireframe = extractJson(raw);
  }
  if (!wireframe || !Array.isArray((wireframe as any).blocks)) return { ok: false, error: "parse_failed" };
  return { ok: true, data: wireframe };
}

// ─── Landing-flow orchestrator: ТЗ (+ wireframe) (+ текст), per "что генерировать" ───
// b.generate: "tz" | "tz_text" | "tz_wireframe" | "all" (default "tz_wireframe", matches the
// reference tool's Landing-flow which always ships a wireframe alongside the ТЗ).
export async function genLanding(b: any): Promise<GenResult> {
  const want = String(b.generate || "tz_wireframe");
  const wantsWireframe = want === "tz_wireframe" || want === "all";
  const wantsText = want === "tz_text" || want === "all";

  const outlineRes = await genOutline(b);
  if (!outlineRes.ok) return outlineRes;
  const outline = outlineRes.data;

  const result: any = { outline };

  if (wantsWireframe) {
    const wfRes = await genWireframe({ ...b, outline });
    if (wfRes.ok) result.wireframe = wfRes.data;
    else result.wireframeError = wfRes.error;
  }

  if (wantsText) {
    const textRes = await genText({ ...b, outline });
    if (textRes.ok) result.text = (textRes.data as any)?.text ?? textRes.data;
    else result.textError = textRes.error;
  }

  return { ok: true, data: result };
}

// ─── Content analysis ──────────────────────────────────────────────────────────────
export async function genAnalysis(b: any): Promise<GenResult> {
  const keyword = String(b.keyword ?? "").trim();
  if (!keyword) return { ok: false, error: "no_keyword" };
  if (!b.targetPage) return { ok: false, error: "no_target_page" };
  const provider = String(b.aiProvider ?? "anthropic");
  const apiKey = String(b.aiApiKey ?? "");
  if (!apiKey) return { ok: false, error: "no_ai_key" };

  const competitors: CompetitorInput[] = Array.isArray(b.competitors) ? b.competitors : [];
  const prompt = buildAnalysisPrompt({
    keyword, targetPage: b.targetPage, competitors,
    language: b.language ? String(b.language) : undefined,
    country: b.country ? String(b.country) : undefined,
    policy: b.policy || undefined,
  });
  const model = b.model ? String(b.model) : undefined;
  const baseUrl = b.aiBaseUrl ? String(b.aiBaseUrl) : undefined;

  let raw = await fetchLLM(prompt, provider, apiKey, 16000, model, baseUrl);
  let report = extractJson(raw);
  if (!report) {
    raw = await fetchLLM(prompt + "\n\nПредыдущий ответ не распарсился. Верни ТОЛЬКО валидный JSON.", provider, apiKey, 16000, model, baseUrl);
    report = extractJson(raw);
  }
  if (!report) return { ok: false, error: "parse_failed" };
  return { ok: true, data: report };
}

// ─── Fully-automated outline: SERP → scrape → outline in ONE server-side job ───────
// The interactive Outline page does SERP+scrape client-side (user picks competitors);
// batch generation from clusters can't stop for that — this wrapper does the whole
// pipeline unattended: top-10, scrape the best pages, then the regular genOutline.
export async function genOutlineAuto(b: any): Promise<GenResult> {
  const keyword = String(b.keyword ?? "").trim();
  if (!keyword) return { ok: false, error: "no_keyword" };
  if (!b.serpKey) return { ok: false, error: "no_serp_key" };
  const serp = await runSerp(String(b.serpProvider || "serper"), String(b.serpKey), keyword, {
    gl: b.gl ?? b.country, hl: b.hl ?? b.language, num: 10, engine: "google",
  });
  if (serp.error || !serp.results?.length) return { ok: false, error: serp.error || "serp_failed" };
  const results = serp.results.slice(0, 10);
  let pages: any[] = [];
  try { pages = await scrapeMany(results.map(r => r.url), b.firecrawlKey ? String(b.firecrawlKey) : undefined, 4); } catch { /* outline can run on titles alone */ }
  const competitors: CompetitorInput[] = results.map(r => {
    const p = pages.find((x: any) => x.url === r.url);
    return {
      position: r.position, url: r.url,
      site_type: heuristicSiteType(r.domain, r.url, r.title) || undefined,
      intent: heuristicIntent(r.url, r.title),
      title: p?.title || r.title, headings: p?.headings || [],
      word_count: p?.wordCount || 0, has_price_table: !!p?.hasPriceTable, has_faq: !!p?.hasFaq,
      text_sample: p?.textSample || undefined,
    };
  });
  return genOutline({
    ...b, competitors,
    paa: serp.peopleAlsoAsk, related: serp.relatedSearches,
    country: b.country ?? b.gl, language: b.language ?? b.hl,
  });
}

// ─── SERP-based keyword clustering ────────────────────────────────────────────────
// Groups keywords by TOP-10 URL overlap — Google's own view of "same topic", more reliable
// than embeddings for SEO page planning. Hard clustering against the cluster seed (the
// highest-volume unassigned keyword): kw joins if it shares ≥ threshold URLs with the seed.
const normUrl = (u: string) => {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname).replace(/\/+$/, "").toLowerCase(); }
  catch { return u.toLowerCase(); }
};

/**
 * Volumes for a cluster run, through the shared keyword source.
 *
 * This replaces a fourth private DataForSEO client that lived here with its own location table
 * and its own `?? 2840` fallback — the one that silently ordered a Bosnian keyword set by
 * American demand. Going through `enrichKeywords` buys three things at once: the market is
 * validated instead of guessed, whatever is already in the shared cache costs nothing, and a
 * user on Ahrefs finally gets volumes here at all.
 *
 * Still optional and still non-fatal: clusters without volumes are ordered by member count
 * instead, which is a visibly weaker answer rather than a confidently wrong one.
 */
async function fetchClusterVolumes(
  creds: { source: KwSource; apiKey: string; baseUrl?: string },
  keywords: string[], gl: string, hl: string,
): Promise<{ volumes: Record<string, number>; error?: string }> {
  const country = (gl || "").trim().toLowerCase();
  if (!country) return { volumes: {}, error: "no_country" };

  const out: Record<string, number> = {};
  try {
    const res = await enrichKeywords(creds, keywords, {
      country, language: hl || "en", fetch: true,
    });
    for (const r of res.rows) {
      if (r.volume != null) out[r.keyword] = r.volume;
    }
    return { volumes: out, error: res.error };
  } catch (e: any) {
    return { volumes: out, error: String(e?.message ?? e) };
  }
}

export async function genCluster(b: any): Promise<GenResult> {
  const keywords: string[] = [...new Set((Array.isArray(b.keywords) ? b.keywords : [])
    .map((k: any) => String(k).trim().toLowerCase()).filter(Boolean))].slice(0, 1000) as string[];
  if (keywords.length < 2) return { ok: false, error: "no_keywords" };
  const serpKey = String(b.serpKey ?? "");
  if (!serpKey) return { ok: false, error: "no_serp_key" };
  const provider = String(b.serpProvider ?? "serper");
  const gl = String(b.gl ?? "us"), hl = String(b.hl ?? "en");
  const threshold = Math.max(2, Math.min(6, Number(b.threshold ?? 3)));

  // 1) volumes (optional) — through the shared source, so Ahrefs and Semrush work here too.
  //    `kwSource`/`kwKey` are the new fields; `dfsKey` is still honoured so a job queued before
  //    this change, or a caller not yet updated, keeps working exactly as it did.
  const kwSource: KwSource = ["ahrefs", "semrush", "dataforseo"].includes(String(b.kwSource))
    ? String(b.kwSource) as KwSource
    : b.dfsKey ? "dataforseo" : "off";
  const kwKey = String(b.kwKey ?? b.dfsKey ?? "");

  const vres = kwSource !== "off" && kwKey
    ? await fetchClusterVolumes({ source: kwSource, apiKey: kwKey, baseUrl: b.kwBaseUrl ? String(b.kwBaseUrl) : undefined }, keywords, gl, hl)
    : { volumes: {} as Record<string, number>, error: undefined as string | undefined };
  const volumes = vres.volumes;

  // 2) TOP-10 per keyword (bounded concurrency)
  const serps: Record<string, { urls: string[]; titles: string[] }> = {};
  const failed: string[] = [];
  await runPool(keywords, 4, async (kw) => {
    const r = await runSerp(provider, serpKey, kw, { gl, hl, num: 10, engine: "google" });
    if (r.error || !r.results?.length) { failed.push(kw); return; }
    serps[kw] = { urls: r.results.slice(0, 10).map(x => normUrl(x.url)), titles: r.results.slice(0, 5).map(x => x.title) };
  });
  const usable = keywords.filter(k => serps[k]);
  if (usable.length < 2) return { ok: false, error: "serp_failed" };

  // 3) hard clustering against seeds, richest keyword first
  const vol = (k: string) => volumes[k] ?? 0;
  const sorted = [...usable].sort((a, z) => vol(z) - vol(a));
  const assigned = new Set<string>();
  const clusters: any[] = [];
  for (const seed of sorted) {
    if (assigned.has(seed)) continue;
    assigned.add(seed);
    const seedUrls = new Set(serps[seed].urls);
    const members = [{ keyword: seed, volume: vol(seed), overlap: 10 }];
    for (const kw of sorted) {
      if (assigned.has(kw)) continue;
      const overlap = serps[kw].urls.filter(u => seedUrls.has(u)).length;
      if (overlap >= threshold) { assigned.add(kw); members.push({ keyword: kw, volume: vol(kw), overlap }); }
    }
    clusters.push({
      name: seed,
      intent: heuristicIntent(serps[seed].urls[0], serps[seed].titles[0]),
      volume: members.reduce((a, m) => a + m.volume, 0),
      keywords: members,
      top_domains: [...new Set(serps[seed].urls.map(u => u.split("/")[0]))].slice(0, 6),
    });
  }
  clusters.sort((a, z) => z.volume - a.volume || z.keywords.length - a.keywords.length);

  return {
    ok: true,
    data: {
      params: {
        gl, hl, threshold, total_keywords: keywords.length, clustered: usable.length, failed,
        // Travels with the result so the UI can say "clusters are ordered by keyword count, not
        // by demand" instead of showing a column of zeroes that looks like real data.
        ...(vres.error ? { volumes_error: vres.error } : {}),
      },
      clusters,
      generated_at: new Date().toISOString(),
    },
  };
}

export function genByType(type: string, payload: any): Promise<GenResult> {
  if (type === "outline") return genOutline(payload);
  if (type === "text") return genText(payload);
  if (type === "analysis") return genAnalysis(payload);
  if (type === "landing") return genLanding(payload);
  if (type === "cluster") return genCluster(payload);
  if (type === "outline_auto") return genOutlineAuto(payload);
  return Promise.resolve({ ok: false, error: "unknown_job_type" });
}
