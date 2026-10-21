// Generation batch queue scheduler — the "cron" that drains the queue.
//
// Tick = 60s (plus the immediate kick every settle fires): each pass fails
// stale SeoJobs (so a job killed by a restart is already terminal when the
// orphan recovery reads it), recovers items stuck in "running", syncs the
// process-wide provider semaphore with the operators' settings, and pumps
// the queue. Idles as two indexed queries when nothing is queued — same
// convention as the other in-process loops registered in instrumentation.ts.
//
// Degrades silently before `prisma db push` (tables missing → the tick logs
// and retries).

import { failStaleSeoJobs } from "@/lib/jobs/lifecycle";
import { recoverGenItems, kickGenQueue } from "./queue";
import { syncLLMKeyConcurrency } from "./settings";

const TICK_MS = 60_000;
const FIRST_TICK_MS = 20_000;
let started = false;
let running = false;

export function startGenQueueScheduler(): void {
  if (started) return;
  started = true;
  console.log("[gen-queue] scheduler started");
  setTimeout(() => { void tick(); }, FIRST_TICK_MS);
  setInterval(() => { void tick(); }, TICK_MS);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // The stale sweep flips dead-heartbeat jobs to error FIRST, so the
    // recovery below settles the orphaned items against a terminal state and
    // the retry policy (not a hang) decides what happens next.
    await failStaleSeoJobs().catch(() => {});
    const recovered = await recoverGenItems().catch(() => 0);
    const limit = await syncLLMKeyConcurrency().catch(() => 0);
    if (recovered) console.log(`[gen-queue] recovered ${recovered} orphaned item(s)`);
    if (limit) kickGenQueue(0);
  } catch (e) {
    console.warn("[gen-queue] tick failed (tables migrated?):", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}
