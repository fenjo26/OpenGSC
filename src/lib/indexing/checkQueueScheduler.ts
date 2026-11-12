// Index-check queue scheduler — the safety net under the run queue.
//
// Tick = 60s (plus the immediate kick every settle and create fires): each pass settles items
// orphaned by a restart (a provider call lives at most ~10s; 5 minutes of silence means nobody
// is coming back), closes runs left active with nothing to do, and pumps. Idles as one indexed
// query when nothing is queued — same convention as the other in-process loops registered in
// instrumentation.ts.
//
// Degrades silently before `prisma db push` (tables missing → the tick logs and retries).

import { recoverOrphanedItems } from "./checkQueue";

const TICK_MS = 60_000;
const FIRST_TICK_MS = 15_000;
let started = false;
let running = false;

export function startCheckQueueScheduler(): void {
  if (started) return;
  started = true;
  console.log("[check-queue] scheduler started");
  setTimeout(() => { void tick(); }, FIRST_TICK_MS);
  setInterval(() => { void tick(); }, TICK_MS);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await recoverOrphanedItems();
  } catch (e) {
    console.warn("[check-queue] tick failed (tables migrated?):", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}
