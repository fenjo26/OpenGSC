// The only module in src/lib/uptime that talks to the database, apart from the scheduler.
// Everything pure (classification, the state machine) lives in check.ts / state.ts so it can be
// tested without one.
//
// The Uptime* models are reached through an untyped accessor for the same reason `drops/store`
// does it: the generated client only learns about a model after `prisma db push`, and this app
// pushes at container start. An instance that pulled the code but has not restarted yet gets
// `{ notMigrated: true }` (uptimeSchemaMissing) rather than a 500.

import { prisma } from "@/lib/prisma";
import { rawQuery } from "@/lib/db/raw";
import { parseAcceptStatus } from "./check";
import { DEFAULT_UPTIME_SETTINGS, UPTIME_INTERVALS } from "./types";
import type { UptimeBadge, UptimeSummary, UptimeWorkspaceSettings } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema
const db = prisma as any;

/** True when the failure is "the Uptime tables/columns do not exist", not a real error. */
export function uptimeSchemaMissing(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" ||
    value?.code === "P2022" ||
    /Uptime(?:Monitor|Check|Daily|Incident).*(?:does not exist|no such table|no such column)/i.test(String(value?.message ?? "")) ||
    /no such column: (?:.*uptimeSettings|"User".uptimeSettings)/i.test(String(value?.message ?? ""))
  );
}

/** An error the routes translate into `{ error: code }`. */
export class UptimeInputError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "UptimeInputError";
  }
}

// ─── checker_offline flag ─────────────────────────────────────────────────────
// Set by the scheduler in memory when a tick's failures look like the server's own network
// died (state.ts isCheckerOffline). Kept out of the `status` column on purpose: it describes
// the checker, not the site, and it ends the moment a normal tick completes.

let checkerOffline = false;

export function markCheckerOffline(): void { checkerOffline = true; }
export function clearCheckerOffline(): void { checkerOffline = false; }
export function checkerOfflineNow(): boolean { return checkerOffline; }

// ─── helpers ──────────────────────────────────────────────────────────────────

/** "YYYY-MM-DD" of a date in UTC — the UptimeDaily key. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The URL a monitor watches by default: the site root. sc-domain:example.com →
 *  https://example.com/; a URL property (https://example.com/path/) is itself. */
export function siteRootUrl(site: { siteId: string; url: string }): string {
  if (site.siteId.startsWith("sc-domain:")) {
    const domain = site.siteId.slice("sc-domain:".length).replace(/\/+$/, "");
    return `https://${domain}/`;
  }
  if (/^https?:\/\//i.test(site.siteId)) return site.siteId;
  // defensive: a bare-domain property (not a shape GSC produces today)
  const domain = String(site.url ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${domain}/`;
}

function badgeStatus(m: { enabled: boolean; status: string }): UptimeBadge["status"] {
  if (!m.enabled) return "paused";
  if (checkerOffline) return "checker_offline";
  return m.status as UptimeBadge["status"];
}

function badgeOf(m: Record<string, unknown>): UptimeBadge {
  return {
    siteId: (m.siteId as string) ?? "",
    status: badgeStatus(m as { enabled: boolean; status: string }),
    since: m.statusSince ? new Date(m.statusSince as Date).toISOString() : null,
    latencyMs: (m.lastLatencyMs as number | null) ?? null,
    uptime24h: null, // filled by the raw-check aggregate below
    lastError: (m.lastError as string | null) ?? null,
  };
}

/** Share of ok checks over the last 24 h, straight from the raw UptimeCheck rows (retention
 *  keeps 7 days, so the window is always there). One aggregate query for all monitors — the
 *  UptimeDaily alternative would straddle two UTC days and blur the "24 h" the label promises. */
async function uptime24hByMonitor(monitorIds: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (!monitorIds.length) return out;
  const rows = await rawQuery<{ monitorId: string; checks: number | bigint; fails: number | bigint }[]>(
    `SELECT "monitorId" AS monitorId, COUNT(*) AS checks, SUM(CASE WHEN ok THEN 0 ELSE 1 END) AS fails
     FROM "UptimeCheck" WHERE "checkedAt" >= ? AND "monitorId" IN (${monitorIds.map(() => "?").join(",")})
     GROUP BY "monitorId"`,
    new Date(Date.now() - 24 * 3600_000),
    ...monitorIds,
  );
  for (const id of monitorIds) out.set(id, null);
  for (const r of rows ?? []) {
    const checks = Number(r.checks);
    const fails = Number(r.fails);
    if (checks > 0) out.set(String(r.monitorId), Math.round((1 - fails / checks) * 1000) / 10);
  }
  return out;
}

// ─── dashboard badges ─────────────────────────────────────────────────────────

/** One row per monitored site of the workspace, for the dashboard dots. Two queries: the
 *  monitors (with their sites) and the 24 h raw-check aggregate. */
export async function uptimeBadges(userId: string): Promise<UptimeBadge[]> {
  const monitors: Record<string, unknown>[] = await db.uptimeMonitor.findMany({
    where: { site: { userId } },
    select: { id: true, siteId: true, enabled: true, status: true, statusSince: true, lastLatencyMs: true, lastError: true },
  });
  if (!monitors.length) return [];
  // The 24 h aggregate is keyed by MONITOR id (UptimeCheck.monitorId), not by the site id the
  // badge carries — two different columns that happen to share a name with the FK.
  const stats = await uptime24hByMonitor(monitors.map(m => String(m.id)));
  return monitors.map(m => {
    const badge = badgeOf(m);
    badge.uptime24h = stats.get(String(m.id)) ?? null;
    return badge;
  });
}

// ─── per-site summary ─────────────────────────────────────────────────────────

/** Uptime % over UptimeDaily rows of a window; null when nothing was checked in it. */
function pctOver(daily: { day: string; checks: number; fails: number }[], fromDay: string): number | null {
  let checks = 0, fails = 0;
  for (const d of daily) if (d.day >= fromDay) { checks += d.checks; fails += d.fails; }
  if (checks <= 0) return null;
  return Math.round((1 - fails / checks) * 1000) / 10;
}

export async function uptimeSummary(userId: string, siteId: string): Promise<UptimeSummary | null> {
  const m: Record<string, unknown> | null = await db.uptimeMonitor.findFirst({
    where: { siteId, site: { userId } },
    include: { incidents: { orderBy: { startedAt: "desc" }, take: 20 } },
  });
  if (!m) return null;
  const today = utcDay(new Date());
  const dayFrom = (n: number) => utcDay(new Date(Date.now() - (n - 1) * 86_400_000));
  const daily: { day: string; checks: number; fails: number; latencySum: number; latencyMax: number }[] =
    await db.uptimeDaily.findMany({ where: { monitorId: m.id }, orderBy: { day: "asc" } });
  const window = daily.filter(d => d.day >= dayFrom(30));

  const badge = badgeOf(m);
  const stats = await uptime24hByMonitor([String(m.id)]);
  badge.uptime24h = stats.get(String(m.id)) ?? null;

  const latency: UptimeSummary["latency"] = window.map(d => {
    const ok = Math.max(0, d.checks - d.fails);
    return {
      day: d.day,
      avg: ok > 0 ? Math.round(d.latencySum / ok) : null,
      max: d.latencyMax > 0 ? d.latencyMax : null,
    };
  });

  const incidents: UptimeSummary["incidents"] = ((m.incidents as Record<string, unknown>[]) ?? []).map(i => ({
    id: String(i.id),
    startedAt: new Date(i.startedAt as Date).toISOString(),
    endedAt: i.endedAt ? new Date(i.endedAt as Date).toISOString() : null,
    durationMs: i.endedAt
      ? new Date(i.endedAt as Date).getTime() - new Date(i.startedAt as Date).getTime()
      : null,
    cause: String(i.cause ?? "other") as UptimeSummary["incidents"][number]["cause"],
    detail: (i.detail as string | null) ?? null,
    httpStatus: (i.httpStatus as number | null) ?? null,
  }));

  return {
    monitor: {
      id: String(m.id),
      url: String(m.url ?? ""),
      enabled: Boolean(m.enabled),
      intervalMin: Number(m.intervalMin ?? 5),
      timeoutMs: Number(m.timeoutMs ?? 15_000),
      acceptStatus: String(m.acceptStatus ?? "200-399"),
      keyword: String(m.keyword ?? ""),
      slowMs: Number(m.slowMs ?? 5000),
      failThreshold: Number(m.failThreshold ?? 2),
      alerts: Boolean(m.alerts ?? true),
    },
    badge,
    uptime: {
      d1: pctOver(daily, today),
      d7: pctOver(daily, dayFrom(7)),
      d30: pctOver(daily, dayFrom(30)),
      d90: pctOver(daily, dayFrom(90)),
    },
    latency,
    incidents,
  };
}

// ─── monitor upsert ───────────────────────────────────────────────────────────

function cleanUrl(raw: unknown): string {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new UptimeInputError("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UptimeInputError("invalid_url");
  if (url.username || url.password) throw new UptimeInputError("invalid_url");
  return url.href;
}

const clamp = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/** Create (defaults + patch) or patch a site's monitor. A URL change resets the status to
 *  unknown and schedules the next check now — the old status describes the old page. Returns
 *  the fresh summary. */
export async function upsertMonitor(
  userId: string,
  siteId: string,
  patch: Partial<UptimeSummary["monitor"]>,
): Promise<UptimeSummary> {
  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true, siteId: true, url: true } });
  if (!site) throw new UptimeInputError("not_found");

  const data: Record<string, unknown> = {};
  if (patch.url !== undefined) data.url = cleanUrl(patch.url);
  if (patch.enabled !== undefined) data.enabled = Boolean(patch.enabled);
  if (patch.intervalMin !== undefined) {
    if (!(UPTIME_INTERVALS as readonly number[]).includes(Number(patch.intervalMin))) throw new UptimeInputError("invalid_interval");
    data.intervalMin = Number(patch.intervalMin);
  }
  if (patch.timeoutMs !== undefined) data.timeoutMs = clamp(patch.timeoutMs, 1_000, 120_000, 15_000);
  if (patch.acceptStatus !== undefined) {
    const spec = String(patch.acceptStatus).slice(0, 100);
    // must accept something; parseAcceptStatus silently falls back to 200-399 on garbage, so
    // prove the spec has at least one explicit token before that fallback kicks in
    if (!/\d{3}/.test(spec)) throw new UptimeInputError("invalid_accept");
    parseAcceptStatus(spec); // shape check (pure)
    data.acceptStatus = spec;
  }
  if (patch.keyword !== undefined) data.keyword = String(patch.keyword).slice(0, 200);
  if (patch.slowMs !== undefined) data.slowMs = clamp(patch.slowMs, 100, 600_000, 5000);
  if (patch.failThreshold !== undefined) data.failThreshold = clamp(patch.failThreshold, 1, 10, 2);
  if (patch.alerts !== undefined) data.alerts = Boolean(patch.alerts);

  const existing: Record<string, unknown> | null = await db.uptimeMonitor.findFirst({ where: { siteId } });
  const now = new Date();

  if (!existing) {
    // `url` has no schema default: a monitor created without an explicit URL watches the site
    // root (the same URL auto-enroll would use).
    await db.uptimeMonitor.create({
      data: { siteId, url: siteRootUrl(site), nextCheckAt: now, status: "unknown", ...data },
    });
  } else {
    const urlChanged = data.url !== undefined && data.url !== existing.url;
    const enabledNow = data.enabled === undefined ? existing.enabled : data.enabled;
    const wasEnabled = Boolean(existing.enabled);
    const reset = urlChanged
      ? { status: "unknown", statusSince: now, consecutiveFails: 0, lastError: null }
      : {};
    // Re-enabling checks right away; a URL change always re-checks now (above).
    const schedule = urlChanged || (enabledNow && !wasEnabled) ? { nextCheckAt: now } : {};
    await db.uptimeMonitor.update({
      where: { id: existing.id },
      data: { ...data, ...reset, ...schedule },
    });
    if (urlChanged) {
      // The incident tracked the OLD URL; close it without an alert rather than let a recovery
      // for a page nobody watches fire later.
      await db.uptimeIncident.updateMany({
        where: { monitorId: existing.id, endedAt: null },
        data: { endedAt: now },
      });
    }
  }

  const summary = await uptimeSummary(userId, siteId);
  if (!summary) throw new UptimeInputError("not_found");
  return summary;
}

// ─── workspace settings ───────────────────────────────────────────────────────

function cleanSettings(raw: unknown): UptimeWorkspaceSettings {
  const s = (raw ?? {}) as Partial<UptimeWorkspaceSettings>;
  const heartbeat = String(s.heartbeatUrl ?? "").trim();
  if (heartbeat) {
    try {
      const u = new URL(heartbeat);
      if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) throw new Error();
    } catch {
      throw new UptimeInputError("invalid_heartbeat");
    }
  }
  const interval = Number(s.defaultIntervalMin ?? DEFAULT_UPTIME_SETTINGS.defaultIntervalMin);
  if (!(UPTIME_INTERVALS as readonly number[]).includes(interval)) throw new UptimeInputError("invalid_interval");
  return {
    autoEnroll: Boolean(s.autoEnroll ?? DEFAULT_UPTIME_SETTINGS.autoEnroll),
    defaultIntervalMin: interval,
    reminderHours: clamp(s.reminderHours ?? DEFAULT_UPTIME_SETTINGS.reminderHours, 0, 168, 6),
    heartbeatUrl: heartbeat.slice(0, 500),
    notifyDegraded: Boolean(s.notifyDegraded ?? false),
  };
}

export async function getUptimeSettings(userId: string): Promise<UptimeWorkspaceSettings> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { uptimeSettings: true } });
    if (!user?.uptimeSettings) return { ...DEFAULT_UPTIME_SETTINGS };
    return cleanSettings(JSON.parse(user.uptimeSettings));
  } catch (e) {
    if (e instanceof UptimeInputError) return { ...DEFAULT_UPTIME_SETTINGS }; // stored garbage ≠ broken settings page
    if (uptimeSchemaMissing(e)) throw e; // the caller turns this into notMigrated
    return { ...DEFAULT_UPTIME_SETTINGS };
  }
}

export async function saveUptimeSettings(userId: string, s: UptimeWorkspaceSettings): Promise<void> {
  const clean = cleanSettings(s); // throws UptimeInputError on bad input
  await prisma.user.update({
    where: { id: userId },
    data: { uptimeSettings: JSON.stringify(clean) },
  });
}
