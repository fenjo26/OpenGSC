// Trend radar (N5) — shared types. Pure declarations only: this file is imported by the
// pure-logic module, the Prisma store, the routes, the MCP tool and the UI, so it must not
// import any of them back.

/** The three sources of the radar (docs/tasks/wave-nov/N5-trend-radar.md). */
export type TrendSource = "gsc_rising" | "gsc_new" | "suggest";

export const TREND_SOURCES: TrendSource[] = ["gsc_rising", "gsc_new", "suggest"];

/** A query-row as the API, the MCP tool and the UI see it. */
export interface TrendRow {
  id: string;
  source: TrendSource;
  query: string;
  /** Source-specific hotness, higher = hotter. Never null: every stored row has one. */
  score: number;
  /** Impressions over the recent 7-day window; null = the source does not measure them (suggest). */
  impressions: number | null;
  /**
   * The comparison baseline — average impressions per 7-day window over the previous 28 days,
   * rounded for display. 0 = measured zero (the query really had none, e.g. gsc_new).
   * null = never measured (suggest). null ≠ 0, per the wave rules.
   */
  prevImpressions: number | null;
  /** Which seed produced a suggestion; null for the GSC sources. */
  seed: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface TrendSeedRow {
  id: string;
  seed: string;
  lang: string;
  country: string;
}

/** Per-source outcome of one run. */
export interface TrendSourceResult {
  /** How many queries the source contributed (inserted or refreshed). */
  rows: number;
  /** Human-facing status so the UI can explain a silent source. */
  status: "ok" | "skipped" | "skipped_unavailable" | "failed";
  detail?: string;
}

export interface TrendRunResult {
  ranAt: string;
  /** The last date Search Console actually had data for — windows end here, not at today. */
  lastDataDate: string;
  inserted: number;
  updated: number;
  sources: Record<TrendSource, TrendSourceResult>;
}
