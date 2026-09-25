// Trend radar (N5) — the pure arithmetic. No Prisma, no network, no Next: everything here is
// computable from plain inputs and covered by node:test (README §5, "чистая логика отдельно
// от Prisma"). The store (./store.ts) owns the database, the sources (./sources.ts) own HTTP.
//
// The three sources and their scores:
//   gsc_rising — impressions over the last 7 data days grew ≥ ×2 against the average 7-day
//                window of the previous 28, with ≥ 30 impressions.
//                score = log2(growth) × log10(impressions)
//   gsc_new    — ≥ 10 impressions over the last 7 data days and absent for the 60 days before
//                that. score = log10(impressions) (same "log of volume" scale as rising, no
//                growth factor because there is no baseline to grow from).
//   suggest    — Google autocomplete for the operator's seeds. First sighting = 1, every
//                repeat sighting +0.5, capped at 3. impressions are null: autocomplete has
//                no volume, and null ≠ 0.
//
// Search Console data lags 2–3 days, so every window ENDS at the last date with data (the
// caller reads that date from the local store), never at today — same lesson as
// /api/gsc/decay/position documents.

import type { TrendSource } from "./types";

// ─── constants (the brief's numbers, named) ────────────────────────────────────

export const RISING_WINDOW_DAYS = 7;      // the recent window
export const RISING_BASELINE_DAYS = 28;   // the baseline window before it
export const NEW_LOOKBACK_DAYS = 60;      // gsc_new: absent for this many days
export const RISING_MIN_IMPRESSIONS = 30;
export const RISING_MIN_GROWTH = 2;
export const NEW_MIN_IMPRESSIONS = 10;

export const HIDE_AFTER_DAYS = 14;        // absent from a source this long → hidden from the radar
/** Per-source ceiling per run: the radar is a short list of hot things, not a query dump. */
export const MAX_ITEMS_PER_SOURCE = 50;
export const MAX_SEEDS_PER_SITE = 20;

// Google suggest: free, but rate-limited and captcha-happy. Pause ≥ 1 s between requests and
// a hard ceiling of 50 requests per site per run — the deep a–z expansion of ONE seed already
// costs 37 (the bare seed + 26 letters + 10 digits), so two deep seeds hit the ceiling.
export const SUGGEST_MAX_REQUESTS = 50;
export const SUGGEST_PAUSE_MS = 1_000;

export const SUGGEST_SCORE_NEW = 1;
export const SUGGEST_SCORE_STEP = 0.5;
export const SUGGEST_SCORE_MAX = 3;

// The daily notification only fires for new rows hotter than this — enough to keep a ×2 riser
// with 30 impressions (score ≈ 1.48) quiet and a ×4 riser with 100 impressions (score 4.0) loud.
export const NOTIFY_MIN_SCORE = 2;
export const NOTIFY_MAX_LINES = 8;

/** The bare seed plus 26 letters and 10 digits, in Google-autocomplete order. */
export const DEEP_SUFFIXES: readonly string[] = Object.freeze([
  ..."abcdefghijklmnopqrstuvwxyz", ..."0123456789",
]);

// ─── date windows ──────────────────────────────────────────────────────────────

export interface TrendWindows {
  /** Recent 7-day window: [recentStart, recentEnd], both inclusive ISO dates. */
  recentStart: string;
  recentEnd: string;
  /** The previous 28 days: [prevStart, prevEnd], ending the day before recentStart. */
  prevStart: string;
  prevEnd: string;
  /** gsc_new lookback: the 60 days before the recent window, [historyStart, historyEnd]. */
  historyStart: string;
  historyEnd: string;
}

/** Shift an ISO date (YYYY-MM-DD) by whole days, in UTC, staying an ISO date. */
export function shiftDay(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * All three windows anchored at the last date with data. Everything is inclusive on both
 * ends: recent = end−6…end (7 days), baseline = end−34…end−7 (28 days), history =
 * end−66…end−7 (60 days).
 */
export function trendWindows(lastDataDate: string): TrendWindows {
  return {
    recentEnd: lastDataDate,
    recentStart: shiftDay(lastDataDate, -(RISING_WINDOW_DAYS - 1)),
    prevEnd: shiftDay(lastDataDate, -RISING_WINDOW_DAYS),
    prevStart: shiftDay(lastDataDate, -(RISING_WINDOW_DAYS + RISING_BASELINE_DAYS - 1)),
    historyEnd: shiftDay(lastDataDate, -RISING_WINDOW_DAYS),
    historyStart: shiftDay(lastDataDate, -(RISING_WINDOW_DAYS + NEW_LOOKBACK_DAYS - 1)),
  };
}

// ─── gsc_rising ────────────────────────────────────────────────────────────────

export interface RisingRow {
  query: string;
  /** Impressions over the recent window. */
  impressions: number;
  /** Impressions over the whole baseline window (the raw 28-day total). */
  prevImpressionsTotal: number;
  /** Average per 7-day window over the baseline — the number the growth is measured against. */
  baseline: number;
  growth: number;
  score: number;
}

/**
 * The baseline: what the recent 7-day window "should" look like if nothing changed, i.e. the
 * 28-day total scaled down to one window. Float — rounding happens only at display time.
 */
export function baselinePerWindow(prevTotal: number): number {
  return (prevTotal * RISING_WINDOW_DAYS) / RISING_BASELINE_DAYS;
}

/**
 * Growth = recent / baseline, or null when there is no baseline (the query had zero
 * impressions in the previous 28 days). Infinite growth is not a number the radar can rank —
 * a query with no baseline is gsc_new's business, not gsc_rising's.
 */
export function gscGrowth(recentImpressions: number, prevTotal: number): number | null {
  if (prevTotal <= 0) return null;
  return recentImpressions / baselinePerWindow(prevTotal);
}

export function risingScore(growth: number, impressions: number): number {
  return Math.log2(growth) * Math.log10(impressions);
}

/**
 * gsc_rising rows from two query→impressions maps. Conditions (constants above): ≥ 30
 * impressions in the recent window and growth ≥ ×2 against the 28-day baseline. Sorted by
 * score, hottest first.
 */
export function risingRows(
  recent: ReadonlyMap<string, number>,
  prev: ReadonlyMap<string, number>,
): RisingRow[] {
  const out: RisingRow[] = [];
  for (const [query, impressions] of recent) {
    if (impressions < RISING_MIN_IMPRESSIONS) continue;
    const prevTotal = prev.get(query) ?? 0;
    const growth = gscGrowth(impressions, prevTotal);
    if (growth == null || growth < RISING_MIN_GROWTH) continue;
    out.push({
      query,
      impressions,
      prevImpressionsTotal: prevTotal,
      baseline: baselinePerWindow(prevTotal),
      growth,
      score: risingScore(growth, impressions),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ─── gsc_new ───────────────────────────────────────────────────────────────────

export interface NewRow {
  query: string;
  impressions: number;
  score: number;
}

/**
 * gsc_new rows: ≥ 10 impressions in the recent window and NOT SEEN at all during the
 * 60-day lookback (a query present 29–60 days ago is "returning", not new — the brief draws
 * the line at 60 and so does this). Sorted by score.
 */
export function newRows(
  recent: ReadonlyMap<string, number>,
  history: ReadonlyMap<string, number>,
): NewRow[] {
  const out: NewRow[] = [];
  for (const [query, impressions] of recent) {
    if (impressions < NEW_MIN_IMPRESSIONS) continue;
    if (history.has(query)) continue;
    out.push({ query, impressions, score: Math.log10(impressions) });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ─── suggest ───────────────────────────────────────────────────────────────────

/**
 * Parse a Google autocomplete answer. With client=firefox the body is JSON shaped
 * `["seed", ["a", "b", …]]`. Anything else — an HTML captcha page, a JSON error object, a
 * truncated body — is null, which the caller treats as "Google is unavailable today", not as
 * "no suggestions". Suggestions are trimmed, lowercased (GSC queries are lowercase; one
 * spelling per query keeps the two sources comparable) and de-duplicated, but NOT filtered
 * against the seed: "slot" suggesting "slots" is a real discovery, not a duplicate.
 */
export function parseSuggest(body: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || !Array.isArray(parsed[1])) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed[1]) {
    if (typeof item !== "string") continue;
    const s = item.trim().toLowerCase().slice(0, 200);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Score progression: first sighting 1, every repeat +0.5, capped at 3. */
export function nextSuggestScore(seenBefore: boolean, prevScore: number | null): number {
  if (!seenBefore) return SUGGEST_SCORE_NEW;
  return Math.min(SUGGEST_SCORE_MAX, (prevScore ?? SUGGEST_SCORE_NEW) + SUGGEST_SCORE_STEP);
}

/**
 * The request plan for one run: every seed once, then — only when deep — the a–z/0–9
 * expansion, seeds in order, never more than SUGGEST_MAX_REQUESTS queries total. Plain mode
 * stays well under the ceiling for any legal seed count (≤ 20); deep mode spends it on
 * purpose, one seed at a time.
 */
export function suggestPlan(seeds: readonly string[], deep: boolean): string[] {
  const plan: string[] = [];
  for (const seed of seeds) {
    const queries = deep ? [seed, ...DEEP_SUFFIXES.map(suffix => `${seed} ${suffix}`)] : [seed];
    for (const q of queries) {
      if (plan.length >= SUGGEST_MAX_REQUESTS) return plan;
      plan.push(q);
    }
  }
  return plan;
}

// ─── hiding, notifications ─────────────────────────────────────────────────────

/** Items whose source stopped mentioning them this long ago are hidden from the radar. */
export function hideBefore(now: Date): Date {
  return new Date(now.getTime() - HIDE_AFTER_DAYS * 86_400_000);
}

export interface NotifyCandidate {
  query: string;
  source: TrendSource;
  score: number;
  growth: number | null;
  impressions: number | null;
}

/**
 * The lines of the daily "rising queries" notification: newly inserted rows with score above
 * NOTIFY_MIN_SCORE, hottest first, at most 8. Language-neutral on purpose — the title and
 * message come from notifyI18n's trendsTitle/trendsMsg, the lines are data (×3.2 query — 540).
 */
export function notifyLines(rows: readonly NotifyCandidate[]): string[] {
  return rows
    .filter(r => r.score > NOTIFY_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, NOTIFY_MAX_LINES)
    .map(r => {
      if (r.source === "suggest") return `… ${r.query}`;
      const growth = r.growth != null ? `×${r.growth.toFixed(1)} ` : "";
      return `${growth}${r.query}${r.impressions != null ? ` — ${r.impressions}` : ""}`;
    });
}
