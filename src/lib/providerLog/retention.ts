// Forgetting, on purpose and in two stages.
//
// A log that only grows is a log that eventually has to be dealt with by hand, usually at the
// worst moment. So it forgets — but not all at once, because the two things it holds are worth
// keeping for very different lengths of time.
//
// **Bodies** are prompts and completions in full: the expensive half to store and the only half
// that can contain anything private. They are captured deliberately, to chase one problem, and
// they stop being useful about as soon as that problem is understood. Seven days.
//
// **Rows** are the record that a call happened — when, for whom, to which provider, at what cost.
// That is the ledger people reconcile invoices against and the series any usage chart is drawn
// from, so it long outlives the payload. Ninety days.
//
// Bodies are cleared before rows are deleted, and that order is load-bearing rather than
// incidental: it means the first thing lost is the payload, while the fact of the call survives.
// Delete the rows first and a crash halfway leaves the opposite — bodies on disk for calls whose
// rows are gone.
//
// Everything happens in bounded batches with a ceiling per tick. A single `deleteMany` over
// ninety days of rows is one statement holding a write lock for as long as it takes to finish,
// and what it holds it against is the per-call insert this feature just added to every provider
// call in the app: on SQLite that is every AI request in the process queueing behind the
// housekeeping. Ten thousand rows a tick, hourly, retires far more than any instance produces,
// and a backlog drains over a few hours instead of stalling one of them.

import { prisma } from "@/lib/prisma";

/** Days a captured request/response body is kept. */
export const BODY_RETENTION_DAYS = 7;
/** Days the row itself is kept. */
export const ROW_RETENTION_DAYS = 90;

/** Ids touched by a single statement. Small enough that no one write blocks a provider call. */
export const SWEEP_BATCH_SIZE = 500;
/** Batches per phase per tick. The ceiling is what keeps a first sweep from becoming an outage. */
export const SWEEP_MAX_BATCHES = 20;

export interface RetentionCutoffs {
  /** Rows older than this lose their bodies. */
  bodiesBefore: Date;
  /** Rows older than this are deleted. */
  rowsBefore: Date;
}

/**
 * How many days back each phase reaches.
 *
 * A window that is zero, negative or not a number falls back to the default rather than being
 * taken literally. Taken literally, zero means "everything up to this instant" and a negative
 * number reaches into the future — so the one input a misconfigured caller is most likely to
 * produce is also the one that would empty the table. Silently keeping data too long is a
 * recoverable mistake; deleting it is not.
 */
function days(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function retentionCutoffs(
  now: Date,
  opts?: { bodyDays?: number; rowDays?: number },
): RetentionCutoffs {
  const t = now.getTime();
  const DAY = 86_400_000;
  return {
    bodiesBefore: new Date(t - days(opts?.bodyDays, BODY_RETENTION_DAYS) * DAY),
    rowsBefore: new Date(t - days(opts?.rowDays, ROW_RETENTION_DAYS) * DAY),
  };
}

// The table is reached through a loose handle for the same reason log.ts does it: `ProviderCall`
// is absent from the generated client until `prisma generate` re-runs, and an instance that has
// not migrated should sweep nothing rather than crash its alert scheduler.
let tableOverride: unknown;

function table(): any {
  if (tableOverride !== undefined) return tableOverride;
  return (prisma as any).providerCall;
}

/** Test hook: run the sweep against a stub. Called with no argument to restore Prisma. */
export function __setTableForTests(t?: unknown): void {
  tableOverride = t;
}

/**
 * One bounded pass: select at most a batch of matching ids, act on exactly those, repeat.
 *
 * Ids rather than a `where` on the write, because Prisma has no `LIMIT` on `deleteMany`/
 * `updateMany` and an unbounded predicate is precisely what this is avoiding. The loop stops
 * early when a select comes back short — there is nothing left to match — and hard at the
 * ceiling, leaving the rest for the next tick.
 */
async function sweepIn(
  t: any,
  where: Record<string, unknown>,
  act: (ids: string[]) => Promise<{ count?: number } | undefined>,
): Promise<number> {
  let done = 0;
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
    const found: { id: string }[] = await t.findMany({ where, select: { id: true }, take: SWEEP_BATCH_SIZE });
    if (!found.length) break;
    const r = await act(found.map(x => x.id));
    done += r?.count ?? found.length;
    if (found.length < SWEEP_BATCH_SIZE) break;
  }
  return done;
}

/**
 * Clear old bodies, then delete older rows.
 *
 * Best-effort in the same sense as every other write in this module: it is called from a
 * scheduler tick that has real work to do, and housekeeping that can take that tick down would
 * be worse than housekeeping that skips an hour. A failure returns what it managed.
 */
export async function sweepProviderLog(now: Date = new Date()): Promise<{ bodiesCleared: number; rowsDeleted: number }> {
  const t = table();
  if (!t) return { bodiesCleared: 0, rowsDeleted: 0 };

  const { bodiesBefore, rowsBefore } = retentionCutoffs(now);
  let bodiesCleared = 0;
  let rowsDeleted = 0;

  try {
    // Bodies first. `OR` on the two body columns is what makes the pass terminate: a row whose
    // bodies are already null no longer matches, so the next select moves on instead of handing
    // back the batch just cleared.
    bodiesCleared = await sweepIn(
      t,
      { at: { lt: bodiesBefore }, OR: [{ requestBody: { not: null } }, { responseBody: { not: null } }] },
      ids => t.updateMany({ where: { id: { in: ids } }, data: { requestBody: null, responseBody: null } }),
    );
  } catch (err) {
    console.warn("[providerLog] body sweep failed:", err instanceof Error ? err.message : err);
  }

  try {
    rowsDeleted = await sweepIn(
      t,
      { at: { lt: rowsBefore } },
      ids => t.deleteMany({ where: { id: { in: ids } } }),
    );
  } catch (err) {
    console.warn("[providerLog] row sweep failed:", err instanceof Error ? err.message : err);
  }

  return { bodiesCleared, rowsDeleted };
}
