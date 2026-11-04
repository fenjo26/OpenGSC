// Originality against siblings — a local proxy for "does this page carry information its
// near-twins do not".
//
// Why this exists next to the AI-fingerprint score and not inside it: the two measure different
// axes that move independently. A page can read 0% machine and still be a template with the city
// name swapped — the roofer case from the Content Warehouse leak discussion was entirely human
// text that Google refused to index. Rewording does not fix that, because paraphrase changes the
// words and adds no facts. What got those pages indexed was new substance: real jobs per city,
// real reviews, a data table, page-specific subheadings and anchors.
//
// So the report has two layers, and the UI shows both because they fail differently:
//
//   - shingle gain: share of the text's 3-word shingles that no sibling contains. Catches
//     copy-paste. Paraphrase inflates it, and that weakness is stated, not hidden.
//   - substance gain: numbers and identifiers (the factDrift extractors) that no sibling contains,
//     scaled by length. Paraphrase cannot fake it — only new facts move it.
//
// Plus structure flags (table, unique subheadings, unique anchors) — the three things the case
// study added.
//
// What this is NOT: Google's originalContentScore. That is an internal encoding (7 bits for short
// pages, a wider range for long ones) nobody outside can query. This measures the property it is
// believed to describe, against siblings the operator chooses. Pure, Prisma-free, no network.

import { normalizeForDiff, tokenize } from "./textSimilarity";
import { criticalValues } from "./factDrift";

export const ORIG_SHINGLE = 3;
/** Jaccard to the closest sibling at or above which the page is a near-duplicate outright —
 *  the same line the Site Audit uses (NEAR_DUPLICATE_THRESHOLD in lib/audit/duplicates.ts). */
export const ORIG_NEAR_DUP = 0.8;
/** Below this many words a page has too little text to prove uniqueness — the leak's point that
 *  short content gets a smaller range. Reported as a note, not hidden in the score. */
export const ORIG_SHORT_WORDS = 300;
/** Unique facts per 1000 words that count as "full" substance. Five per 300-word block is what a
 *  real per-city block with a job, a price, a date and a review tends to carry. */
export const ORIG_FACTS_PER_1K = 8;

export type OriginalityBand = "template" | "borderline" | "original";

export interface OriginalityReport {
  words: number;
  /** Siblings that had enough text to compare against. */
  siblings: number;
  short: boolean;
  shingles: {
    total: number;
    unique: number;
    /** unique / total, 0..1 */
    gain: number;
    /** Jaccard to the most similar sibling, 0..1 */
    maxSimilarity: number;
    /** index into the siblings array passed in, -1 when none */
    closest: number;
  };
  substance: {
    /** Facts in this text that appear on no sibling — the evidence of originality. */
    unique: string[];
    /** Facts this text shares with at least one sibling. */
    shared: number;
    per1k: number;
    /** 0..1, saturating at ORIG_FACTS_PER_1K */
    gain: number;
  };
  structure: {
    hasTable: boolean;
    headings: number;
    uniqueHeadings: string[];
    anchors: number;
    uniqueAnchors: string[];
  };
  /** 0..100 */
  score: number;
  band: OriginalityBand;
}

function shingles(text: string): Set<string> {
  const t = tokenize(normalizeForDiff(text));
  const out = new Set<string>();
  for (let i = 0; i + ORIG_SHINGLE <= t.length; i++) out.add(t.slice(i, i + ORIG_SHINGLE).join(" "));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of s) if (l.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// A bare single digit ("3 steps", "1 hour") is on every page of every niche; counting it as an
// original fact would let a template "prove" uniqueness by numbering its list differently.
function meaningfulFacts(text: string): Set<string> {
  return new Set(criticalValues(text, 400).filter(v => !/^\d$/.test(v)));
}

function headingsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s{0,3}#{2,6}\s+(.+?)\s*#*\s*$/gm)) out.push(m[1]);
  for (const m of text.matchAll(/<h[2-6]\b[^>]*>([\s\S]*?)<\/h[2-6]>/gi)) out.push(m[1].replace(/<[^>]+>/g, " "));
  return out.map(s => s.trim()).filter(Boolean);
}

function anchorsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<!!)\[([^\]]+)\]\([^)]*\)/g)) out.push(m[1]);
  for (const m of text.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) out.push(m[1].replace(/<[^>]+>/g, " "));
  return out.map(s => s.trim()).filter(s => s.split(/\s+/).length >= 2);
}

function hasTableIn(text: string): boolean {
  return /<table\b/i.test(text) || /^\s*\|.+\|\s*\n\s*\|[\s:|-]+\|\s*$/m.test(text);
}

/**
 * A heading or anchor is unique when its normalised phrase occurs in no sibling's text.
 *
 * Substring on normalised text rather than heading-to-heading comparison, on purpose: siblings
 * often arrive as plain text (a harvest, a paste) where heading markup is gone, and a phrase that
 * appears anywhere in a twin is not something this page says first.
 */
function uniquePhrases(phrases: string[], siblingNorm: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of phrases) {
    const n = normalizeForDiff(p);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (!siblingNorm.some(s => s.includes(n))) out.push(p);
  }
  return out;
}

export function bandFor(score: number, maxSimilarity: number): OriginalityBand {
  if (maxSimilarity >= ORIG_NEAR_DUP) return "template";
  return score < 35 ? "template" : score < 60 ? "borderline" : "original";
}

export function originalityReport(text: string, siblings: readonly string[]): OriginalityReport {
  const words = tokenize(normalizeForDiff(text)).length;
  const sibs = siblings.map(s => String(s || "")).filter(s => tokenize(normalizeForDiff(s)).length >= 30);
  const sibSh = sibs.map(shingles);
  const sibNorm = sibs.map(s => normalizeForDiff(s));

  const own = shingles(text);
  let unique = 0;
  for (const x of own) if (!sibSh.some(s => s.has(x))) unique++;
  let maxSimilarity = 0, closest = -1;
  sibSh.forEach((s, i) => { const j = jaccard(own, s); if (j > maxSimilarity) { maxSimilarity = j; closest = i; } });
  const shingleGain = own.size ? unique / own.size : 0;

  const facts = meaningfulFacts(text);
  const sibFacts = new Set<string>();
  for (const s of sibs) for (const f of meaningfulFacts(s)) sibFacts.add(f);
  const uniqueFacts = [...facts].filter(f => !sibFacts.has(f));
  const per1k = words ? (uniqueFacts.length / words) * 1000 : 0;
  // Short pages are judged against an absolute floor of three facts, so a 120-word page with one
  // unique number does not read as "8 per 1000 words, full marks".
  const factTarget = Math.max(3, (ORIG_FACTS_PER_1K * words) / 1000);
  const substanceGain = Math.min(1, uniqueFacts.length / factTarget);

  const heads = headingsOf(text);
  const uniqueHeadings = uniquePhrases(heads, sibNorm);
  const anchors = anchorsOf(text);
  const uniqueAnchors = uniquePhrases(anchors, sibNorm);
  const hasTable = hasTableIn(text);
  const structure =
    (uniqueHeadings.length >= 2 ? 0.5 : uniqueHeadings.length === 1 ? 0.25 : 0) +
    (hasTable ? 0.25 : 0) +
    (uniqueAnchors.length ? 0.25 : 0);

  // Substance is weighted nearly as high as raw shingle novelty because it is the half that
  // paraphrase cannot game. With no siblings there is nothing to be original AGAINST, so the
  // score is reported as-is but the caller should treat siblings: 0 as "not measured".
  const score = Math.round(100 * (0.45 * shingleGain + 0.4 * substanceGain + 0.15 * structure));

  return {
    words,
    siblings: sibs.length,
    short: words < ORIG_SHORT_WORDS,
    shingles: { total: own.size, unique, gain: round2(shingleGain), maxSimilarity: round2(maxSimilarity), closest },
    substance: { unique: uniqueFacts.slice(0, 60), shared: facts.size - uniqueFacts.length, per1k: Math.round(per1k * 10) / 10, gain: round2(substanceGain) },
    structure: { hasTable, headings: heads.length, uniqueHeadings: uniqueHeadings.slice(0, 20), anchors: anchors.length, uniqueAnchors: uniqueAnchors.slice(0, 20) },
    score,
    band: bandFor(score, maxSimilarity),
  };
}

function round2(n: number) { return Math.round(n * 100) / 100; }

/**
 * The rewrite instruction for "make this page original against its siblings", passed to the
 * rewriter as `custom`.
 *
 * The hard rule in here is the one that matters: a model asked to "add unique facts" with nothing
 * to draw on will invent them, and an invented price on a geo page is worse than a duplicate. So
 * new substance may come ONLY from `facts` — what the operator actually knows about this page —
 * and the rewriter is told to restructure what exists when there are none. The caller audits the
 * result with factDrift against source + facts, so anything else that appears is flagged.
 */
export function originalityBrief(r: OriginalityReport, facts: string): string {
  const f = facts.trim();
  const parts: string[] = [
    `This page is one of a family of near-identical sibling pages (closest sibling ${Math.round(r.shingles.maxSimilarity * 100)}% similar). Make it carry information its siblings do not.`,
  ];
  if (f) {
    parts.push(`Work these page-specific facts into the text — they are verified and must appear: ${f.slice(0, 1500)}`);
  }
  if (r.structure.uniqueHeadings.length < 2) {
    parts.push("Add two subheadings specific to this page, each followed by a paragraph built on its specific facts.");
  }
  if (!r.structure.hasTable && f) {
    parts.push("Present the numeric facts above as one Markdown table.");
  }
  if (!r.structure.uniqueAnchors.length) {
    parts.push("Where the text links, use descriptive anchor text specific to this page rather than generic phrases.");
  }
  parts.push(
    f
      ? "Do not introduce any number, price, date, name or claim that is not in the original text or in the facts above."
      : "No new facts were supplied: do NOT invent numbers, prices, dates, names, jobs or reviews. Restructure and deepen only what the text already states.",
  );
  return parts.join(" ");
}
