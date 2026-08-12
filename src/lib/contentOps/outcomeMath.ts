/**
 * Pure outcome arithmetic, kept out of the server module so it can be unit-tested directly:
 * `outcome.ts` imports "server-only" and pulls in Prisma, neither of which belongs in a test.
 */

export const OUTCOME_DAYS = [7, 30, 90] as const;

/**
 * Search Console data lands two to three days late, and this instance only has whatever the last
 * sync pulled. Capturing a 7-day window exactly on day 7 would therefore record a number that is
 * wrong in a predictable direction — low. The window is closed only after this settle period, and
 * a captured checkpoint is never recomputed afterwards.
 */
export const SETTLE_DAYS = 3;
export const BASELINE_DAYS = 28;
export const DAY_MS = 86_400_000;

export interface OutcomeWindow {
  clicks: number;
  impressions: number;
  /** Impression-weighted average position, or null when the window has no impressions at all. */
  position: number | null;
}
export interface OutcomeCheckpoint extends OutcomeWindow {
  day: number;
  capturedAt: string;
  from: string;
  to: string;
  /** Rank Tracker position closest to the end of the window; null when not tracked or not found. */
  rank: number | null;
}
export interface OutcomeRecord {
  baseline: (OutcomeWindow & { from: string; to: string }) | null;
  checkpoints: OutcomeCheckpoint[];
}

export function parseOutcome(value: unknown): OutcomeRecord {
  if (typeof value !== "string" || !value) return { baseline: null, checkpoints: [] };
  try {
    const parsed = JSON.parse(value);
    return {
      baseline: parsed?.baseline ?? null,
      checkpoints: Array.isArray(parsed?.checkpoints) ? parsed.checkpoints : [],
    };
  } catch {
    return { baseline: null, checkpoints: [] };
  }
}

/**
 * Position is weighted by impressions, not averaged across rows: a day with three impressions at
 * position 2 says far less about the page than a day with three thousand at position 8, and a
 * plain mean would let the quiet day dominate.
 */
export function summarizeRows(rows: Array<{ clicks: number; impressions: number; position: number }>): OutcomeWindow {
  const impressions = rows.reduce((total, row) => total + row.impressions, 0);
  const clicks = rows.reduce((total, row) => total + row.clicks, 0);
  const weighted = rows.reduce((total, row) => total + row.position * row.impressions, 0);
  return {
    clicks,
    impressions,
    position: impressions > 0 ? Math.round((weighted / impressions) * 10) / 10 : null,
  };
}

/** A window counts as measurable only once it has closed AND the reporting lag has passed. */
export function isCheckpointDue(liveAt: Date, day: number, now: Date = new Date()): boolean {
  return now.getTime() >= liveAt.getTime() + (day + SETTLE_DAYS) * DAY_MS;
}

/** URL variants Search Console may have stored for the same page (trailing slash is the usual one). */
export function urlVariants(raw: string): string[] {
  const url = new URL(raw);
  url.hash = "";
  const withSlash = url.href.endsWith("/") ? url.href : `${url.href}/`;
  const withoutSlash = url.href.replace(/\/$/, "");
  return [...new Set([url.href, withSlash, withoutSlash])];
}

/** Compare a URL host with a Search Console property, which may be an sc-domain: value. */
export function sameHost(propertyOrUrl: string, other: string): boolean {
  const host = (value: string) => value.trim().toLowerCase()
    .replace(/^sc-domain:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
  return !!host(propertyOrUrl) && host(propertyOrUrl) === host(other);
}
