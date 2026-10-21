// Generation batch queue — durable orders, in-process slots.
//
// Same architecture as the audit queue (lib/audit/queue.ts): the state lives
// in the database (a SeoBatchItem with status "queued" IS the order, so a
// restart loses nothing), this module only decides which items get one of the
// workspace's concurrency slots, applies the retry policy, trips the
// circuit breaker, and exposes the pause/cancel/retry actions.
//
// The queue never re-implements generation: each claimed item spawns a SeoJob
// through the SAME detached runner the jobs API and MCP use
// (lib/seo/jobRunner.ts), so pre-flight ping, fallbacks, judge and SeoHistory
// filing behave identically whichever path started the work.

import { prisma } from "@/lib/prisma";
import { runJob } from "@/lib/seo/jobRunner";
import { resolveJobPayload, fetchSavedOutline } from "@/lib/seo/jobPayload";
import { getSiteContext, TYPED_SECTION_KEYS, SECTION_LABELS } from "@/lib/siteContext/store";
import { getGenQueueSettings } from "./settings";
import { stripSecrets } from "./plan";

// One import surface for the API routes and MCP tools.
export { getGenQueueSettings, saveGenQueueSettings, parseGenQueueSettings, DEFAULT_GEN_QUEUE_SETTINGS } from "./settings";
export { createGenBatch } from "./create";
export type { CreateBatchResult } from "./create";
export { estimateBatchCalls, ESTIMATED_CALLS } from "./plan";

// userId -> itemIds currently holding a slot in this process. Concurrency is
// per workspace: two operators sharing one instance don't eat each other's
// slots. (The provider-request ceiling is process-wide and lives in llm.ts.)
const inFlightByUser = new Map<string, Set<string>>();
let pumping = false;
let pumpTimer: NodeJS.Timeout | null = null;

export function kickGenQueue(delayMs = 250): void {
  if (pumpTimer) return;
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    pumpGenQueue().catch(err => console.error("[gen-queue] pump failed:", err));
  }, delayMs);
}

// ── site context → writing instruction ───────────────────────────────────────

/**
 * A site-bound item carries its site's Project Memory into the job: writing
 * preferences first (they are the most instruction-like), then positioning
 * and business overview. Appended to `custom` — the instruction that outranks
 * section briefs — so a 100-site batch writes in 100 site voices without the
 * agent threading 100 setting sets by hand.
 */
function siteContextInstruction(sections: { key: string; title: string; content: string }[], domain: string): string {
  const order = [...TYPED_SECTION_KEYS].reverse(); // writing_preferences last = appended first
  const parts: string[] = [];
  for (const key of order) {
    const s = sections.find(x => x.key === key);
    if (!s?.content?.trim()) continue;
    const label = SECTION_LABELS[key];
    parts.push(`[${label}]\n${s.content.trim().slice(0, 1_500)}`);
  }
  if (!parts.length) return "";
  return `[Site context for ${domain}]\n${parts.join("\n\n")}`;
}

// ── payload assembly ──────────────────────────────────────────────────────────

interface ItemRow {
  id: string;
  batchId: string;
  userId: string;
  siteId: string | null;
  phase: string;
  keyword: string;
  payload: string | null;
  status: string;
  dependsOnItemId: string | null;
  jobId: string | null;
}

/**
 * Build the genByType payload for one item: merged knobs, site-context
 * instruction, the outline for text items — then credentials through the ONE
 * shared resolver. Throws only for a text item whose outline vanished (a
 * terminal condition, not retryable) — provider problems surface later,
 * inside the job.
 */
async function buildItemPayload(item: ItemRow): Promise<Record<string, unknown>> {
  let knobs: Record<string, unknown> = {};
  try { knobs = stripSecrets(JSON.parse(item.payload ?? "{}")); } catch { /* fresh item */ }
  knobs.keyword = item.keyword;

  if (item.siteId) {
    try {
      const ctx = await getSiteContext(item.siteId);
      const block = siteContextInstruction(ctx.sections, ctx.siteDomain);
      if (block) knobs.custom = knobs.custom ? `${String(knobs.custom)}\n\n${block}` : block;
    } catch { /* no context yet — generate without it */ }
  }

  if (item.phase === "text") {
    // The outline comes from the completed dependency's jobId; the row was
    // completed when this item became eligible, so a miss here means history
    // was wiped — retrying will not fix that.
    const dep = item.dependsOnItemId
      ? await prisma.seoBatchItem.findUnique({ where: { id: item.dependsOnItemId }, select: { jobId: true, keyword: true } })
      : null;
    const saved = dep?.jobId ? await fetchSavedOutline(item.userId, dep.jobId) : null;
    if (!saved) throw new Error(`text_item_outline_missing: the outline item completed but its result is gone (history wiped?) — not retryable`);
    knobs.outline = saved.outline;
    knobs.keyword = String(knobs.keyword || saved.keyword || "");
    knobs.language = String(knobs.language ?? (saved.outline as { meta?: { language?: string } })?.meta?.language ?? "en");
  }

  const jobType = item.phase === "outline" ? "outline" : "text";
  const { payload } = await resolveJobPayload(item.userId, jobType, knobs);
  return payload;
}

// ── queue mechanics ───────────────────────────────────────────────────────────

async function pumpGenQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    // Eligible candidates: active batches, due items, highest priority first.
    // Text items whose dependency has not completed are filtered below (the
    // dependency rows ride along in one query); the take is a window, not a
    // cap — the queue re-kicks itself after every settle.
    const candidates = await prisma.seoBatchItem.findMany({
      where: {
        status: "queued",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
        batch: { status: "active" },
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: 200,
      select: { id: true, batchId: true, userId: true, siteId: true, phase: true, keyword: true, payload: true, dependsOnItemId: true },
    }).catch(() => []);

    if (!candidates.length) return;
    const depIds = [...new Set(candidates.map(c => c.dependsOnItemId).filter((x): x is string => !!x))];
    const completedDeps = depIds.length
      ? new Set((await prisma.seoBatchItem.findMany({
          where: { id: { in: depIds }, status: "completed" },
          select: { id: true },
        }).catch(() => [])).map(r => r.id))
      : new Set<string>();
    // A dependency that died terminally skips its dependent — it can never
    // become eligible, so waiting forever would be a lie.
    const deadDeps = depIds.length
      ? new Set((await prisma.seoBatchItem.findMany({
          where: { id: { in: depIds }, status: { in: ["error", "skipped"] } },
          select: { id: true },
        }).catch(() => [])).map(r => r.id))
      : new Set<string>();

    for (const row of candidates) {
      const userId = row.userId;
      const settings = await getGenQueueSettings(userId);
      if (settings.paused) continue;
      const inFlight = inFlightByUser.get(userId) ?? new Set<string>();
      if (inFlight.size >= settings.concurrency) continue;

      if (row.dependsOnItemId && !completedDeps.has(row.dependsOnItemId)) {
        // Dependency errored/skipped → the text item is skipped with the reason.
        if (deadDeps.has(row.dependsOnItemId)) {
          await prisma.seoBatchItem.updateMany({
            where: { id: row.id, status: "queued" },
            data: { status: "skipped", error: "outline_failed", finishedAt: new Date() },
          }).catch(() => {});
        }
        continue;
      }

      // Atomic claim: only one pump moves the row out of "queued".
      const claimed = await prisma.seoBatchItem.updateMany({
        where: { id: row.id, status: "queued" },
        data: { status: "running", startedAt: new Date(), heartbeatAt: new Date() },
      }).catch(() => ({ count: 0 }));
      if (!claimed.count) continue;

      inFlight.add(row.id);
      inFlightByUser.set(userId, inFlight);
      runItem(row.id).catch(err => console.error("[gen-queue] run failed:", err));
    }
  } finally {
    pumping = false;
  }
}

// Claim → SeoJob row → detached run → settle. Every failure path lands in
// settleGenItem, which owns the retry policy and the circuit breaker.
async function runItem(itemId: string): Promise<void> {
  let item: ItemRow | null = null;
  try {
    item = await prisma.seoBatchItem.findUnique({ where: { id: itemId } });
    if (!item || item.status !== "running") return;

    const payload = await buildItemPayload(item);

    const job = await prisma.seoJob.create({
      data: {
        userId: item.userId, type: item.phase === "outline" ? "outline" : "text",
        keyword: item.keyword, status: "processing", stage: "queued", progress: 0,
        heartbeatAt: new Date(), resumable: false,
        meta: JSON.stringify({ batchId: item.batchId, batchItemId: item.id }),
      },
    });
    await prisma.seoBatchItem.update({ where: { id: item.id }, data: { jobId: job.id, heartbeatAt: new Date() } });

    await runJob(item.userId, job, payload);
  } catch (e) {
    // buildItemPayload threw (outline missing, no AI key configured) or the
    // job row could not be created. Record the REAL reason on the item —
    // settle reads it back so the failure is not mislabeled "job_row_missing".
    console.error("[gen-queue] item start failed:", e);
    await prisma.seoBatchItem.update({
      where: { id: itemId },
      data: { error: String((e as Error)?.message ?? e).slice(0, 500) },
    }).catch(() => {});
  } finally {
    await settleGenItem(itemId).catch(err => console.error("[gen-queue] settle failed:", err));
  }
}

/**
 * Read the spawned job's terminal state into the item, apply the retry
 * policy, trip the batch's circuit breaker, and close the batch when nothing
 * is left. Called after every run and by the scheduler's orphan recovery.
 */
export async function settleGenItem(itemId: string): Promise<void> {
  const item = await prisma.seoBatchItem.findUnique({
    where: { id: itemId },
    select: { id: true, userId: true, batchId: true, status: true, jobId: true, attempt: true, error: true },
  }).catch(() => null);
  if (!item) return;
  const userId = item.userId;

  // Release the slot first: whatever the DB says, this process is done with
  // the item, and the slot must not wait on the bookkeeping below.
  const inFlight = inFlightByUser.get(userId);
  if (inFlight) { inFlight.delete(itemId); if (!inFlight.size) inFlightByUser.delete(userId); }

  if (item.status !== "running") return; // already settled by a concurrent pass
  const settings = await getGenQueueSettings(userId);

  let job: { status: string; error: string | null } | null = null;
  if (item.jobId) {
    job = await prisma.seoJob.findUnique({
      where: { id: item.jobId },
      select: { status: true, error: true },
    }).catch(() => null);
  }

  if (job?.status === "completed") {
    await prisma.seoBatchItem.update({
      where: { id: itemId },
      data: { status: "completed", error: null, finishedAt: new Date(), heartbeatAt: new Date() },
    }).catch(() => {});
    await bumpCircuitBreaker(item.batchId, false).catch(() => {});
  } else {
    const reason = job?.status === "error"
      ? String(job.error ?? "generation_failed")
      : job
        ? `job_stuck_${job.status}` // processing forever + dead heartbeat → the stale sweep already handles the job; the item must not hang
        : (item.error || "job_row_missing (server restarted mid-item?)"); // a start-failure reason stashed by runItem's catch
    if ((item.attempt ?? 1) < 1 + Math.max(0, settings.retryAttempts)) {
      await prisma.seoBatchItem.update({
        where: { id: itemId },
        data: {
          status: "queued", attempt: { increment: 1 }, error: reason,
          nextAttemptAt: new Date(Date.now() + settings.retryDelayMin * 60_000),
          heartbeatAt: new Date(),
        },
      }).catch(() => {});
    } else {
      await prisma.seoBatchItem.update({
        where: { id: itemId },
        data: { status: "error", error: reason, finishedAt: new Date() },
      }).catch(() => {});
      const tripped = await bumpCircuitBreaker(item.batchId, true).catch(() => false);
      if (tripped) await notifyBatchAutoPaused(item.batchId, reason).catch(() => {});
    }
  }

  await closeBatchIfDone(item.batchId).catch(() => {});
  kickGenQueue();
}

// consecutiveErrors: reset on any success, incremented on a terminal item
// error. When it reaches the batch's pauseAfterErrors the batch pauses itself
// — a dead provider must not quietly burn hours of paid retries. Returns
// true when the breaker tripped JUST NOW (the caller fires one alert).
async function bumpCircuitBreaker(batchId: string, failed: boolean): Promise<boolean> {
  const batch = await prisma.seoBatch.findUnique({
    where: { id: batchId }, select: { consecutiveErrors: true, pauseAfterErrors: true, status: true },
  }).catch(() => null);
  if (!batch) return false;
  if (failed) {
    const next = (batch.consecutiveErrors ?? 0) + 1;
    if (batch.pauseAfterErrors > 0 && next >= batch.pauseAfterErrors && batch.status === "active") {
      await prisma.seoBatch.update({
        where: { id: batchId },
        data: { consecutiveErrors: next, status: "paused", statusReason: "auto_paused_errors" },
      });
      return true;
    }
    await prisma.seoBatch.update({ where: { id: batchId }, data: { consecutiveErrors: next } });
    return false;
  }
  if (batch.consecutiveErrors !== 0) {
    await prisma.seoBatch.update({ where: { id: batchId }, data: { consecutiveErrors: 0 } });
  }
  return false;
}

// All items terminal → the batch is done. Paused/cancelled batches close the
// same way once their tail drains.
async function closeBatchIfDone(batchId: string): Promise<void> {
  const remaining = await prisma.seoBatchItem.count({
    where: { batchId, status: { in: ["queued", "running"] } },
  }).catch(() => 1);
  if (remaining > 0) return;
  await prisma.seoBatch.updateMany({
    where: { id: batchId, status: { in: ["active", "paused"] } },
    data: { status: "done", finishedAt: new Date() },
  }).catch(() => {});
}

// ── orphan recovery ──────────────────────────────────────────────────────────

/**
 * Items stuck in "running" whose job is already terminal (the process died
 * between the job's finish and the item's settle — or the settle itself
 * crashed). The scheduler calls this every tick AFTER failStaleSeoJobs, so a
 * stale job arrives here already flipped to error and settles as a retryable
 * failure, reported as a restart rather than a provider fault.
 */
export async function recoverGenItems(): Promise<number> {
  const stuck = await prisma.seoBatchItem.findMany({
    where: { status: "running" },
    take: 100,
    select: { id: true, jobId: true },
  }).catch(() => []);
  let recovered = 0;
  for (const row of stuck) {
    // Not ours to touch while this process still tracks it — its own settle
    // is coming. (After a restart inFlightByUser is empty, so orphans pass.)
    let tracked = false;
    for (const set of inFlightByUser.values()) if (set.has(row.id)) tracked = true;
    if (tracked) continue;
    if (!row.jobId) {
      // Claimed but the SeoJob row never appeared — the process died in the
      // window between. Nothing was paid for; requeue immediately.
      await prisma.seoBatchItem.updateMany({
        where: { id: row.id, status: "running" },
        data: { status: "queued", jobId: null, error: "server_restart_before_start", heartbeatAt: new Date() },
      }).catch(() => ({ count: 0 }));
      recovered++;
      continue;
    }
    const job = await prisma.seoJob.findUnique({ where: { id: row.jobId }, select: { status: true } }).catch(() => null);
    if (!job || job.status !== "processing") {
      await settleGenItem(row.id);
      recovered++;
    }
  }
  if (recovered) kickGenQueue();
  return recovered;
}

// ── actions ──────────────────────────────────────────────────────────────────

export async function pauseBatch(userId: string, batchId: string): Promise<void> {
  await prisma.seoBatch.updateMany({ where: { id: batchId, userId, status: "active" }, data: { status: "paused", statusReason: "paused_by_operator" } });
}

export async function resumeBatch(userId: string, batchId: string): Promise<void> {
  // Resuming clears the breaker: the operator looked at it, so the error
  // streak that tripped it is consumed.
  await prisma.seoBatch.updateMany({
    where: { id: batchId, userId, status: "paused" },
    data: { status: "active", statusReason: "", consecutiveErrors: 0 },
  });
  kickGenQueue();
}

// Cancel skips queued items (an order not yet started is not an event); runs
// already holding a slot finish — killing a mid-generation job wastes what
// was already paid for and saves nothing.
export async function cancelBatch(userId: string, batchId: string): Promise<number> {
  const r = await prisma.seoBatchItem.updateMany({
    where: { batchId, userId, status: "queued" },
    data: { status: "skipped", error: "cancelled", finishedAt: new Date() },
  }).catch(() => ({ count: 0 }));
  await prisma.seoBatch.updateMany({
    where: { id: batchId, userId, status: { in: ["active", "paused"] } },
    data: { status: "cancelled", finishedAt: new Date() },
  });
  await closeBatchIfDone(batchId);
  return r?.count ?? 0;
}

// Manual retry: terminal errors (and skips) of this batch requeue with a
// fresh attempt budget — the operator's click IS the new budget.
export async function retryBatchFailures(userId: string, batchId: string): Promise<number> {
  const r = await prisma.seoBatchItem.updateMany({
    where: { batchId, userId, status: { in: ["error", "skipped"] } },
    data: { status: "queued", attempt: 1, nextAttemptAt: null, error: null, finishedAt: null, jobId: null },
  }).catch(() => ({ count: 0 }));
  if (r?.count) {
    await prisma.seoBatch.updateMany({
      where: { id: batchId, userId },
      data: { status: "active", statusReason: "", consecutiveErrors: 0, finishedAt: null },
    });
    kickGenQueue();
  }
  return r?.count ?? 0;
}

// Delete removes the batch and its items; generated texts stay in SeoHistory
// (that store is the source of truth, not the queue). Queued items die with
// the batch; running ones finish into nothing — their settle no-ops on the
// missing row.
export async function deleteBatch(userId: string, batchId: string): Promise<void> {
  await prisma.seoBatchItem.updateMany({
    where: { batchId, userId, status: "queued" },
    data: { status: "skipped", error: "deleted" },
  }).catch(() => {});
  await prisma.seoBatch.deleteMany({ where: { id: batchId, userId } }).catch(() => {});
}

// ── status ───────────────────────────────────────────────────────────────────

export interface BatchStatus {
  id: string;
  name: string;
  pipeline: string;
  status: string;
  statusReason: string;
  pauseAfterErrors: number;
  consecutiveErrors: number;
  createdAt: Date;
  finishedAt: Date | null;
  counts: Record<string, number>;
  total: number;
  /** Rough remaining time at the workspace's concurrency, from the batch's
   *  own completed items. Null until one item finishes. */
  etaMinutes: number | null;
}

async function batchStatus(batch: {
  id: string; name: string; pipeline: string; status: string; statusReason: string;
  pauseAfterErrors: number; consecutiveErrors: number; createdAt: Date; finishedAt: Date | null;
}, concurrency: number): Promise<BatchStatus> {
  const grouped = await prisma.seoBatchItem.groupBy({
    by: ["status"], where: { batchId: batch.id }, _count: { _all: true },
  }).catch(() => []);
  const counts: Record<string, number> = {};
  let total = 0;
  for (const g of grouped) { counts[g.status] = g._count._all; total += g._count._all; }

  let etaMinutes: number | null = null;
  const done = await prisma.seoBatchItem.findMany({
    where: { batchId: batch.id, status: "completed", startedAt: { not: null }, finishedAt: { not: null } },
    select: { startedAt: true, finishedAt: true }, take: 50, orderBy: { finishedAt: "desc" },
  }).catch(() => []);
  if (done.length) {
    const avgMin = done.reduce((acc, r) =>
      acc + ((r.finishedAt!.getTime() - r.startedAt!.getTime()) / 60_000), 0) / done.length;
    const remaining = (counts.queued ?? 0) + (counts.running ?? 0);
    etaMinutes = Math.round((remaining * Math.max(0.1, avgMin)) / Math.max(1, concurrency));
  }
  return { ...batch, counts, total, etaMinutes };
}

export async function listGenBatches(userId: string, limit = 50): Promise<BatchStatus[]> {
  const rows = await prisma.seoBatch.findMany({
    where: { userId }, orderBy: { createdAt: "desc" }, take: limit,
  }).catch(() => []);
  const settings = await getGenQueueSettings(userId);
  const out: BatchStatus[] = [];
  for (const row of rows) out.push(await batchStatus(row, settings.concurrency));
  return out;
}

export async function getGenBatch(
  userId: string, batchId: string,
  opts: { status?: string; limit?: number; offset?: number } = {},
): Promise<{ batch: BatchStatus; items: unknown[]; nextOffset: number | null } | null> {
  const row = await prisma.seoBatch.findFirst({ where: { id: batchId, userId } }).catch(() => null);
  if (!row) return null;
  const settings = await getGenQueueSettings(userId);
  const limit = Math.max(1, Math.min(500, Number(opts.limit ?? 100)));
  const offset = Math.max(0, Number(opts.offset ?? 0));
  const items = await prisma.seoBatchItem.findMany({
    where: { batchId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: limit + 1, skip: offset,
    select: { id: true, phase: true, keyword: true, siteId: true, status: true, error: true, attempt: true, jobId: true, priority: true, startedAt: true, finishedAt: true, nextAttemptAt: true },
  }).catch(() => []);
  const nextOffset = items.length > limit ? offset + limit : null;
  return { batch: await batchStatus(row, settings.concurrency), items: items.slice(0, limit), nextOffset };
}

// ── auto-pause alert ─────────────────────────────────────────────────────────

// The stop-crank alert. pauseAfterErrors > 0 IS the opt-in (the operator
// configured the breaker), so unlike per-rule alert settings there is no
// second switch to check. Never throws: a dead channel must not fail the
// settle path that called it.
async function notifyBatchAutoPaused(batchId: string, lastError: string): Promise<void> {
  try {
    const batch = await prisma.seoBatch.findUnique({ where: { id: batchId }, select: { userId: true, name: true, pauseAfterErrors: true } });
    if (!batch) return;
    const { notifyUser } = await import("@/lib/notify");
    const text = `⚠️ Generation batch paused\n\n"${batch.name}" hit ${batch.pauseAfterErrors} consecutive errors and paused itself.\nLast error: ${String(lastError).slice(0, 300)}\n\nCheck SEO Tools → Batch (provider down? key exhausted?). Resume when fixed; retry-failed requeues the errors.`;
    try {
      await prisma.alertEvent.create({
        data: {
          userId: batch.userId, type: "gen_batch_paused",
          title: "⚠️ Generation batch paused",
          message: text, dedupeKey: `gen_batch_paused:${batchId}:${new Date().toISOString().slice(0, 10)}`,
        },
      });
    } catch { /* duplicate or table missing — delivery below still runs */ }
    await notifyUser(batch.userId, text);
  } catch (e) {
    console.warn("[gen-queue] auto-pause alert failed:", e);
  }
}
