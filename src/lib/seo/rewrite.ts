// Content Rewriter — rewrites an article (pasted text OR a URL) into N unique variants using
// the user's own multi-provider AI (Anthropic / OpenAI / Kimi / …, via fetchLLM). For each
// variant it can mask common "AI tells" and reports a uniqueness score vs the source. Built to
// refresh decaying pages and avoid duplicate content across a large affiliate network.

import { fetchLLM } from "@/lib/llm";
import { scrapeMany } from "@/lib/seo/scrape";
import { factDrift, type FactDrift } from "@/lib/seo/factDrift";

export interface RewriteBody {
  text?: string;
  url?: string;
  variants?: number;
  language?: string;        // target language NAME (e.g. "Greek"); empty = keep source language
  tone?: string;            // optional tone hint
  maskAI?: boolean;         // strip common AI patterns (default true)
  bannedWords?: string[];   // domain vocabulary to avoid AT GENERATION TIME (see note below)
  temperature?: number;     // sampling temperature; undefined = provider default
  aiProvider?: string;
  aiApiKey?: string;
  model?: string;
  aiBaseUrl?: string;
  firecrawlKey?: string;
}

// `drift` is computed here rather than in the browser because in URL mode the source text only
// exists on the server — the client never sees what was scraped, so it could not check it.
export interface RewriteVariant { content: string; uniqueness: number; words: number; drift: FactDrift }
export interface RewriteResult {
  ok: boolean;
  error?: string;
  data?: { sourceChars: number; sourceWords: number; title?: string; variants: RewriteVariant[] };
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

// ─── Uniqueness = 1 − word-trigram Jaccard similarity vs the source ─────────────
function shingles(s: string, n = 3): Set<string> {
  const w = s.toLowerCase().replace(/<[^>]+>/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const set = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) set.add(w.slice(i, i + n).join(" "));
  return set;
}
function uniquenessPct(source: string, rewritten: string): number {
  const A = shingles(source), B = shingles(rewritten);
  if (!A.size || !B.size) return 100;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  const sim = union ? inter / union : 0;
  return Math.max(0, Math.min(100, Math.round((1 - sim) * 100)));
}
const wordCount = (s: string) => (s.replace(/<[^>]+>/g, " ").match(/[\p{L}\p{N}]+/gu) || []).length;

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const worker = async () => { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// Pasted text and scraped pages get different budgets. A full landing page runs well past 14k
// characters, and truncating it there silently dropped everything below the fold — the rewrite came
// back "complete" while covering only the top third of the page.
const MAX_CHARS = 14_000;
const MAX_CHARS_URL = 40_000;

export async function rewriteContent(b: RewriteBody): Promise<RewriteResult> {
  const provider = String(b.aiProvider ?? "anthropic");
  const apiKey = String(b.aiApiKey ?? "");
  if (!apiKey) return { ok: false, error: "no_ai_key" };

  // Resolve source content: pasted text, or scrape the URL.
  let text = (b.text ?? "").trim();
  let title = "";
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
  const toneLine = b.tone ? `Tone: ${b.tone}.` : "";

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
    ? `Preserve the heading structure EXACTLY: same number of headings, same levels (# / ## / ###), same order. Rewrite heading text, never drop, merge, split or reorder a heading. Keep every markdown table with all its rows. `
    : "";

  const basePrompt = (i: number) =>
    `You are an expert SEO copywriter. Rewrite the content below so it is UNIQUE and original, ` +
    `while preserving the exact meaning, all facts, numbers, named entities, and links. ` +
    `Keep the same format as the input (HTML stays HTML, Markdown stays Markdown, plain stays plain). ` +
    `${structureLine}${langLine} ${toneLine} ${bannedLine}` +
    (variants > 1 ? `This is variant #${i + 1} — make it clearly different from the other variants. ` : "") +
    `Output ONLY the rewritten content, with no preamble, notes, or explanations.\n\n` +
    `CONTENT:\n${source}`;

  const results = await pool(Array.from({ length: variants }), 2, async (_x, i) => {
    const raw = await fetchLLM(basePrompt(i), provider, apiKey, 8000, b.model || undefined, b.aiBaseUrl || undefined, b.temperature);
    let content = (raw ?? "").trim();
    // Strip a leading code fence the model sometimes wraps around HTML/MD.
    content = content.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    if (!content) return null;
    if (b.maskAI !== false) content = maskAIPatterns(content);
    return { content, uniqueness: uniquenessPct(source, content), words: wordCount(content), drift: factDrift(source, content) };
  });

  const variantsOut = results.filter((r): r is RewriteVariant => !!r);
  if (!variantsOut.length) return { ok: false, error: "generation_failed" };

  return { ok: true, data: { sourceChars: source.length, sourceWords: wordCount(source), title: title || undefined, variants: variantsOut } };
}
