// SERP Monitor — the end-of-run retry pass (pure policy; the collector does the I/O).
//
// Live A-Parser 1.2.3640 + Unlimited proxies answer roughly 3 requests in 8; the rest fail with
// a captcha or "Process redirect error: mismatch" and succeed when simply asked again a minute
// later. So once every keyword of a run has had its first try, the ones that failed for such a
// transient reason are asked again, after a pause long enough for A-Parser's proxy ban (60 s by
// default) to lapse. A failure that retrying cannot fix — no credentials, a rejected answer
// whose links contradict their titles, a provider error such as a wrong password — is never
// retried: repeating it only burns proxy time.

import type { SnapshotProblem } from "./types";

/** Problems a second try can plausibly fix. */
export const RETRYABLE_PROBLEMS: readonly SnapshotProblem[] = [
  "aparser_blocked_or_empty",
  "aparser_parser_failed",
  "aparser_no_result",
  "timeout",
];

/** First try plus two retries. */
export const RETRY_MAX_ATTEMPTS = 3;

/** Longer than A-Parser's default proxy ban (`proxybannedcleanup` = 60 s). */
export const RETRY_DELAY_MS = 90_000;

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
 * not elapsed yet — while it is non-zero the run must stay open.
 */
export function pickRetryWave(
  candidates: readonly RetryCandidate[],
  now: number,
  size: number,
): { due: RetryCandidate[]; waiting: number } {
  const retryable = candidates
    .filter((c) => isRetryable(c.problem, c.attempts))
    .sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  const ready = retryable.filter((c) => now - c.takenAt.getTime() >= RETRY_DELAY_MS);
  return { due: ready.slice(0, Math.max(0, size)), waiting: retryable.length - ready.length };
}
