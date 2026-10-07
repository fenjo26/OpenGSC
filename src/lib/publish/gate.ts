// The publish uniqueness gate — same engine as analyze_text (src/lib/seo/textSimilarity.ts),
// applied to publishing: before a post is SENT, its text is compared against every published
// post of the WHOLE INSTANCE and blocked when a near-duplicate twin is found.
//
// Scope is instance-wide on purpose (the plan's 7.6-2): this is a single-user instance and
// Google sees duplicates across the whole satellite network, not per money-site. A satellite
// that links into two sites of a transfer network must land in the comparison either way.
//
// The gate is HONEST about being textual, not semantic: it catches near-duplicate wording
// (respins, light rewrites of one canonical), and it will happily pass the same story told in
// genuinely different words. The UI states this (pubGateNote) and nothing here pretends
// otherwise. There is deliberately NO force/bypass parameter in any surface — the fix for a
// blocked post is a genuinely different text, published as a new post.

import { normalizeForDiff, tokenize, shingleSet, jaccard } from "@/lib/seo/textSimilarity";

// ─── thresholds ──────────────────────────────────────────────────────────────────
//
// CALIBRATION (2026-10-07, `npx tsx src/lib/publish/calibrate.ts` against the local dev db):
//
//   bucket            |     n | min | p25 | median | p75 | max
//   different-topic   |     0 |   — |   — |      — |   — |   —
//   same-topic        |     0 |   — |   — |      — |   — |   —
//   respin            |     0 |   — |   — |      — |   — |   —
//
// The local database held 0 text/landing SeoHistory articles, 0 PublishedPost rows and no
// configured AI user, so no bucket could be measured (0 respin calls spent). Per the plan's
// fallback rule the thresholds below are the USER'S DOCUMENTED PRIOR, provisional until the
// calibration is re-run on an instance with real publications:
//   block ≈ 0.3 ("та же фактура" — respin-level overlap of one canonical text)
//   warn 0.15–0.3 (same-topic articles drifting toward shared wording)
// Two independent generations of one brief measure well below 0.3 after normalization; a
// respin of one canonical sits far above it. Re-run calibrate.ts after ~20+ publications and
// re-derive: block must sit ABOVE the measured same-topic max and BELOW the measured respin
// min; warn brackets the same-topic upper tail.

/** maxSimilarity ≥ this → the post is blocked (status "blocked", twin named in the error). */
export const UNIQUENESS_BLOCK_THRESHOLD = 0.3;
/** maxSimilarity in [this, block) → the post publishes, with the warning + number surfaced. */
export const UNIQUENESS_WARN_THRESHOLD = 0.15;

/**
 * The comparison set is capped at the latest N published posts of the instance. Honest cap:
 * beyond a few hundred publications the OLDEST twins matter far less than the compute cost of
 * pairwise trigram Jaccard against every one of them, and Google's own recency bias means a
 * duplicate of a two-year-old post is the lesser risk. The cap is not a promise that post N+1
 * is unique against everything older — only against the newest N.
 */
export const GATE_COMPARE_CAP = 300;

// ─── the verdict ─────────────────────────────────────────────────────────────────

export type UniquenessLevel = "ok" | "warn" | "blocked";

export interface TwinLike {
  id: string;
  title: string;
  markdown: string;
}

export interface UniquenessVerdict {
  /** Highest similarity found (0..1); 0 when nothing to compare against. */
  maxSimilarity: number;
  /** The post the candidate is most similar to (null when there is no comparison set). */
  twinPostId: string | null;
  twinTitle: string;
  level: UniquenessLevel;
  /** Always stored on the post row: 1 − maxSimilarity (higher = more unique). */
  uniquenessScore: number;
}

/**
 * The engine call, composed of textSimilarity's own exported primitives so each text is
 * normalized and shingled ONCE instead of once per pair (300 comparisons × 2 normalizations
 * would re-normalize the candidate 300 times for no reason). Semantics are exactly
 * textSimilarity's: identical normalized text → 1, else trigram Jaccard.
 */
function similarityPrepared(normalizedCandidate: string, candidateShingles: Set<string>, otherMarkdown: string): number {
  const nOther = normalizeForDiff(otherMarkdown);
  if (normalizedCandidate === nOther) return 1;
  return jaccard(candidateShingles, shingleSet(tokenize(nOther)));
}

/**
 * Compare one candidate against the already-published posts and produce the verdict. The
 * caller owns loading (and capping) the comparison set; the twin's id/title ride along so the
 * block error can name the twin post instead of citing an anonymous number.
 */
export function uniquenessVerdict(candidateMarkdown: string, published: TwinLike[]): UniquenessVerdict {
  if (!published.length) {
    // No comparison set yet: nothing to be a duplicate OF. Score 1.0, level ok — an instance
    // with zero published posts cannot block its first post.
    return { maxSimilarity: 0, twinPostId: null, twinTitle: "", level: "ok", uniquenessScore: 1 };
  }
  const nCandidate = normalizeForDiff(candidateMarkdown);
  const candidateShingles = shingleSet(tokenize(nCandidate));
  let maxSimilarity = 0;
  let twin: TwinLike | null = null;
  for (const other of published) {
    const s = similarityPrepared(nCandidate, candidateShingles, other.markdown);
    if (s > maxSimilarity) {
      maxSimilarity = s;
      twin = other;
    }
  }
  return {
    maxSimilarity,
    twinPostId: twin?.id ?? null,
    twinTitle: twin?.title ?? "",
    level: levelFor(maxSimilarity),
    uniquenessScore: 1 - maxSimilarity,
  };
}

/** Threshold application, split out so the UI can render the same band logic the gate enforces. */
export function levelFor(maxSimilarity: number): UniquenessLevel {
  if (maxSimilarity >= UNIQUENESS_BLOCK_THRESHOLD) return "blocked";
  if (maxSimilarity >= UNIQUENESS_WARN_THRESHOLD) return "warn";
  return "ok";
}

/** The error text stored on a blocked post — names the twin and the number, no way around it. */
export function blockedError(v: UniquenessVerdict): string {
  return `uniqueness_blocked: similarity ${v.maxSimilarity.toFixed(3)} with published post ${v.twinPostId} ("${v.twinTitle.slice(0, 80)}") — rewrite the text and publish it as a new post; there is no override`;
}
