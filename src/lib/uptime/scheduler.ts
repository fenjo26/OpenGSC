// Uptime scheduler — the in-process loop that checks every enabled monitor, moves the state
// machine, records incidents and delivers alerts. Same shape as serpmon/scheduler.ts: started
// from instrumentation, a `running` flag against overlap, permanently disabled when the Uptime
// tables have not been pushed yet.
//
// Tick = 30 s. Per tick:
//   1. auto-enroll (every 10 min): a monitor for every live site of a workspace with autoEnroll;
//   2. raw-check retention (once a day): UptimeCheck older than 7 days goes away;
//   3. heartbeats (≤ 1/min per URL): the dead-man's switch for the server itself;
//   4. due monitors (enabled, nextCheckAt ≤ now, ≤ 50) checked at parallelism 8;
//   5. if the tick smells like the server's own network died (state.ts isCheckerOffline), the
//      results are recorded but move nothing, alert nothing, and every monitor shows
//      checker_offline until the first normal tick;
//   6. otherwise each result goes through nextState + the incident lifecycle + UptimeDaily;
//   7. alerts that failed to deliver get retried (≤ 3 attempts).
//
// External calls run inside withCallContext like alertScheduler does, but through plain
// safeFetch — NOT loggedFetch: a monitor check is not a provider call, and 50 sites × 5 min
// would drown the provider log (14k rows/day of noise).

import { prisma } from "@/lib/prisma";
import { rawExec } from "@/lib/db/raw";
import { notifyUser } from "@/lib/notify";
import { NOTIFY_L, formatDuration, type NotifyLang } from "@/lib/notifyI18n";
import { safeFetch } from "@/lib/security/safeFetch";
import { withCallContext } from "@/lib/providerLog/context";
import { getAlertSettings } from "@/lib/alertScheduler";
import { runUptimeCheck } from "./check";
import { isCheckerOffline, nextState, type MonitorState } from "./state";
import {
  UptimeInputError, clearCheckerOffline, getUptimeSettings,
  markCheckerOffline, siteRootUrl, utcDay, uptimeSchemaMissing,
} from "./store";
import { UPTIME_CONFIRM_RECHECK_MS, UPTIME_RAW_RETENTION_DAYS, type UptimeCheckResult, type UptimeCause, type UptimeWorkspaceSettings } from "./types";

const TICK_MS = 30_000;
const FIRST_TICK_MS = 20_000;
const DUE_LIMIT = 50;
const PARALLELISM = 8;
const AUTOENROLL_EVERY_MS = 10 * 60_000;
const RETENTION_EVERY_MS = 24 * 3600_000;
const HEARTBEAT_MIN_MS = 60_000;
const ALERT_RETRY_WINDOW_MS = 30 * 60_000;
const ALERT_RETRY_MAX = 3;
const DETAIL_MAX = 300;

let started = false;
let running = false;
let kickQueued = false;
let disabled = false;
let lastAutoEnrollAt = 0;
let lastRetentionAt = 0;
/** siteIds whose owner opted out of autoEnroll, so the auto-enroll query stops re-fetching them. */
const autoEnrollSkipped = new Set<string>();
/** Last heartbeat ping per URL — one ping a minute is the dead-man contract. */
const heartbeatLast = new Map<string, number>();
/** Delivery attempts per unsent AlertEvent id (in memory; the 30-min window bounds restarts). */
const alertAttempts = new Map<string, number>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema
const db = prisma as any;

// ─── small helpers ────────────────────────────────────────────────────────────

const lastErrorOf = (r: UptimeCheckResult): string | null =>
  r.ok ? null : `${r.cause}${r.detail ? `: ${r.detail}` : ""}`.slice(0, DETAIL_MAX);

function siteLabel(site: { siteId: string; url: string }): string {
  if (site.siteId.startsWith("sc-domain:")) return site.siteId.slice("sc-domain:".length);
  try { return new URL(site.siteId).hostname; } catch { return site.url || site.siteId; }
}

/** Per-tick caches so a tick touching 50 monitors of one owner reads settings once. */
class OwnerCache {
  private langs = new Map<string, NotifyLang>();
  private settings = new Map<string, UptimeWorkspaceSettings | null>();

  async lang(userId: string): Promise<NotifyLang> {
    if (!this.langs.has(userId)) {
      try { this.langs.set(userId, (await getAlertSettings(userId)).lang); }
      catch { this.langs.set(userId, "en"); }
    }
    return this.langs.get(userId)!;
  }

  async settingsOf(userId: string): Promise<UptimeWorkspaceSettings | null> {
    if (!this.settings.has(userId)) {
      try { this.settings.set(userId, await getUptimeSettings(userId)); }
      catch (e) {
        if (uptimeSchemaMissing(e)) throw e;
        this.settings.set(userId, null);
      }
    }
    return this.settings.get(userId)!;
  }
}

/** Increment the day's counters. latencyMax is written with a portable CASE (SQLite MAX(a,b)
 *  is scalar but MySQL's is not). The update-first order avoids a read and races a parallel
 *  insert against the composite primary key. */
async function bumpDaily(
  monitorId: string, day: string,
  cols: { checks: number; fails: number; latencySum: number; latencyMax: number },
): Promise<void> {
  const sql = `UPDATE "UptimeDaily" SET checks = checks + ?, fails = fails + ?, latencySum = "latencySum" + ?, latencyMax = CASE WHEN "latencyMax" < ? THEN ? ELSE "latencyMax" END WHERE "monitorId" = ? AND day = ?`;
  if (await rawExec(sql, cols.checks, cols.fails, cols.latencySum, cols.latencyMax, cols.latencyMax, monitorId, day) > 0) return;
  try {
    await db.uptimeDaily.create({ data: { monitorId, day, ...cols } });
  } catch {
    await rawExec(sql, cols.checks, cols.fails, cols.latencySum, cols.latencyMax, cols.latencyMax, monitorId, day);
  }
}

/** Add `ms` to a day's downMs, creating the row when the incident is the day's first entry. */
async function bumpDownMs(monitorId: string, day: string, ms: number): Promise<void> {
  const sql = `UPDATE "UptimeDaily" SET downMs = "downMs" + ? WHERE "monitorId" = ? AND day = ?`;
  if (await rawExec(sql, ms, monitorId, day) > 0) return;
  try {
    await db.uptimeDaily.create({ data: { monitorId, day, downMs: ms } });
  } catch {
    await rawExec(sql, ms, monitorId, day);
  }
}

/** An incident's downtime split across the UTC days it overlaps — written once, at close. */
async function splitDownMs(monitorId: string, startedAt: Date, endedAt: Date): Promise<void> {
  let dayStart = new Date(`${utcDay(startedAt)}T00:00:00.000Z`).getTime();
  const end = endedAt.getTime();
  while (dayStart < end) {
    const dayEnd = dayStart + 86_400_000;
    const overlap = Math.min(end, dayEnd) - Math.max(startedAt.getTime(), dayStart);
    if (overlap > 0) await bumpDownMs(monitorId, utcDay(new Date(dayStart)), overlap);
    dayStart = dayEnd;
  }
}

// ─── alerts ───────────────────────────────────────────────────────────────────

/**
 * Record + deliver one alert. The AlertEvent row with a unique dedupeKey is the exactly-once
 * guard (a duplicate create is a silent no-op); a failed delivery leaves sent=false for the
 * retry pass, which stops after ALERT_RETRY_MAX attempts.
 */
async function fireAlert(
  userId: string, type: "uptime_down" | "uptime_up" | "uptime_reminder" | "uptime_degraded",
  dedupeKey: string, title: string, message: string,
): Promise<void> {
  try {
    await prisma.alertEvent.create({ data: { userId, type, title, message, dedupeKey } });
  } catch {
    return; // duplicate — this event already fired
  }
  const ok = await notifyUser(userId, message, { event: "uptime", title });
  if (ok) await prisma.alertEvent.updateMany({ where: { userId, dedupeKey }, data: { sent: true } });
}

/** Retry this tick's failed deliveries (≤ 3 attempts each, 30-minute window). */
async function retryUnsentAlerts(): Promise<void> {
  const rows = await prisma.alertEvent.findMany({
    where: { sent: false, type: { in: ["uptime_down", "uptime_up", "uptime_reminder", "uptime_degraded"] }, createdAt: { gte: new Date(Date.now() - ALERT_RETRY_WINDOW_MS) } },
    take: 20,
  });
  for (const row of rows) {
    const attempts = alertAttempts.get(row.id) ?? 0;
    if (attempts >= ALERT_RETRY_MAX) continue;
    alertAttempts.set(row.id, attempts + 1);
    try {
      const ok = await notifyUser(row.userId, row.message, { event: "uptime", title: row.title });
      if (ok) await prisma.alertEvent.updateMany({ where: { id: row.id }, data: { sent: true } });
    } catch (e) {
      console.warn("[uptime-cron] alert retry failed:", e);
    }
  }
}

// ─── one monitor, one result ──────────────────────────────────────────────────

interface MonitorRow {
  id: string; siteId: string; enabled: boolean; url: string; intervalMin: number; timeoutMs: number;
  acceptStatus: string; keyword: string; slowMs: number; failThreshold: number; alerts: boolean;
  status: string; statusSince: Date | null; consecutiveFails: number; lastLatencyMs: number | null;
  lastHttpStatus: number | null; lastError: string | null; nextCheckAt: Date | null;
  site: { userId: string; siteId: string; url: string };
}

async function recordCheck(monitorId: string, result: UptimeCheckResult, now: Date, daily: boolean): Promise<void> {
  await db.uptimeCheck.create({
    data: {
      monitorId, ok: result.ok, httpStatus: result.httpStatus, latencyMs: result.latencyMs,
      cause: result.cause, detail: result.detail ? result.detail.slice(0, DETAIL_MAX) : null,
      checkedAt: now,
    },
  });
  if (daily) {
    await bumpDaily(monitorId, utcDay(now), {
      checks: 1,
      fails: result.ok ? 0 : 1,
      latencySum: result.ok ? Math.max(0, result.latencyMs ?? 0) : 0,
      latencyMax: result.ok ? Math.max(0, result.latencyMs ?? 0) : 0,
    });
  }
}

/**
 * The full lifecycle of one answered check: state machine, incident bookkeeping, UptimeDaily,
 * the next schedule slot, and the alerts that ride the transitions.
 *
 * `offline` skips everything except the raw check row and the monitor's "last…" observability
 * fields — a server-network outage must not manufacture fifty down sites.
 */
async function processResult(
  monitor: MonitorRow,
  result: UptimeCheckResult,
  now: Date,
  owners: OwnerCache,
  offline: boolean,
): Promise<void> {
  await recordCheck(monitor.id, result, now, !offline);

  if (offline) {
    await db.uptimeMonitor.update({
      where: { id: monitor.id },
      data: {
        lastCheckedAt: now, lastLatencyMs: result.latencyMs, lastHttpStatus: result.httpStatus,
        lastError: lastErrorOf(result),
        // status, statusSince, consecutiveFails, nextCheckAt stay untouched on purpose: the
        // monitors stay due, so the first healthy tick re-checks them immediately.
      },
    });
    return;
  }

  const openIncident = await db.uptimeIncident.findFirst({ where: { monitorId: monitor.id, endedAt: null }, orderBy: { startedAt: "desc" } });
  const prev: MonitorState = {
    status: monitor.status as MonitorState["status"],
    consecutiveFails: monitor.consecutiveFails,
    openIncidentId: openIncident?.id ?? null,
  };
  const { state, transition } = nextState(prev, result, monitor.failThreshold);

  // Incident lifecycle: opened at the FIRST failure of a streak (so duration is not
  // undercounted by an interval), deleted when the streak dies before confirming, closed by
  // the first success after a real down.
  let incidentId = openIncident?.id ?? null;
  if (!result.ok && !openIncident) {
    const created = await db.uptimeIncident.create({
      data: {
        monitorId: monitor.id, startedAt: now,
        cause: String(result.cause ?? "other"), detail: result.detail?.slice(0, DETAIL_MAX) ?? null,
        httpStatus: result.httpStatus,
      },
    });
    incidentId = created.id;
  }
  if (result.ok && openIncident) {
    if (prev.status === "down") {
      await db.uptimeIncident.update({ where: { id: openIncident.id }, data: { endedAt: now } });
      await splitDownMs(monitor.id, new Date(openIncident.startedAt), now);
    } else {
      // Never confirmed — one flaky check is not an incident.
      await db.uptimeIncident.delete({ where: { id: openIncident.id } }).catch(() => {});
      incidentId = null;
    }
  }

  const intervalMs = Math.max(60_000, monitor.intervalMin * 60_000);
  const nextCheckAt = transition === "confirm_pending"
    ? new Date(now.getTime() + UPTIME_CONFIRM_RECHECK_MS) // quick re-check after the first failure
    : new Date(now.getTime() + intervalMs);
  await db.uptimeMonitor.update({
    where: { id: monitor.id },
    data: {
      status: state.status,
      statusSince: state.status !== prev.status ? now : monitor.statusSince,
      consecutiveFails: state.consecutiveFails,
      lastCheckedAt: now, lastLatencyMs: result.latencyMs, lastHttpStatus: result.httpStatus,
      lastError: lastErrorOf(result),
      nextCheckAt,
    },
  });

  if (!monitor.alerts) return;
  const userId = monitor.site.userId;
  const settings = await owners.settingsOf(userId);
  if (!settings) return;
  const lang = await owners.lang(userId);
  const L = NOTIFY_L[lang] ?? NOTIFY_L.en;
  const label = siteLabel(monitor.site);
  const capture = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { console.warn(`[uptime-cron] alert for ${label} failed:`, e); }
  };

  if (transition === "went_down" && incidentId) {
    const cause = L.uptimeCause((result.cause ?? "other") as UptimeCause, result.httpStatus);
    const since = now.toLocaleString(lang);
    await capture(() => fireAlert(
      userId, "uptime_down", `uptime:${incidentId}:down`,
      L.uptimeDownTitle(label),
      L.uptimeDownMsg(label, monitor.url, cause, since),
    ));
  }
  if (transition === "recovered" && openIncident && prev.status === "down") {
    const downtime = now.getTime() - new Date(openIncident.startedAt).getTime();
    await capture(() => fireAlert(
      userId, "uptime_up", `uptime:${openIncident.id}:up`,
      L.uptimeUpTitle(label),
      L.uptimeUpMsg(label, formatDuration(downtime, lang)),
    ));
  }
  if (transition === "degraded" && settings.notifyDegraded) {
    // Once a day per monitor: "slow" is a condition, not an event, and an every-5-min ping
    // about it would be the noise the switch exists to prevent.
    const day = utcDay(now);
    const text = L.uptimeDegradedMsg(label, result.latencyMs ?? 0);
    await capture(() => fireAlert(userId, "uptime_degraded", `uptime:${monitor.id}:deg:${day}`, text, text));
  }
  // "Still down" reminders, every reminderHours (0 = off), counted from the incident start.
  if (state.status === "down" && !result.ok && incidentId && settings.reminderHours > 0) {
    const remMs = settings.reminderHours * 3600_000;
    const sameIncident = openIncident && openIncident.id === incidentId ? openIncident : null;
    const startedAt = sameIncident ? new Date(sameIncident.startedAt) : now;
    const lastReminder = sameIncident?.lastReminderAt ? new Date(sameIncident.lastReminderAt).getTime() : null;
    const due = lastReminder != null
      ? now.getTime() - lastReminder >= remMs
      : now.getTime() - startedAt.getTime() >= remMs;
    if (due) {
      const n = Math.max(1, Math.floor((now.getTime() - startedAt.getTime()) / remMs));
      const text = L.uptimeStillDownMsg(label, formatDuration(now.getTime() - startedAt.getTime(), lang));
      await capture(() => fireAlert(userId, "uptime_reminder", `uptime:${incidentId}:rem:${n}`, text, text));
      await db.uptimeIncident.update({ where: { id: incidentId }, data: { lastReminderAt: now } });
    }
  }
}

// ─── periodic side jobs ───────────────────────────────────────────────────────

/** One monitor for every live (not archived, not hidden) site of an autoEnroll workspace.
 *  First checks spread randomly inside the interval so 60 fresh monitors do not fire in one
 *  second. */
async function autoEnroll(): Promise<void> {
  const sites: { id: string; userId: string; siteId: string; url: string }[] = await db.site.findMany({
    where: { archivedAt: null, hidden: false, uptimeMonitor: null },
    take: 100,
    select: { id: true, userId: true, siteId: true, url: true },
  });
  if (!sites.length) return;
  const owners = new OwnerCache();
  for (const site of sites) {
    if (autoEnrollSkipped.has(site.id)) continue;
    const settings = await owners.settingsOf(site.userId);
    if (!settings?.autoEnroll) {
      autoEnrollSkipped.add(site.id);
      continue;
    }
    const intervalMs = Math.max(60_000, settings.defaultIntervalMin * 60_000);
    const spread = Math.floor(Math.random() * intervalMs);
    try {
      await db.uptimeMonitor.create({
        data: {
          siteId: site.id,
          url: siteRootUrl(site),
          intervalMin: settings.defaultIntervalMin,
          nextCheckAt: new Date(Date.now() + spread),
          status: "unknown",
        },
      });
    } catch (e) {
      if (!uptimeSchemaMissing(e) && !/unique/i.test(String((e as { message?: string })?.message ?? ""))) {
        console.warn("[uptime-cron] auto-enroll failed:", e);
      }
    }
    autoEnrollSkipped.delete(site.id); // it has a monitor now; nothing to skip
  }
}

/** Drop raw checks older than the retention window. One statement per day — no IN lists, so
 *  the SQLite parameter ceiling never applies; the loop only repeats while rows remain. */
async function retention(): Promise<number> {
  const cutoff = new Date(Date.now() - UPTIME_RAW_RETENTION_DAYS * 86_400_000);
  let total = 0;
  for (let round = 0; round < 10; round++) {
    const n: number = await db.uptimeCheck.deleteMany({ where: { checkedAt: { lt: cutoff } } });
    total += n;
    if (!n) break;
  }
  return total;
}

/** Ping every configured heartbeat URL at most once a minute. Errors are log-only: the
 *  dead-man's switch works by the pings STOPPING, so a failed ping is the external service's
 *  signal, not ours to escalate. */
async function heartbeats(): Promise<void> {
  const users: { id: string; uptimeSettings: string | null }[] = await prisma.user.findMany({
    where: { uptimeSettings: { not: null } },
    select: { id: true, uptimeSettings: true },
  });
  const now = Date.now();
  for (const user of users) {
    let url = "";
    try { url = String(JSON.parse(user.uptimeSettings ?? "{}").heartbeatUrl ?? ""); } catch { continue; }
    if (!url) continue;
    const last = heartbeatLast.get(url) ?? 0;
    if (now - last < HEARTBEAT_MIN_MS) continue;
    heartbeatLast.set(url, now);
    await withCallContext({ userId: user.id, feature: "uptime-heartbeat", captureBodies: false }, async () => {
      try {
        await safeFetch(url, { method: "GET", timeoutMs: 10_000, maxBytes: 10_000 });
      } catch (e) {
        console.warn(`[uptime-cron] heartbeat ${url} failed:`, e instanceof Error ? e.message : e);
      }
    });
  }
}

// ─── the tick ─────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (running || disabled) return;
  running = true;
  const now0 = Date.now();
  try {
    if (now0 - lastAutoEnrollAt >= AUTOENROLL_EVERY_MS) {
      lastAutoEnrollAt = now0;
      await autoEnroll();
    }
    if (now0 - lastRetentionAt >= RETENTION_EVERY_MS) {
      lastRetentionAt = now0;
      const removed = await retention();
      if (removed > 1000) console.log(`[uptime-cron] retention removed ${removed} raw checks`);
    }
    await heartbeats();

    const due: MonitorRow[] = await db.uptimeMonitor.findMany({
      where: { enabled: true, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }] },
      orderBy: { nextCheckAt: "asc" },
      take: DUE_LIMIT,
      include: { site: { select: { userId: true, siteId: true, url: true } } },
    });
    if (!due.length) return;

    // Checks at bounded parallelism; each inside its owner's call context (attribution only —
    // safeFetch writes nothing to the provider log).
    const answers: { monitor: MonitorRow; result: UptimeCheckResult }[] = [];
    for (let i = 0; i < due.length; i += PARALLELISM) {
      const batch = due.slice(i, i + PARALLELISM);
      const results = await Promise.all(batch.map(async monitor => {
        try {
          return await withCallContext({ userId: monitor.site.userId, feature: "uptime-cron", captureBodies: false }, () =>
            runUptimeCheck(monitor));
        } catch (e) {
          // runUptimeCheck classifies its own errors; this is a local surprise (a bug, OOM).
          console.warn(`[uptime-cron] check of ${monitor.url} crashed:`, e);
          return { ok: false, status: "down" as const, httpStatus: null, latencyMs: null, cause: "other" as UptimeCause, detail: "checker error", finalUrl: null };
        }
      }));
      batch.forEach((monitor, j) => answers.push({ monitor, result: results[j] }));
    }

    // The whole tick is judged together: if ≥80% of ≥3 monitors failed with network causes,
    // it is the server's network, not fifty sites.
    const offline = isCheckerOffline(answers.map(a => ({ ok: a.result.ok, cause: a.result.cause })));
    if (offline) markCheckerOffline();
    else clearCheckerOffline();

    const owners = new OwnerCache();
    const now = new Date();
    for (const { monitor, result } of answers) {
      try {
        await processResult(monitor, result, now, owners, offline);
      } catch (e) {
        if (uptimeSchemaMissing(e)) throw e;
        console.warn(`[uptime-cron] processing ${monitor.url} failed:`, e);
      }
    }

    await retryUnsentAlerts();
  } catch (e) {
    if (uptimeSchemaMissing(e)) {
      disabled = true;
      console.warn("[uptime-cron] uptime tables missing — scheduler disabled until restart");
      return;
    }
    console.warn("[uptime-cron] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startUptimeScheduler(): void {
  if (started) return;
  started = true;
  console.log("[uptime-cron] scheduler started");
  setTimeout(() => void tick(), FIRST_TICK_MS);
  setInterval(() => void tick(), TICK_MS);
}

/** Wake the loop now (a monitor was just created/re-enabled with nextCheckAt=now). Coalesced. */
export function kickUptimeScheduler(): void {
  if (!started || running || disabled || kickQueued) return;
  kickQueued = true;
  setTimeout(() => {
    kickQueued = false;
    void tick();
  }, 0);
}

/** Manual "check now" from the Health tab. Runs the same lifecycle as a scheduled check so a
 *  manual confirmation opens the same incident and fires the same alerts; a paused monitor
 *  only records the answer. */
export async function checkMonitorNow(userId: string, siteId: string): Promise<UptimeCheckResult> {
  const monitor: MonitorRow | null = await db.uptimeMonitor.findFirst({
    where: { siteId, site: { userId } },
    include: { site: { select: { userId: true, siteId: true, url: true } } },
  });
  if (!monitor) throw new UptimeInputError("no_monitor");
  const result = await withCallContext({ userId: monitor.site.userId, feature: "uptime-manual", captureBodies: false }, () =>
    runUptimeCheck(monitor));
  const owners = new OwnerCache();
  if (monitor.enabled) {
    await processResult(monitor, result, new Date(), owners, false);
  } else {
    await recordCheck(monitor.id, result, new Date(), true);
  }
  kickUptimeScheduler(); // the state may have moved; keep the schedule honest
  return result;
}
