// SERP Monitor — rank-biased overlap, robust statistics, storm verdict (CONTRACT.md §3.4, §0 trap 5).
// Pure module: imported by both server and client code — no server-only imports here.
import type { StormVerdict } from "./types";
import {
  STORM_MIN_BASELINE, STORM_MIN_COMPARED_ABS, STORM_MIN_COMPARED_SHARE,
  STORM_SHARE_HIGH, STORM_Z,
} from "./types";

/**
 * Extrapolated rank-biased overlap (Webber, Moffat, Zobel 2010, eq. 32) for two lists cut to the
 * same length k:
 *   RBO_ext = (X_k / k)·p^k + ((1 − p) / p) · Σ_{d=1..k} (X_d / d)·p^d
 * where X_d = |A[0..d) ∩ B[0..d)|. Identical lists → 1, disjoint → 0. k = 0 → 1.
 */
export function rboExt(a: readonly string[], b: readonly string[], p: number): number {
  const k = Math.min(a.length, b.length);
  if (k === 0) return 1;
  // Incremental prefix intersection: seenA/seenB hold prefix sets, common their intersection.
  // Duplicates count once (first occurrence), which is exactly set semantics.
  const seenA = new Set<string>();
  const seenB = new Set<string>();
  const common = new Set<string>();
  let sum = 0;
  for (let d = 1; d <= k; d++) {
    const va = a[d - 1];
    const vb = b[d - 1];
    if (!seenA.has(va)) {
      seenA.add(va);
      if (seenB.has(va)) common.add(va);
    }
    if (!seenB.has(vb)) {
      seenB.add(vb);
      if (seenA.has(vb)) common.add(vb);
    }
    sum += (common.size / d) * Math.pow(p, d);
  }
  return (common.size / k) * Math.pow(p, k) + ((1 - p) / p) * sum;
}

/** Quantile with linear interpolation (h = (n − 1)·q); q clamped to [0, 1]; does not mutate the input. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((x, y) => x - y);
  const clamped = Math.min(1, Math.max(0, q));
  const h = (sorted.length - 1) * clamped;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

/** Median absolute deviation, unscaled (the 1.4826 scaling happens in stormVerdict). */
export function mad(xs: readonly number[]): number {
  const center = median(xs);
  if (Number.isNaN(center)) return NaN;
  return median(xs.map((x) => Math.abs(x - center)));
}

/** A keyword needs at least this many history points before its own p90 is trusted. */
const MIN_P90_POINTS = 5;

/** Share of keywords whose current volatility is above their own KEYWORD_P90_WINDOW-snapshot p90 (needs ≥ 5 points each). */
export function shareAboveOwnP90(items: readonly { current: number; history: readonly number[] }[]): number | null {
  let eligible = 0;
  let above = 0;
  for (const item of items) {
    if (item.history.length < MIN_P90_POINTS) continue;
    eligible += 1;
    if (item.current > quantile(item.history, 0.9)) above += 1;
  }
  return eligible === 0 ? null : above / eligible;
}

export function stormVerdict(input: {
  current: number | null;               // this run's median volatility
  baseline: readonly number[];          // previous done runs' volatility, newest first, ≤ STORM_BASELINE_RUNS
  compared: number; planned: number;
  shareHigh: number | null;
}): StormVerdict {
  const verdict: StormVerdict = {
    calibrating: input.baseline.length < STORM_MIN_BASELINE,
    score: null,
    storm: false,
    baselineRuns: input.baseline.length,
  };
  // Too few checks collected yet: the project is still building its own baseline.
  if (verdict.calibrating) return verdict;
  // The run produced no median volatility (e.g. every keyword failed) — nothing to score.
  if (input.current === null || !Number.isFinite(input.current)) return verdict;
  // Too few comparable keywords — a high median would be noise, not a verdict.
  const minCompared = Math.max(STORM_MIN_COMPARED_ABS, STORM_MIN_COMPARED_SHARE * input.planned);
  if (input.compared < minCompared) return verdict;

  const center = median(input.baseline);
  const spread = mad(input.baseline);
  // +0.005 dampener keeps a perfectly quiet baseline (mad = 0) from dividing by zero and
  // from flinching at float dust.
  const score = (input.current - center) / (1.4826 * spread + 0.005);
  verdict.score = score;
  verdict.storm = score >= STORM_Z && (input.shareHigh ?? 0) >= STORM_SHARE_HIGH;
  return verdict;
}
