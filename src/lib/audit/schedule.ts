// Pure audit-scheduling vocabulary — no imports, safe for client and server alike.
// The queue (server) and the /audits page (client) must agree on what an interval or
// a due site means, so the definitions live here instead of being mirrored.

export interface AuditQueueSettings {
  concurrency: number;        // max simultaneous audits for this workspace (slider, not a cap)
  defaultIntervalDays: number; // scheduler interval for sites on "inherit"
  scheduleHourUtc: number;    // scheduled batches are only created within this UTC hour
  retryAttempts: number;      // extra tries beyond the first (0 = fail once)
  retryDelayMin: number;      // wait before a retried run becomes slot-eligible
  paused: boolean;            // stop starting new audits; runs in flight finish
}

export const DEFAULT_AUDIT_QUEUE_SETTINGS: AuditQueueSettings = {
  concurrency: 2,
  defaultIntervalDays: 7,
  scheduleHourUtc: 3,
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
    return {
      concurrency: num(parsed?.concurrency, DEFAULT_AUDIT_QUEUE_SETTINGS.concurrency, 1, 16),
      defaultIntervalDays: num(parsed?.defaultIntervalDays, DEFAULT_AUDIT_QUEUE_SETTINGS.defaultIntervalDays, 1, 365),
      scheduleHourUtc: num(parsed?.scheduleHourUtc, DEFAULT_AUDIT_QUEUE_SETTINGS.scheduleHourUtc, 0, 23),
      retryAttempts: num(parsed?.retryAttempts, DEFAULT_AUDIT_QUEUE_SETTINGS.retryAttempts, 0, 5),
      retryDelayMin: num(parsed?.retryDelayMin, DEFAULT_AUDIT_QUEUE_SETTINGS.retryDelayMin, 1, 1440),
      paused: parsed?.paused === true,
    };
  } catch {
    return { ...DEFAULT_AUDIT_QUEUE_SETTINGS };
  }
}

export interface SiteAuditScheduleSettings {
  mode: "inherit" | "custom" | "off";
  intervalDays?: number;
}

export function parseSiteAuditSettings(raw: string | null | undefined): SiteAuditScheduleSettings {
  if (!raw) return { mode: "inherit" };
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.mode === "off") return { mode: "off" };
    if (parsed?.mode === "custom" && typeof parsed?.intervalDays === "number" && Number.isFinite(parsed.intervalDays)) {
      return { mode: "custom", intervalDays: Math.min(365, Math.max(1, Math.round(parsed.intervalDays))) };
    }
  } catch { /* legacy or garbage — inherit */ }
  return { mode: "inherit" };
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
