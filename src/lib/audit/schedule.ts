// Pure audit-scheduling vocabulary — imports only the pure cron matcher, safe for client
// and server alike. The queue (server) and the /audits page (client) must agree on what
// an interval or a due site means, so the definitions live here instead of being mirrored.

import { validateCron } from "../cron";

export interface AuditQueueSettings {
  concurrency: number;        // max simultaneous audits for this workspace (slider, not a cap)
  defaultIntervalDays: number; // scheduler interval for sites on "inherit"
  scheduleHourUtc: number;    // interval-mode batches are only created within this UTC hour
  defaultCron: string | null; // when set (valid), inherit-sites follow this cron instead of the interval
  retryAttempts: number;      // extra tries beyond the first (0 = fail once)
  retryDelayMin: number;      // wait before a retried run becomes slot-eligible
  paused: boolean;            // stop starting new audits; runs in flight finish
}

export const DEFAULT_AUDIT_QUEUE_SETTINGS: AuditQueueSettings = {
  concurrency: 2,
  defaultIntervalDays: 7,
  scheduleHourUtc: 3,
  defaultCron: null,
  retryAttempts: 1,
  retryDelayMin: 15,
  paused: false,
};

export function parseAuditQueueSettings(raw: string | null | undefined): AuditQueueSettings {
  if (!raw) return { ...DEFAULT_AUDIT_QUEUE_SETTINGS };
  try {
    const parsed = JSON.parse(raw);
    const num = (v: unknown, def: number, min: number, max: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def;
    const rawCron = typeof parsed?.defaultCron === "string" ? parsed.defaultCron.trim() : "";
    return {
      concurrency: num(parsed?.concurrency, DEFAULT_AUDIT_QUEUE_SETTINGS.concurrency, 1, 16),
      defaultIntervalDays: num(parsed?.defaultIntervalDays, DEFAULT_AUDIT_QUEUE_SETTINGS.defaultIntervalDays, 1, 365),
      scheduleHourUtc: num(parsed?.scheduleHourUtc, DEFAULT_AUDIT_QUEUE_SETTINGS.scheduleHourUtc, 0, 23),
      // stored raw; an invalid expression is ignored at use time (effectiveAuditSchedule)
      defaultCron: rawCron || null,
      retryAttempts: num(parsed?.retryAttempts, DEFAULT_AUDIT_QUEUE_SETTINGS.retryAttempts, 0, 5),
      retryDelayMin: num(parsed?.retryDelayMin, DEFAULT_AUDIT_QUEUE_SETTINGS.retryDelayMin, 1, 1440),
      paused: parsed?.paused === true,
    };
  } catch {
    return { ...DEFAULT_AUDIT_QUEUE_SETTINGS };
  }
}

export interface SiteAuditScheduleSettings {
  mode: "inherit" | "custom" | "off" | "cron";
  intervalDays?: number;
  cron?: string;
  lastFire?: string; // ISO — the scheduler's high-water mark for cron schedules
}

export function parseSiteAuditSettings(raw: string | null | undefined): SiteAuditScheduleSettings {
  if (!raw) return { mode: "inherit" };
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.mode === "off") return { mode: "off" };
    if (parsed?.mode === "cron" && typeof parsed?.cron === "string" && parsed.cron.trim()) {
      return { mode: "cron", cron: parsed.cron.trim() };
    }
    if (parsed?.mode === "custom" && typeof parsed?.intervalDays === "number" && Number.isFinite(parsed.intervalDays)) {
      return { mode: "custom", intervalDays: Math.min(365, Math.max(1, Math.round(parsed.intervalDays))) };
    }
  } catch { /* legacy or garbage — inherit */ }
  return { mode: "inherit" };
}

// What the scheduler will actually run a site on. Precedence: the site's own cron, then
// the site's own interval, then the workspace default cron, then the workspace interval
// + hour. An invalid stored expression is treated as absent rather than guessed at.
export type EffectiveAuditSchedule =
  | { kind: "off" }
  | { kind: "interval"; days: number; hourUtc: number }
  | { kind: "cron"; expr: string };

export function effectiveAuditSchedule(
  siteAuditSettings: string | null | undefined,
  queue: AuditQueueSettings,
): EffectiveAuditSchedule {
  const s = parseSiteAuditSettings(siteAuditSettings);
  if (s.mode === "off") return { kind: "off" };
  if (s.mode === "cron" && s.cron && validateCron(s.cron) === null) return { kind: "cron", expr: s.cron };
  if (s.mode === "custom") {
    return { kind: "interval", days: s.intervalDays ?? queue.defaultIntervalDays, hourUtc: queue.scheduleHourUtc };
  }
  if (queue.defaultCron && validateCron(queue.defaultCron) === null) return { kind: "cron", expr: queue.defaultCron };
  return { kind: "interval", days: queue.defaultIntervalDays, hourUtc: queue.scheduleHourUtc };
}

// Effective interval in days for a site, or null when automatic audits are off for it.
export function siteIntervalDays(siteAuditSettings: string | null | undefined, queue: AuditQueueSettings): number | null {
  const s = parseSiteAuditSettings(siteAuditSettings);
  if (s.mode === "off") return null;
  if (s.mode === "custom") return s.intervalDays ?? queue.defaultIntervalDays;
  return queue.defaultIntervalDays;
}

// A site is due when it has no run in flight and its latest finished attempt (completed OR
// error — an error is still an attempt, otherwise a failing site would retry every tick)
// is older than the interval. Never-audited sites are due: the scheduler is how a fresh
// portfolio gets its first batch without someone clicking 80 buttons.
export function isSiteDue(latest: { status: string; finishedAt: Date | string | null } | null, intervalDays: number, now = Date.now()): boolean {
  if (!intervalDays || intervalDays <= 0) return false;
  if (latest && (latest.status === "running" || latest.status === "queued")) return false;
  const finished = latest?.finishedAt ? new Date(latest.finishedAt).getTime() : null;
  if (finished) return now - finished >= intervalDays * 86_400_000;
  return true;
}
