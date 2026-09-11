// The watch half of the funnel's last step ("watch / buy"): re-ask the registry about a domain
// the user wants but someone else holds, until the registry says it is free, then notify once
// and stop. The scheduler that runs the loop lives in scheduler.ts; everything here is pure so
// the timing decisions are testable without a database or a registry.

/**
 * Stages a watched row can sit in while its watch is still running.
 *
 * `available` is included, but only ever carries a *running* watch: an uncorroborated free
 * leaves the row in that stage with the watch on and a near-term re-check (the registry that
 * stayed silent owes an answer), while a corroborated one turns the watch off and the row drops
 * out of this loop for good. A row the funnel marked corroborated-free is unwatched, so the
 * manual catalogue never leaks into the scheduler.
 *
 * `ingested` is absent because the funnel order stands — a row reaches the watch loop through
 * the same DNS pre-filter and registry check as everything else, never around them.
 */
export const WATCH_STAGES = ["taken", "resolved_taken", "dns_checked", "checking", "available"] as const;

/**
 * EPP statuses that mean the drop is close, and how often to re-check when they show.
 *
 * A domain in `pendingDelete` is days from release; `redemptionPeriod` is the stage before it.
 * Watching such a name once a day misses the exact moment the watch exists for, so the interval
 * collapses. These are the same lifecycle accelerations project-backorder ships with.
 */
const ACCELERATED: [needle: string, minutes: number][] = [
  ["pendingdelete", 15],
  ["redemptionperiod", 60],
];

/**
 * Minutes until the next re-check of a watched domain.
 *
 * Registry lifecycle statuses override the row's own interval — a pendingDelete domain is worth
 * checking every 15 minutes no matter what the watch was configured at. Otherwise the row's
 * interval applies, clamped to [15 min, 7 days]: the floor keeps an aggressive row from becoming
 * a one-domain denial-of-service against a registry, the ceiling keeps a mistyped 0 from meaning
 * "check every tick".
 */
export function nextWatchCheckMin(
  checkIntervalMin: number | null | undefined,
  registryStatus: string | string[] | null | undefined,
): number {
  const joined = Array.isArray(registryStatus)
    ? registryStatus.join(",").toLowerCase()
    : String(registryStatus ?? "").toLowerCase();
  for (const [needle, minutes] of ACCELERATED) {
    if (joined.includes(needle)) return minutes;
  }
  const own = Math.round(Number(checkIntervalMin) || 0);
  if (own <= 0) return 1440; // the schema default: once a day
  return Math.min(Math.max(own, 15), 7 * 24 * 60);
}

/**
 * Which acceleration, if any, a set of registry statuses carries.
 *
 * The scheduler events use it to record the moment a watch speeds up — the one change in a
 * watched domain's life that is both expected and worth a trail line, so "why did this row
 * suddenly check every 15 minutes" has an answer in the history.
 */
export function watchAcceleration(
  registryStatus: string | string[] | null | undefined,
): "pending_delete" | "redemption" | null {
  const raw = Array.isArray(registryStatus)
    ? registryStatus.join(",")
    : String(registryStatus ?? "");
  // Letters only, because the two sources spell the same status differently and the difference
  // was silently fatal: WHOIS returns EPP camelCase (`redemptionPeriod`) while RDAP returns the
  // spaced form (`pending delete`, RFC 9083 §10.2.2). Matching on `pendingdelete` therefore only
  // ever fired for WHOIS rows — a domain days from release that happened to be answered by RDAP
  // kept the slow interval and the watch missed the moment it exists for.
  const joined = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (joined.includes("pendingdelete")) return "pending_delete";
  if (joined.includes("redemptionperiod")) return "redemption";
  return null;
}
