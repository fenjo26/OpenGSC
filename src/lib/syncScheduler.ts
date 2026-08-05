// Automatic GSC sync — the clock half. Settings and the "is it due" rule live in syncSchedule.ts.
//
// Same in-process pattern as the digest and rank schedulers: a tick started from
// instrumentation.ts, no system cron to install. It ticks every fifteen minutes rather than
// hourly because the hour is evaluated in the user's own zone, and not every zone is a whole
// number of hours away from UTC.
//
// One wrinkle worth stating plainly: runGscSync() is instance-wide. It walks every connected
// Google account of every user, so this cannot be a per-user schedule even though the setting is
// stored per user. If two people both switch it on, the earlier of the two hours wins and the
// second one finds the run already done for the day. On a single-operator instance — which is
// what OpenGSC is — that distinction never comes up.

import { runGscSync, isSyncInProgress } from "@/lib/gscSync";
import { getSyncSchedule, saveSyncSchedule, isDue } from "@/lib/syncSchedule";
import { rawQuery } from "@/lib/db/raw";

const TICK_MS = 15 * 60 * 1000;

async function tick() {
  let users: { id: string }[] = [];
  try {
    users = await rawQuery(`SELECT id FROM "User" WHERE syncSettings IS NOT NULL`);
  } catch {
    return; // column not there yet — the instance simply has no schedules
  }
  if (!users.length) return;

  const now = new Date();
  const due: string[] = [];
  for (const u of users) {
    const s = await getSyncSchedule(u.id);
    if (isDue(s, now)) due.push(u.id);
  }
  if (!due.length) return;

  if (isSyncInProgress()) {
    console.log("[sync-cron] due, but a sync is already running — leaving it alone");
    return;
  }

  console.log(`[sync-cron] starting scheduled sync (due for ${due.length} user(s))`);
  await runGscSync();

  // Written after the run, not before: a run that crashed halfway should be retried on the next
  // tick rather than counted as this day's sync.
  const stamp = new Date().toISOString();
  for (const userId of due) {
    const s = await getSyncSchedule(userId);
    await saveSyncSchedule(userId, { ...s, lastRunAt: stamp }).catch(() => {});
  }
}

let started = false;
let running = false;

export function startSyncScheduler() {
  if (started) return;
  started = true;
  console.log("[sync-cron] scheduler started");
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick(); } catch (e) { console.warn("[sync-cron] tick failed:", e); }
    finally { running = false; }
  };
  // Not immediately at boot: a restart during the scheduled hour would otherwise kick off a full
  // sync while the process is still warming up, and a deploy loop would do it repeatedly.
  setTimeout(run, 3 * 60_000);
  setInterval(run, TICK_MS);
}
