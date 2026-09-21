// Audit scheduler — the /audits counterpart of the digest/alert scheduler family
// (in-process, started from src/instrumentation.ts, state in the database).
//
// Boot: recover stale running audits the existing way, then hand every queued row to
// the queue — orders survive restarts because they are rows, not memory.
//
// Tick (every 15 min): per site, the effective schedule (src/lib/audit/schedule.ts)
// is either interval-based or a 5-field cron expression.
//   interval — inside the workspace's configured UTC hour, a site whose latest finished
//     attempt (completed OR error — an error is still an attempt) is older than the
//     interval gets a scheduled order. Never-audited sites are due: the scheduler is how
//     a fresh portfolio gets its first batch.
//   cron — if the expression fired since the site's lastFire marker (a high-water mark
//     kept in Site.auditSettings JSON) and no run is in flight, one order is created and
//     the marker advances. A first sighting only adopts the marker without firing, so a
//     site moved onto cron never gets a retroactive burst; downtime is deliberately
//     missed rather than stacked. A run in flight holds the marker back — the missed
//     window fires on a later tick once the site is free (catch-up, once).
//
// A paused workspace gets no scheduled orders and no new slots (flights still land).

import { prisma } from "@/lib/prisma";
import { recoverStaleAudits } from "./crawler";
import { getAuditQueueSettings, kickAuditQueue } from "./queue";
import { effectiveAuditSchedule, isSiteDue } from "./schedule";
import { latestFireAtOrBefore } from "../cron";

const TICK_MS = 15 * 60 * 1000;
// Fires are detected by walking back from "now"; the window covers several missed ticks
// so a single slow tick can't skip a fire, but nothing older (downtime is a miss).
const CRON_SCAN_MINUTES = 60;

let started = false;

export function startAuditScheduler(): void {
  if (started) return;
  started = true;

  // Boot recovery: give the process a moment to finish coming up first, same as the
  // drops/serpmon schedulers.
  setTimeout(() => {
    recoverStaleAudits().catch(err => console.error("[audit-scheduler] recover failed:", err));
    kickAuditQueue(5_000);
  }, 10_000);

  setInterval(() => {
    tick().catch(err => console.error("[audit-scheduler] tick failed:", err));
  }, TICK_MS);

  // Safety net: enqueues and settles kick the queue on their own, but a slow heartbeat
  // also re-pumps once a minute so a missed kick can't strand an order.
  setInterval(() => kickAuditQueue(), 60_000);
}

async function tick(): Promise<void> {
  const users = await prisma.user.findMany({ select: { id: true, auditQueueSettings: true } }).catch(() => []);
  const now = new Date();
  for (const user of users) {
    const settings = await getAuditQueueSettings(user.id);
    if (settings.paused) continue;

    const sites = await prisma.site.findMany({
      where: { userId: user.id, archivedAt: null, hidden: false },
      select: { id: true, auditSettings: true },
    }).catch(() => []);
    for (const site of sites) {
      const sched = effectiveAuditSchedule(site.auditSettings, settings);

      if (sched.kind === "off") continue;

      if (sched.kind === "interval") {
        // All of a workspace's interval sites share one hour window; within it the first
        // tick creates the orders and the later ticks see them queued and skip.
        if (now.getUTCHours() !== sched.hourUtc) continue;
        const latest = await prisma.siteAudit.findFirst({
          where: { siteId: site.id },
          orderBy: { startedAt: "desc" },
          select: { status: true, finishedAt: true },
        }).catch(() => null);
        if (!isSiteDue(latest, sched.days, now.getTime())) continue;
        await prisma.siteAudit.create({
          data: {
            siteId: site.id,
            status: "queued",
            stage: "crawl",
            progress: 0,
            trigger: "scheduled",
            heartbeatAt: now,
            maxPages: 5000,
          },
        }).catch(() => {});
        continue;
      }

      // cron schedule
      const latestFire = latestFireAtOrBefore(sched.expr, now, CRON_SCAN_MINUTES);
      if (!latestFire) continue;
      let lastFireMs: number | null = null;
      try {
        const stored = site.auditSettings ? JSON.parse(site.auditSettings)?.lastFire : null;
        if (typeof stored === "string") lastFireMs = Date.parse(stored) || null;
      } catch { /* no marker yet */ }
      if (lastFireMs === null) {
        // First sighting on cron: adopt the marker, don't fire.
        await setSiteLastFire(site.id, site.auditSettings, latestFire);
        continue;
      }
      if (latestFire.getTime() <= lastFireMs) continue;
      const inFlight = await prisma.siteAudit.findFirst({
        where: { siteId: site.id, status: { in: ["running", "queued"] } },
        select: { id: true },
      }).catch(() => null);
      if (inFlight) continue; // hold the marker back; catch up on a later tick
      await prisma.siteAudit.create({
        data: {
          siteId: site.id,
          status: "queued",
          stage: "crawl",
          progress: 0,
          trigger: "scheduled",
          heartbeatAt: now,
          maxPages: 5000,
        },
      }).catch(() => {});
      await setSiteLastFire(site.id, site.auditSettings, latestFire);
    }
  }
  kickAuditQueue();
}

// The marker shares the Site.auditSettings JSON with the mode/cron fields an operator
// edits — merge, never overwrite, so a UI change made between the read and this write
// survives.
async function setSiteLastFire(siteId: string, raw: string | null, fire: Date): Promise<void> {
  let parsed: Record<string, unknown> = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* nothing to preserve */ }
  await prisma.site.update({
    where: { id: siteId },
    data: { auditSettings: JSON.stringify({ ...parsed, lastFire: fire.toISOString() }) },
  }).catch(() => {});
}
