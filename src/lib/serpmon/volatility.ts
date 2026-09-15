// SERP Monitor — volatility and storm verdict. Stub: T2 owns the implementation (see docs/tasks/serp-monitor/).
import type { StormVerdict } from "./types";

/**
 * Extrapolated rank-biased overlap (Webber, Moffat, Zobel 2010, eq. 32) for two lists cut to the
 * same length k:
 *   RBO_ext = (X_k / k)·p^k + ((1 − p) / p) · Σ_{d=1..k} (X_d / d)·p^d
 * where X_d = |A[0..d) ∩ B[0..d)|. Identical lists → 1, disjoint → 0. k = 0 → 1.
 */
export function rboExt(a: readonly string[], b: readonly string[], p: number): number {
  throw new Error("serpmon: rboExt not implemented (T2)");
}

export function median(xs: readonly number[]): number {
  throw new Error("serpmon: median not implemented (T2)");
}

export function mad(xs: readonly number[]): number {
  throw new Error("serpmon: mad not implemented (T2)");
}

export function quantile(xs: readonly number[], q: number): number {
  throw new Error("serpmon: quantile not implemented (T2)");
}

export function stormVerdict(input: {
  current: number | null;               // this run's median volatility
  baseline: readonly number[];          // previous done runs' volatility, newest first, ≤ STORM_BASELINE_RUNS
  compared: number; planned: number;
  shareHigh: number | null;
}): StormVerdict {
  throw new Error("serpmon: stormVerdict not implemented (T2)");
}

/** Share of keywords whose current volatility is above their own KEYWORD_P90_WINDOW-snapshot p90 (needs ≥ 5 points each). */
export function shareAboveOwnP90(items: readonly { current: number; history: readonly number[] }[]): number | null {
  throw new Error("serpmon: shareAboveOwnP90 not implemented (T2)");
}
