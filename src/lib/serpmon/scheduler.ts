// SERP Monitor — the in-process loop that moves runs forward and starts scheduled ones.
// Same shape as the drops scheduler: it runs inside the Next server process from instrumentation,
// keeps a `running` flag against overlap, and disables itself permanently when the instance has
// not pushed the Serp* tables yet (the app runs `prisma db push` at container start, so that is
// a pulled-but-not-restarted window, not a steady state).
//
// Tick = 60 s, budget = 50 s of work per tick. Steps, per CONTRACT §5:
//   1. runs `running` for over 12 h are aborted with error "stale";
//   2. advanceRun for every running run, within the shared budget (resumable — the rest of a
//      run simply continues on the next tick);
//   3. projects due on their interval (or with nextRunAt null) and no run in flight → startRun;
//   4. whatever budget is left goes to T4's host enrichment queue.
// All of a project's work happens inside withCallContext({ userId, feature: "serpmon-cron" }) so
// the A-Parser calls land in the provider log under the project owner. Logs carry no keys.
import { prisma } from "@/lib/prisma";
import { resolveCaptureBodies } from "@/lib/providerLog/bodies";
import { withCallContext } from "@/lib/providerLog/context";
import { advanceRun, startRun } from "./collector";
import { enrichPendingHosts } from "./enrich";
import { schemaMissing } from "./store";

const TICK_MS = 60_000;               // 1 minute
const TICK_BUDGET_MS = 50_000;        // work per tick; the loop never holds the flag longer on purpose
const FIRST_TICK_MS = 45_000;         // first pass shortly after boot, like the other loops
const STALE_RUN_MS = 12 * 60 * 60_000; // a run older than 12 h is a dead process's leftover

let started = false;
let running = false;
let kickQueued = false;
/** Set when the instance has not migrated the Serp* tables yet — the tick stops retrying. */
let disabled = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema
const db = prisma as any;

async function tick(): Promise<void> {
  if (running || disabled) return;
  running = true;
  const startedAt = Date.now();
  const budgetDeadline = startedAt + TICK_BUDGET_MS;
  try {
    // 1. Stale runs. A server that died mid-run must not block its project forever.
    await db.serpRun.updateMany({
      where: { status: "running", startedAt: { lt: new Date(startedAt - STALE_RUN_MS) } },
      data: { status: "aborted", error: "stale", finishedAt: new Date() },
    });

    // 2. Advance running runs, oldest first, until the tick's budget runs out.
    const active = await db.serpRun.findMany({
      where: { status: "running" },
      orderBy: { startedAt: "asc" },
      take: 20,
      select: { id: true, project: { select: { userId: true } } },
    }) as { id: string; project: { userId: string } }[];
    for (const r of active) {
      if (Date.now() >= budgetDeadline) break;
      try {
        const captureBodies = await resolveCaptureBodies(r.project.userId);
        await withCallContext({ userId: r.project.userId, feature: "serpmon-cron", captureBodies }, async () => {
          const res = await advanceRun(r.id, budgetDeadline);
          if (!res.done) console.log(`[serpmon-cron] run ${r.id}: ${res.processed} keyword(s) this tick, continues next tick`);
        });
      } catch (e) {
        console.warn(`[serpmon-cron] run ${r.id} failed:`, e);
      }
    }

    // 3. Projects due on their interval. nextRunAt == null counts as due: a project created with
    // an interval but never yet run has its first check on the nearest tick.
    const due = await db.serpProject.findMany({
      where: {
        paused: false,
        intervalHours: { gt: 0 },
        runs: { none: { status: "running" } },
        OR: [{ nextRunAt: null }, { nextRunAt: { lte: new Date() } }],
      },
      orderBy: { nextRunAt: "asc" },
      take: 50,
      select: { id: true, userId: true },
    }) as { id: string; userId: string }[];
    for (const p of due) {
      if (Date.now() >= budgetDeadline) break; // leftovers stay due for the next tick
      try {
        const captureBodies = await resolveCaptureBodies(p.userId);
        const res = await withCallContext({ userId: p.userId, feature: "serpmon-cron", captureBodies }, () =>
          startRun(p.userId, p.id, "schedule"));
        // no_keywords is the quiet normal case (an empty project sits in the due list forever);
        // anything else is configuration the owner has to fix, so it is worth a line.
        if ("error" in res && res.error !== "no_keywords") {
          console.log(`[serpmon-cron] scheduled start for project ${p.id}: ${res.error}`);
        }
      } catch (e) {
        console.warn(`[serpmon-cron] scheduled start for project ${p.id} failed:`, e);
      }
    }

    // 4. Leftover budget: registration age / DR enrichment for hosts the user asked about.
    if (budgetDeadline - Date.now() > 5_000) {
      try {
        await enrichPendingHosts({ limit: 40, deadline: budgetDeadline });
      } catch {
        // Enrichment is opportunistic — T4 not merged yet, or a flaky registry. Never a tick failure.
      }
    }
  } catch (e) {
    if (schemaMissing(e)) {
      // Pulled-but-not-restarted instance (the app pushes the schema at container start).
      disabled = true;
      console.warn("[serpmon-cron] serpmon tables missing — scheduler disabled until restart");
      return;
    }
    console.warn("[serpmon-cron] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startSerpmonScheduler(): void {
  if (started) return;
  started = true;
  console.log("[serpmon-cron] scheduler started");
  setTimeout(tick, FIRST_TICK_MS);
  setInterval(tick, TICK_MS);
}

/**
 * Wake the loop now (after a manual start) instead of waiting for the next tick. Coalesced: a
 * burst of manual starts queues exactly one immediate tick, and a tick already in flight makes
 * this a no-op — the loop is awake.
 */
export function kickSerpmonScheduler(): void {
  if (!started || running || disabled || kickQueued) return;
  kickQueued = true;
  setTimeout(() => {
    kickQueued = false;
    void tick();
  }, 0);
}
