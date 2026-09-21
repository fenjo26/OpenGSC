// Audit queue — durable orders, in-process slots.
//
// The queue's state lives in the database: a SiteAudit row with status "queued" IS the
// order, so a reload or restart loses nothing (the scheduler re-picks orphaned rows on
// boot). This module only decides which queued rows get one of the workspace's
// concurrency slots, applies the retry policy to failed runs, and exposes the
// pause / cancel / retry-failed actions the audits page offers.
//
// Settings follow the digestSettings convention: one JSON column per owner
// (User.auditQueueSettings for the queue, Site.auditSettings for per-site scheduling),
// defaults in code, the column written only when an operator changes something.

import { prisma } from "@/lib/prisma";
import { runAudit, storedOptions } from "./crawler";
import { AuditQueueSettings, parseAuditQueueSettings } from "./schedule";

export {
  DEFAULT_AUDIT_QUEUE_SETTINGS,
  parseAuditQueueSettings,
  parseSiteAuditSettings,
  siteIntervalDays,
  isSiteDue,
} from "./schedule";
export type { AuditQueueSettings, SiteAuditScheduleSettings } from "./schedule";

export async function getAuditQueueSettings(userId: string): Promise<AuditQueueSettings> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { auditQueueSettings: true } }).catch(() => null);
  return parseAuditQueueSettings(user?.auditQueueSettings);
}

export async function saveAuditQueueSettings(userId: string, s: AuditQueueSettings): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { auditQueueSettings: JSON.stringify(s) } });
}

// ── queue mechanics ───────────────────────────────────────────────────────────────

// userId -> auditIds currently holding a slot in this process. Concurrency is per
// workspace: two operators sharing one instance don't eat each other's slots.
const inFlightByUser = new Map<string, Set<string>>();
let pumping = false;
let pumpTimer: NodeJS.Timeout | null = null;

export function kickAuditQueue(delayMs = 250): void {
  if (pumpTimer) return;
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    pumpAuditQueue().catch(err => console.error("[audit-queue] pump failed:", err));
  }, delayMs);
}

async function pumpAuditQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    // Eligible orders: due for a slot, oldest first. The take bounds one pass; the queue
    // re-kicks itself after every settle, so a long backlog drains in waves, not in one loop.
    const candidates = await prisma.siteAudit.findMany({
      where: { status: "queued", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
      orderBy: { startedAt: "asc" },
      take: 25,
      select: { id: true, siteId: true, options: true, site: { select: { userId: true } } },
    }).catch(() => []);

    for (const row of candidates) {
      const userId = row.site?.userId;
      if (!userId) continue;
      const settings = await getAuditQueueSettings(userId);
      if (settings.paused) continue;
      const inFlight = inFlightByUser.get(userId) ?? new Set<string>();
      if (inFlight.size >= settings.concurrency) continue;
      // One running audit per site — the same rule POST /api/audit enforces for manual runs.
      const busy = await prisma.siteAudit.findFirst({
        where: { siteId: row.siteId, status: "running", id: { not: row.id } },
        select: { id: true },
      }).catch(() => null);
      if (busy) continue;
      // Atomic claim: only one pump can move the row out of "queued" (same lock style as
      // recoverStaleAudits).
      const claimed = await prisma.siteAudit.updateMany({
        where: { id: row.id, status: "queued" },
        data: { status: "running", heartbeatAt: new Date() },
      }).catch(() => ({ count: 0 }));
      if (!claimed.count) continue;

      inFlight.add(row.id);
      inFlightByUser.set(userId, inFlight);
      runAudit(row.id, storedOptions(row.options))
        .catch(err => console.error("[audit-queue] run failed:", err))
        .finally(() => { settleAudit(row.id, userId).catch(() => {}); });
    }
  } finally {
    pumping = false;
  }
}

// Runs after an audit finishes (either way): releases the slot and applies the retry
// policy to failures. runAudit never throws (it catches internally and marks the row
// "error"), so reading the row back is the honest way to learn the outcome.
async function settleAudit(auditId: string, userId: string): Promise<void> {
  const inFlight = inFlightByUser.get(userId);
  if (inFlight) { inFlight.delete(auditId); if (!inFlight.size) inFlightByUser.delete(userId); }
  try {
    const settings = await getAuditQueueSettings(userId);
    const row = await prisma.siteAudit.findUnique({ where: { id: auditId }, select: { status: true, attempt: true } });
    if (row?.status !== "error") return;
    // attempt counts the try that just failed (1 = first). Total allowed = 1 + retryAttempts.
    if ((row.attempt ?? 1) >= 1 + Math.max(0, settings.retryAttempts)) return;
    await prisma.siteAudit.update({
      where: { id: auditId },
      data: {
        status: "queued",
        trigger: "retry",
        attempt: { increment: 1 },
        nextAttemptAt: new Date(Date.now() + settings.retryDelayMin * 60_000),
        heartbeatAt: new Date(),
      },
    });
  } finally {
    kickAuditQueue();
  }
}

// ── actions (POST /api/audit/queue/action) ────────────────────────────────────────

// Cancel deletes queued orders, not history: a run that never started is not an event.
// Runs already holding a slot are left to finish — cancelling a crawl midway would
// leave half a report with no honest status for it.
export async function cancelQueuedAudits(userId: string): Promise<number> {
  const res = await prisma.siteAudit.deleteMany({ where: { status: "queued", site: { userId } } });
  kickAuditQueue();
  return res.count;
}

// Retry-failed requeues the LATEST failed audit per site (retrying every historical
// failure of a site would pile duplicates onto one slot) — sites with a run in flight
// are skipped and stay skipped until the next action.
export async function retryFailedAudits(userId: string): Promise<number> {
  const failed = await prisma.siteAudit.findMany({
    where: { status: "error", site: { userId } },
    orderBy: { startedAt: "desc" },
    select: { id: true, siteId: true, startedAt: true },
  });
  const latestPerSite = new Map<string, { id: string; startedAt: Date }>();
  for (const row of failed) {
    const prev = latestPerSite.get(row.siteId);
    if (!prev || row.startedAt > prev.startedAt) latestPerSite.set(row.siteId, { id: row.id, startedAt: row.startedAt });
  }
  let count = 0;
  for (const [siteId, latest] of latestPerSite) {
    const busy = await prisma.siteAudit.findFirst({
      where: { siteId, status: { in: ["running", "queued"] } },
      select: { id: true },
    }).catch(() => null);
    if (busy) continue;
    const claimed = await prisma.siteAudit.updateMany({
      where: { id: latest.id, status: "error" },
      data: { status: "queued", trigger: "retry", attempt: { increment: 1 }, nextAttemptAt: null, heartbeatAt: new Date() },
    }).catch(() => ({ count: 0 }));
    count += claimed.count;
  }
  if (count) kickAuditQueue();
  return count;
}

export async function setAuditQueuePaused(userId: string, paused: boolean): Promise<AuditQueueSettings> {
  const settings = await getAuditQueueSettings(userId);
  const next = { ...settings, paused };
  await saveAuditQueueSettings(userId, next);
  return next;
}
