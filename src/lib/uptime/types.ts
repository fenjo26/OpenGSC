export type UptimeStatus = "up" | "degraded" | "down" | "unknown" | "paused" | "checker_offline";

export type UptimeCause =
  | "timeout" | "dns" | "tls" | "connect" | "http_status"
  | "keyword_missing" | "redirect_loop" | "blocked_target" | "other";

export const UPTIME_INTERVALS = [1, 3, 5, 10, 15, 30, 60] as const;
export const UPTIME_RAW_RETENTION_DAYS = 7;
export const UPTIME_CONFIRM_RECHECK_MS = 30_000;   // first failure → one quick re-check
export const UPTIME_OFFLINE_RATIO = 0.8;           // ≥ 80 % of ≥ 3 monitors fail in one tick → checker_offline

export interface UptimeWorkspaceSettings {
  autoEnroll: boolean;          // create a monitor for every live (not archived, not hidden) site
  defaultIntervalMin: number;   // one of UPTIME_INTERVALS
  reminderHours: number;        // 0 = no "still down" reminders
  heartbeatUrl: string;         // dead-man's switch pinged every scheduler tick; "" = off
  notifyDegraded: boolean;      // alert on degraded too (default false)
}

export const DEFAULT_UPTIME_SETTINGS: UptimeWorkspaceSettings = {
  autoEnroll: true, defaultIntervalMin: 5, reminderHours: 6, heartbeatUrl: "", notifyDegraded: false,
};

export interface UptimeCheckResult {
  ok: boolean;
  status: "up" | "degraded" | "down";
  httpStatus: number | null;
  latencyMs: number | null;
  cause: UptimeCause | null;
  detail: string | null;
  finalUrl: string | null;
}

/** Light per-site row for the dashboard dot. */
export interface UptimeBadge {
  siteId: string;
  status: UptimeStatus;
  since: string | null;         // ISO
  latencyMs: number | null;
  uptime24h: number | null;     // 0..100, null = no checks yet
  lastError: string | null;
}

export interface UptimeSummary {
  monitor: {
    id: string; url: string; enabled: boolean; intervalMin: number; timeoutMs: number;
    acceptStatus: string; keyword: string; slowMs: number; failThreshold: number; alerts: boolean;
  };
  badge: UptimeBadge;
  uptime: { d1: number | null; d7: number | null; d30: number | null; d90: number | null };
  latency: { day: string; avg: number | null; max: number | null }[];   // last 30 days
  incidents: { id: string; startedAt: string; endedAt: string | null; durationMs: number | null; cause: UptimeCause; detail: string | null; httpStatus: number | null }[];
}
