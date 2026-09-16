export const SERPMON_DEPTHS = [10, 20, 50, 100] as const;
export type SerpmonDepth = typeof SERPMON_DEPTHS[number];

/** 0 = manual only. */
export const SERPMON_INTERVALS = [0, 6, 12, 24, 72, 168] as const;

export const SERPMON_MAX_KEYWORDS = 5000;          // per project
export const SERPMON_MANUAL_COOLDOWN_MS = 10 * 60_000;

export type SnapshotStatus = "ok" | "partial" | "failed";

export type SnapshotProblem =
  | "aparser_no_result"          // from parserResultProblem
  | "aparser_parser_failed"      // from parserResultProblem
  | "aparser_blocked_or_empty"   // from parserResultProblem
  | "short_result"               // fewer rows than SHORT_RESULT_RATIO × expected, engine did not say why
  | "provider_error"             // runSerp returned `error`
  | "no_creds"
  | "timeout"
  | "suspicious_links";          // success reported, but the links contradict the titles (see assessSerpIntegrity)

export interface SerpRow {
  position: number;   // 1-based, organic only, as mapped by the provider
  url: string;
  host: string;       // hostOfUrl(url)
  title: string;
}

export interface HostPos {
  host: string;
  best: number;       // best (lowest) position of any URL of this host
  urls: number;       // how many URLs of this host are in the list
}

export type ChangeKind = "enter" | "exit" | "up" | "down";

export interface HostChange {
  host: string;
  kind: ChangeKind;
  from: number | null;   // null for enter
  to: number | null;     // null for exit
  urls: number;
  hidden: boolean;       // platform or project-ignored
}

export interface KeywordDiff {
  comparedDepth: number;
  changes: HostChange[];   // sorted: enter (by `to`), then up/down (by |delta| desc), then exit (by `from`)
  volatility: number;      // 0..1, 1 − RBO_ext over host lists, p = RBO_P_FULL
  volTop10: number;        // 0..1, 1 − RBO_ext over the first 10 hosts, p = RBO_P_TOP10
  visibleCount: number;    // changes.filter(c => !c.hidden).length
}

export interface StormVerdict {
  calibrating: boolean;    // baseline shorter than STORM_MIN_BASELINE
  score: number | null;    // robust z; null when calibrating or not enough compared keywords
  storm: boolean;
  baselineRuns: number;
}

/** Position bands and the |delta| that counts as a move inside each. Last band must reach 100. */
export const MOVE_THRESHOLDS: readonly { upTo: number; delta: number }[] = [
  { upTo: 10, delta: 3 },
  { upTo: 30, delta: 7 },
  { upTo: 100, delta: 15 },
];

export const SHORT_RESULT_RATIO = 0.8;
export const RBO_P_FULL = 0.95;
export const RBO_P_TOP10 = 0.8;

export const STORM_MIN_BASELINE = 7;       // done runs with a volatility before a verdict is given
export const STORM_BASELINE_RUNS = 20;     // how many previous runs form the baseline
export const STORM_Z = 3;
export const STORM_SHARE_HIGH = 0.3;
export const STORM_MIN_COMPARED_ABS = 10;  // and at least 30% of planned
export const STORM_MIN_COMPARED_SHARE = 0.3;
export const KEYWORD_P90_WINDOW = 20;      // snapshots per keyword for its own p90
export const BOUNCE_RUNS = 7;

export const NEW_HOST_DAYS = 7;
export const YOUNG_HOST_MONTHS = 6;

/** Matched by host or dot-bounded suffix: "m.facebook.com" is facebook.com, "netflix.com" is not x.com. */
export const DEFAULT_PLATFORM_HOSTS: readonly string[] = [
  "facebook.com", "instagram.com", "youtube.com", "twitter.com", "x.com", "tiktok.com",
  "linkedin.com", "reddit.com", "quora.com", "pinterest.com", "threads.net", "t.me",
  "wikipedia.org", "apps.apple.com", "play.google.com", "google.com", "medium.com",
  "trustpilot.com", "vk.com", "amazon.com",
];

// ─── API shapes (T3/T4 return them, T5/T6 consume them) ───

export interface ProjectSummary {
  id: string; name: string; engine: string; device: string; country: string; lang: string;
  depth: number; intervalHours: number; paused: boolean;
  keywords: number; lastRunAt: string | null; nextRunAt: string | null;
  lastRun: RunSummary | null;
  volatilitySeries: (number | null)[];   // last 30 done runs, oldest first
}

export interface ProjectDetail extends ProjectSummary {
  ownDomains: string[]; ignoreHosts: string[]; retentionDays: number; alertStorm: boolean;
  groups: { name: string; count: number }[];
  firstRunAt: string | null;
}

export interface RunSummary {
  id: string; trigger: "schedule" | "manual"; status: "running" | "done" | "aborted";
  startedAt: string; finishedAt: string | null;
  planned: number; ok: number; partial: number; failed: number; compared: number;
  volatility: number | null; volTop10: number | null; shareHigh: number | null;
  stormScore: number | null; storm: boolean; calibrating: boolean; error: string | null;
  /**
   * Running runs in the retry pass only (see retry.ts): `inFlight` keywords being asked again
   * right now (their failed row is released, so the counters read that many short), `waiting`
   * failed keywords queued for another try, `nextInSec` until the first of those is due.
   */
  retry?: { inFlight: number; waiting: number; nextInSec: number | null } | null;
}

export interface MarketRow {
  keywordId: string; keyword: string; group: string;
  status: SnapshotStatus | ""; problem: string | null;
  detail: string | null;                 // raw provider/transport error behind `problem`, sanitized
  lastOkAt: string | null;
  leaders: string[];                     // first 5 hosts of the latest ok|partial snapshot, platforms included
  changes: HostChange[];                 // from the latest comparison; hidden ones included, UI filters
  volatility: number | null;
  own: { host: string; position: number } | null;
}

export interface MarketQuery {
  q?: string; host?: string; group?: string; changedOnly?: boolean;
  sort?: "keyword" | "volatility" | "changes"; page?: number; pageSize?: number;   // pageSize ≤ 200
}

export type DomainTag = "new" | "young" | "rising" | "falling" | "bounced" | "platform" | "own";

export interface DomainRow {
  hostId: number; host: string; registrable: string;
  firstSeenAt: string; lastSeenAt: string;
  registeredAt: string | null; ageMonths: number | null; ageError: string | null;
  dr: number | null;
  refdomains: number | null;
  keywords: number; prevKeywords: number; top10: number; top30: number;
  bestPos: number | null; avgPos: number | null; bounces: number;
  tags: DomainTag[];
}

export interface DomainQuery {
  preset?: "all" | "new" | "young" | "rising" | "falling" | "bounced";
  q?: string; maxAgeMonths?: number; includePlatforms?: boolean;
  sort?: "keywords" | "top10" | "bestPos" | "firstSeen" | "age" | "dr" | "links";
  page?: number; pageSize?: number;
}

export interface KeywordHistory {
  snapshots: { id: string; takenAt: string; status: SnapshotStatus; problem: string | null;
               detail: string | null;
               depth: number; got: number; volatility: number | null; changeCount: number }[];
  hosts: { host: string; series: (number | null)[] }[];   // ≤ 10 hosts with most presence; series aligned to snapshots
}

export interface SnapshotView {
  id: string; takenAt: string; status: SnapshotStatus; problem: string | null; depth: number; got: number;
  rows: SerpRow[];
  compare: { id: string; takenAt: string; rows: SerpRow[]; diff: KeywordDiff } | null;
}
