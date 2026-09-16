// SERP Monitor — the end-of-run retry pass (pure policy; the collector does the I/O).
//
// Live A-Parser 1.2.3640 answers a share of requests with a captcha it could not pass, a
// "Process redirect error: mismatch", or a page whose links it mis-resolved — and the same query
// asked again usually succeeds. So once every keyword of a run has had its first try, the ones
// that failed for such a reason are asked again. There is no point waiting out a proxy ban
// between tries: A-Parser takes a different proxy from the pool for every attempt (a banned
// one is skipped), so the pause is only a short breather. A failure that retrying cannot fix —
// no credentials, a provider error such as a wrong password — is never retried.

import type { SnapshotProblem } from "./types";

/** Problems a second try can plausibly fix. */
export const RETRYABLE_PROBLEMS: readonly SnapshotProblem[] = [
  "aparser_blocked_or_empty",
  "aparser_parser_failed",
  "aparser_no_result",
  "timeout",
  "suspicious_links", // mis-resolved links are intermittent: the next answer is usually clean
];

/** First try plus two retries. */
export const RETRY_MAX_ATTEMPTS = 3;

/** A breather, not a ban wait — A-Parser rotates to another proxy on its own. */
export const RETRY_DELAY_MS = 10_000;

export interface RetryCandidate {
  snapshotId: string;
  keywordId: string;
  problem: string | null;
  attempts: number;
  takenAt: Date;
}

export function isRetryable(problem: string | null | undefined, attempts: number): boolean {
  return !!problem
    && (RETRYABLE_PROBLEMS as readonly string[]).includes(problem)
    && attempts < RETRY_MAX_ATTEMPTS;
}

/**
 * Which failed snapshots to retry now, and how many are still cooling down.
 * `due` is oldest first and capped at `size`; `waiting` counts retryable rows whose pause has
 * not elapsed yet — while it is non-zero the run must stay open. `nextDueInMs` is how long
 * until the first of those is due (null when none waits), for a timely wake-up and the UI.
 */
export function pickRetryWave(
  candidates: readonly RetryCandidate[],
  now: number,
  size: number,
): { due: RetryCandidate[]; waiting: number; nextDueInMs: number | null } {
  const retryable = candidates
    .filter((c) => isRetryable(c.problem, c.attempts))
    .sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  const ready = retryable.filter((c) => now - c.takenAt.getTime() >= RETRY_DELAY_MS);
  const cooling = retryable.filter((c) => now - c.takenAt.getTime() < RETRY_DELAY_MS);
  const nextDueInMs = cooling.length
    ? Math.max(0, cooling[0].takenAt.getTime() + RETRY_DELAY_MS - now) // oldest first → soonest due
    : null;
  return { due: ready.slice(0, Math.max(0, size)), waiting: cooling.length, nextDueInMs };
}

/**
 * Retries in flight, per run. During one the failed snapshot is already released, so the run's
 * counters read one short and the page would show "0 of 1" with no hint why. Kept on
 * `globalThis` because the scheduler (instrumentation) and the API routes can load separate
 * copies of this module inside the same Node process.
 */
const registry = ((globalThis as { __serpmonRetrying?: Map<string, number> }).__serpmonRetrying ??= new Map<string, number>());

export function retriesInFlight(runId: string): number {
  return registry.get(runId) ?? 0;
}

export async function trackRetry<T>(runId: string, work: () => Promise<T>): Promise<T> {
  registry.set(runId, retriesInFlight(runId) + 1);
  try {
    return await work();
  } finally {
    const left = retriesInFlight(runId) - 1;
    if (left > 0) registry.set(runId, left); else registry.delete(runId);
  }
}
