// N7 — HOW an AI answer talks about the brand, not just whether it names it.
//
// Pure logic plus one LLM call; no Prisma, no network beyond fetchLLM. The tracker already
// stores the full answer text, so sentiment is one cheap call per answer over data that was
// already paid for — which is also why it stays behind an explicit button (or the per-site
// opt-in toggle): "cheap" is not "free", and the user's AI credits are the user's.
//
// Input discipline, straight from the brief: the model never sees the whole answer. It sees the
// fragments around the brand's mentions (±2 sentences, ≤ 1500 chars total) — enough context to
// judge tone, not a second opportunity to re-answer the question.

import { fetchLLM } from "@/lib/llm";

export type Sentiment = "positive" | "neutral" | "negative" | "mixed";
export const SENTIMENTS: readonly Sentiment[] = ["positive", "neutral", "negative", "mixed"];

export interface SentimentVerdict {
  sentiment: Sentiment;
  /** -1..1; null when the model did not give a usable number (null ≠ 0 ≠ neutral). */
  score: number | null;
  /** ≤ 300 chars, in the answer's language — what the answer actually says about the brand. */
  note: string;
}

// ─── mention detection (same rules as sov.ts, spelled locally) ────────────────

// NFD + strip combining marks: é→e, ё→е, ά→α. The comparison is case- and diacritics-blind
// because brand spellings drift ("Café" vs "cafe") and a missed mention is a missed fragment.
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NOT_WORD_CHAR = "[^\\p{L}\\p{N}]";

function sentenceMentions(sentence: string, terms: string[]): boolean {
  for (const term of terms) {
    const t = term.trim();
    // Terms shorter than 3 chars light up everywhere — ignored, same threshold as sov.ts.
    if (t.length < 3) continue;
    try {
      if (new RegExp(`(^|${NOT_WORD_CHAR})${escapeRe(fold(t))}($|${NOT_WORD_CHAR})`, "u").test(fold(sentence))) return true;
    } catch {
      if (fold(sentence).includes(fold(t))) return true;
    }
  }
  return false;
}

// ─── fragments ────────────────────────────────────────────────────────────────

/**
 * Sentence split tolerant of the languages this app meets. Latin terminal punctuation
 * (. ! ? …) needs following whitespace — that keeps "3.14" and "example.com" whole; the CJK
 * terminals (。！？) do not, because CJK is not written with spaces. Newlines always split
 * (every engine formats answers with them).
 */
export function splitSentences(text: string): string[] {
  return (text || "")
    .split(/(?<=[.!?…])\s+|(?<=[。！？])\s*|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

export interface FragmentOptions {
  /** Sentences of context on each side of a mentioning sentence. Brief: 2. */
  around?: number;
  /** Hard cap on the assembled fragment text. Brief: 1500 chars. */
  maxChars?: number;
}

/**
 * The text sent to the model: every window of ±`around` sentences around a sentence that
 * mentions any of `terms`, overlapping windows merged, then capped at `maxChars` (the cap cuts
 * the END, keeping the earliest fragments — answer engines front-load what they want to say).
 * Returns "" when nothing mentions any term — the caller then knows there is nothing to analyse.
 */
export function sentimentFragments(answerText: string, terms: string[], opts: FragmentOptions = {}): string {
  const around = Math.max(0, Math.min(5, Math.round(opts.around ?? 2)));
  const maxChars = Math.max(200, Math.round(opts.maxChars ?? 1500));
  const sentences = splitSentences(answerText);
  if (!sentences.length) return "";

  // Merged [start, end] sentence ranges covering every mention with context.
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (!sentenceMentions(sentences[i]!, terms)) continue;
    const start = Math.max(0, i - around);
    const end = Math.min(sentences.length - 1, i + around);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev.end + 1) prev.end = Math.max(prev.end, end); // touching/overlap → one window
    else ranges.push({ start, end });
  }
  if (!ranges.length) return "";

  const parts: string[] = [];
  for (const r of ranges) parts.push(sentences.slice(r.start, r.end + 1).join(" "));
  const joined = parts.join(" … ");
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars - 1).replace(/\s+\S*$/, "") + "…";
}

// ─── prompt ───────────────────────────────────────────────────────────────────

export interface SentimentTarget {
  /** Display name; for the site itself this is the host. */
  name: string;
  /** Brand spellings whose mentions the verdict is about. */
  terms: string[];
}

function verdictFormat(single: boolean, targets: SentimentTarget[]): string {
  const one = `{"sentiment":"positive|neutral|negative|mixed","score":-1..1,"note":"what the text says about the brand, ≤ 300 chars"}`;
  if (single) return `Return STRICT JSON, nothing else:\n${one}\n`;
  const comp = targets.slice(1).map(t => `"${t.name}": {…same shape…}`).join(", ");
  return `Return STRICT JSON, nothing else:\n` +
    `{"target": {…your brand, judged above…}, "competitors": {${comp}}}\n` +
    `Use the exact competitor names as keys. If the fragments do not mention a brand at all, ` +
    `return null as its value.\n`;
}

/**
 * One prompt for one answer. `targets[0]` is the site itself — its verdict is what gets
 * persisted; the rest are competitors, whose verdicts are returned to the caller (the SOV
 * panel) but have no column of their own, so they exist only for this run.
 */
export function sentimentPrompt(fragments: string, targets: SentimentTarget[], language: string | null): string {
  const list = targets.map(t => `- ${t.name} (spellings: ${t.terms.join(", ") || t.name})`).join("\n");
  const langLine = language
    ? `Write the "note" in the language of the fragments (expected: ${language}). `
    : `Write the "note" in the language of the fragments. `;
  return (
    `You analyse fragments of an answer that an AI search engine gave to a user's question. ` +
    `Judge ONLY how the fragments talk about the brands listed below — not whether the answer is ` +
    `good, not the topic in general, and never invent facts that are not in the fragments.\n\n` +
    `Brands:\n${list}\n\n` +
    `"positive" = praise, recommendation, trust. "negative" = complaints, warnings, distrust. ` +
    `"mixed" = both clearly present. "neutral" = neither — a bare mention.\n` +
    `"score" is -1 (very negative) .. 1 (very positive).\n` +
    `${langLine}Keep "note" ≤ 300 characters.\n\n` +
    verdictFormat(targets.length === 1, targets) +
    `\nFRAGMENTS:\n${fragments}`
  );
}

// ─── reply parsing ────────────────────────────────────────────────────────────

function clampScore(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  // Out of range is CLAMPED, not rejected — a model saying score 7 for a glowing paragraph is
  // confident, not wrong about the direction. Unparseable stays null (null ≠ 0).
  return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : null;
}

/** Parse one verdict object. Garbage → null; score clamped; note trimmed to 300 chars. */
export function parseSentimentVerdict(v: unknown): SentimentVerdict | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const sentiment = String(o.sentiment ?? "").trim().toLowerCase();
  if (!(SENTIMENTS as readonly string[]).includes(sentiment)) return null;
  return {
    sentiment: sentiment as Sentiment,
    score: clampScore(o.score),
    note: String(o.note ?? "").trim().slice(0, 300),
  };
}

/** Pull the first {...} out of a raw model string (fences, leading prose, trailing chatter). */
function jsonish(raw: string): unknown {
  const s = raw.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export interface MultiBrandSentiment {
  target: SentimentVerdict | null;
  competitors: Record<string, SentimentVerdict | null>;
}

/**
 * Parse the model's reply for one answer. Accepts the multi-brand shape ({target, competitors})
 * and the flat single-brand shape ({"sentiment",…} — what a model answering the one-brand prompt
 * sometimes returns even when several brands were listed). Returns null when there is nothing
 * usable at all: the caller then leaves the row's sentiment null ("not analysed", not "neutral").
 */
export function parseSentimentReply(raw: unknown, competitorNames: string[] = []): MultiBrandSentiment | null {
  let v: unknown = raw;
  if (typeof raw === "string") v = jsonish(raw);
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;

  // Flat shape → the target verdict, competitors unknowable.
  const flat = parseSentimentVerdict(o);
  if (flat) return { target: flat, competitors: {} };

  const target = o.target === null ? null : parseSentimentVerdict(o.target);
  const competitors: Record<string, SentimentVerdict | null> = {};
  const comp = (o.competitors && typeof o.competitors === "object" ? o.competitors : {}) as Record<string, unknown>;
  for (const name of competitorNames) {
    if (!(name in comp)) continue;
    competitors[name] = comp[name] === null ? null : parseSentimentVerdict(comp[name]);
  }
  if (!target && !Object.keys(competitors).length) return null;
  return { target, competitors };
}

// ─── the call ─────────────────────────────────────────────────────────────────

export interface SentimentCreds {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/**
 * Rough token budget per answer — shown BEFORE the run so the price is visible, per the wave
 * rules. ~1500 chars of fragments ≈ 375 tokens + prompt overhead ≈ 150 + JSON reply ≈ 80,
 * rounded up: a model that thinks costs more than this, never less.
 */
export const SENTIMENT_PER_ANSWER_TOKENS = 600;

export function estimateSentimentTokens(answers: number): number {
  return Math.max(0, Math.round(answers)) * SENTIMENT_PER_ANSWER_TOKENS;
}

/**
 * One LLM call for one stored answer. Returns null when there is no fragment to judge (the
 * brand is not in the text — nothing to spend on) or the model answered garbage; both leave the
 * row's sentiment untouched at null.
 *
 * Provider/model come from the SEO Tools settings via the same per-task "judge" slot the QA
 * judge resolves against — the cheapest slot the operator has deliberately configured for
 * exactly this kind of small verdict call.
 */
export async function askSentiment(
  creds: SentimentCreds,
  answerText: string,
  targets: SentimentTarget[],
  language: string | null,
): Promise<MultiBrandSentiment | null> {
  const allTerms = [...new Set(targets.flatMap(t => t.terms))];
  const fragments = sentimentFragments(answerText, allTerms);
  if (!fragments) return null;

  const raw = await fetchLLM(
    sentimentPrompt(fragments, targets, language),
    creds.provider,
    creds.apiKey,
    400,
    creds.model,
    creds.baseUrl,
    0, // deterministic — a tone measurement must not vary between runs
  );
  if (!raw) return null;
  return parseSentimentReply(raw, targets.slice(1).map(t => t.name));
}
