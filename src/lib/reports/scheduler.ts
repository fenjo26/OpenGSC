// N8 — the hourly loop that sends scheduled client reports. Same in-process pattern as
// serpmon/scheduler.ts (instrumentation.ts starts it at boot): a `running` flag against
// overlap, a permanent self-disable when the instance has not pushed the ClientReport*
// tables, and one indexed query per idle tick (the nextSendAt index — an empty schedule
// costs a single index scan).
//
// Tick = 1 h. Due = schedule != off AND (nextSendAt null OR <= now) — a report created
// with a schedule but never computed gets its first send on the nearest tick, like a
// serpmon project with nextRunAt null. After a send (or a failure that must not retry
// within the hour, e.g. SMTP down) nextSendAt is advanced to the next period, so one
// broken SMTP never spins the renderer every hour.

import { prisma } from "@/lib/prisma";
import { resolveCaptureBodies } from "@/lib/providerLog/bodies";
import { withCallContext } from "@/lib/providerLog/context";
import { createAndSendRun, reportsSchemaMissing, reschedule } from "./store";

const TICK_MS = 60 * 60 * 1000;   // hourly (brief §5)
const FIRST_TICK_MS = 90_000;     // shortly after boot, like the other loops
const PER_TICK = 10;              // reports per tick; the rest stay due for the next hour

let started = false;
let running = false;
let disabled = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema
const db = prisma as any;

/** What the tick needs from a due report — db is untyped, this keeps the loop readable. */
interface DueReport {
  id: string;
  userId: string;
  schedule?: string;
  sendDay?: number;
  lastSentAt?: Date | null;
}

async function tick(): Promise<void> {
  if (running || disabled) return;
  running = true;
  try {
    const due: DueReport[] = await db.clientReport.findMany({
      where: {
        schedule: { not: "off" },
        OR: [{ nextSendAt: null }, { nextSendAt: { lte: new Date() } }],
      },
      orderBy: { nextSendAt: "asc" },
      take: PER_TICK,
    });
    for (const report of due) {
      // Around the whole send: a timer inherits no request, and the SMTP call in
      // createAndSendRun must land in the provider log under the report's owner.
      const captureBodies = await resolveCaptureBodies(String(report.userId));
      await withCallContext({ userId: String(report.userId), feature: "reports-cron", captureBodies }, async () => {
        try {
          const res = await createAndSendRun(String(report.userId), String(report.id), { send: true });
          if ("error" in res) console.warn(`[reports-cron] report ${report.id}: ${res.error}`);
        } catch (e) {
          console.warn(`[reports-cron] report ${report.id} failed:`, e);
        }
        // Sent or not — advance the schedule. An SMTP outage reschedules to the next
        // period rather than retrying hourly; the run row keeps the error for the UI.
        try {
          await reschedule(report);
        } catch (e) {
          console.warn(`[reports-cron] reschedule ${report.id} failed:`, e);
        }
      });
    }
  } catch (e) {
    if (reportsSchemaMissing(e)) {
      disabled = true;
      console.warn("[reports-cron] ClientReport tables missing — scheduler disabled until restart");
      return;
    }
    console.warn("[reports-cron] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startReportsScheduler(): void {
  if (started) return;
  started = true;
  console.log("[reports-cron] scheduler started");
  setTimeout(tick, FIRST_TICK_MS);
  setInterval(tick, TICK_MS);
}

/** Wake the loop now (after a manual send that just rescheduled something). Coalesced. */
export function kickReportsScheduler(): void {
  if (!started || running || disabled) return;
  setTimeout(() => { void tick(); }, 1_000).unref?.();
}
