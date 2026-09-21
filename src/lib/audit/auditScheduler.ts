// Audit scheduler — the /audits counterpart of the digest/alert scheduler family
// (in-process, started from src/instrumentation.ts, state in the database).
//
// Boot: recover stale running audits the existing way, then hand every queued row to
// the queue — orders survive restarts because they are rows, not memory.
//
// Tick (every 15 min): within each workspace's configured UTC hour, every site whose
// interval has elapsed gets a scheduled order. Overlap prevention is implicit: a site
// with a running or queued audit is never due (isSiteDue). A paused workspace gets no
// scheduled orders and no new slots (flights in progress still land).

import { prisma } from "@/lib/prisma";
import { recoverStaleAudits } from "./crawler";
import { getAuditQueueSettings, isSiteDue, kickAuditQueue, siteIntervalDays } from "./queue";

const TICK_MS = 15 * 60 * 1000;
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
    // All of a workspace's sites share one hour window; within it the first tick creates
    // the orders and the later ticks see them queued and skip — no double batches.
    if (now.getUTCHours() !== settings.scheduleHourUtc) continue;

    const sites = await prisma.site.findMany({
      where: { userId: user.id, archivedAt: null, hidden: false },
      select: { id: true, auditSettings: true },
    }).catch(() => []);
    for (const site of sites) {
      const intervalDays = siteIntervalDays(site.auditSettings, settings);
      if (!intervalDays) continue;
      const latest = await prisma.siteAudit.findFirst({
        where: { siteId: site.id },
        orderBy: { startedAt: "desc" },
        select: { status: true, finishedAt: true },
      }).catch(() => null);
      if (!isSiteDue(latest, intervalDays, now.getTime())) continue;
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
    }
  }
  kickAuditQueue();
}
