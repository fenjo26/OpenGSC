// Rank Tracker — retry and fallback policy, pure (no Prisma, no network) so it is unit-tested.
//
// Two different failures, two different remedies:
//  - transient (a captcha'd proxy, a 503, "try again later"): the same provider usually answers
//    a few seconds later — ScrapingRobot's "Could not complete the request" is ~15% of its checks
//    on this instance, A-Parser's blocked pages come and go with the proxy pool;
//  - anything still failing after that goes to the fallback provider, when one is configured.
// A check that fails everywhere is stored as an error and keeps the last known position — never
// as "not found".

import { supportsLocation, type LocalPackEntry } from "./seo/localPack";

export interface RankAttempt {
  position: number | null;
  url: string | null;
  depth: number;
  error?: string;
  provider: string;
  /** Organic rows the scan actually held. Used to tell a real miss from an empty SERP. */
  resultCount?: number;
  /** False when pagination stopped on a failure or an empty tail page. */
  complete?: boolean;
  /**
   * True only when a null position is a full-depth miss with a healthy result count.
   * Absent or false must not overwrite a known rank.
   */
  missTrusted?: boolean;
  /**
   * wave-nov N3: the SERP's map pack, when the check was geolocated and the provider reported
   * one. Carried through `checkWithFallback` untouched (the spreads below keep unknown fields),
   * because a fallback that answered must bring its OWN pack, not inherit the failed
   * primary's fragments.
   */
  localPack?: LocalPackEntry[];
  hasLocalPack?: boolean | null;
}

/**
 * wave-nov N3: is the configured fallback eligible for a geolocated check? A provider without
 * a location parameter would answer the COUNTRY SERP, and the tracker would store it as the
 * city position — the exact lie CONTRACT.md §0.2/§0.3 exists to prevent. Such a fallback is
 * dropped for local keywords (the primary's error is stored as-is), and kept for everything
 * else.
 */
export function fallbackForLocation(
  fallback: string | null | undefined,
  location: string | null | undefined,
): string | null {
  const id = String(fallback ?? "").trim();
  if (!id) return null;
  if (location && !supportsLocation(id)) return null;
  return id;
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

/**
 * A SERP with fewer organic rows than this is not proof the domain is absent.
 * Captcha and consent pages parse to 0–2 links; a real Google page is a handful
 * or more. The HTML fallback in `serp.ts` rejects anything under this, and the
 * rank writer will not clear a known position on a thinner scan.
 */
export const HEALTHY_SERP_RESULTS = 5;

/** A null position is a real miss only after a finished scan at full depth with a healthy page of results. */
export function serpMissIsTrusted(o: {
  depth: number;
  maxDepth: number;
  resultCount: number;
  complete: boolean;
}): boolean {
  return o.complete && o.depth >= o.maxDepth && o.resultCount >= HEALTHY_SERP_RESULTS;
}

/**
 * Would storing this null position wipe a rank we already had, without a scan we trust?
 * Callers turn that into an error RankCheck and leave `lastPosition` alone.
 * An existing error is already on that path. A keyword that never ranked has nothing to protect.
 */
export function untrustedRankMiss(o: {
  position: number | null;
  previousPosition: number | null;
  missTrusted?: boolean;
  error?: string | null;
}): boolean {
  if (o.error) return false;
  if (o.position !== null) return false;
  if (o.previousPosition == null) return false;
  return o.missTrusted !== true;
}

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
