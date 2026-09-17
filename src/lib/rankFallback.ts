// Rank Tracker — retry and fallback policy, pure (no Prisma, no network) so it is unit-tested.
//
// Two different failures, two different remedies:
//  - transient (a captcha'd proxy, a 503, "try again later"): the same provider usually answers
//    a few seconds later — ScrapingRobot's "Could not complete the request" is ~15% of its checks
//    on this instance, A-Parser's blocked pages come and go with the proxy pool;
//  - anything still failing after that goes to the fallback provider, when one is configured.
// A check that fails everywhere is stored as an error and keeps the last known position — never
// as "not found".

export interface RankAttempt {
  position: number | null;
  url: string | null;
  depth: number;
  error?: string;
  provider: string;
}

export interface RankOutcome extends RankAttempt {
  /** The primary provider's error when the fallback produced the stored answer. */
  primaryError?: string;
  attempts: number;
}

const TRANSIENT = [
  /aparser_(blocked_or_empty|parser_failed|no_result|partial_serp|position_mismatch)/,
  /\btimeout\b/i,
  /сеть A-Parser/,
  /try again later/i,
  /non-JSON response \(5\d\d\)/,
  /\b(429|50[0-4])\b/,
  /ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i,
];

export function isTransientRankError(error: string | undefined | null): boolean {
  const e = String(error ?? "");
  return !!e && TRANSIENT.some((re) => re.test(e));
}

export const RANK_RETRY_DELAY_MS = 10_000;

export async function checkWithFallback(
  run: (provider: string) => Promise<RankAttempt>,
  primary: string,
  fallback: string | null | undefined,
  opts: { retryDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RankOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delay = opts.retryDelayMs ?? RANK_RETRY_DELAY_MS;
  let attempts = 1;
  let first = await run(primary);
  if (!first.error) return { ...first, attempts };
  if (isTransientRankError(first.error)) {
    await sleep(delay);
    attempts++;
    first = await run(primary);
    if (!first.error) return { ...first, attempts };
  }
  if (!fallback || fallback === primary) return { ...first, attempts };
  attempts++;
  const second = await run(fallback);
  if (!second.error) return { ...second, primaryError: first.error, attempts };
  return {
    ...first,
    error: `${first.error} → ${fallback}: ${second.error}`,
    attempts,
  };
}
