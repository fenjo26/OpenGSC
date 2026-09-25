// T4 — the URL Inspection quota ledger (docs/tasks/wave-oct/T4-index-autocheck.md).
//
// Google grants 2 000 inspections/day and 600/min PER PROPERTY, and the day resets at midnight
// America/Los_Angeles. The manual button (/api/indexing/sitemap/check-google), MCP inspect_url
// and the auto queue all draw from that one pool, so they all increment the same
// InspectionQuota row keyed (property = Site.siteId, pacificDay). The auto queue caps itself
// with the user's dailyBudget share; the manual paths do not, but they fail fast on an
// exhausted day instead of hammering Google with guaranteed 429s.

import { prisma } from "@/lib/prisma";
import { INSPECTION_DAILY_LIMIT } from "./types";
import { pacificDay } from "./queue";

/**
 * The remaining-quota arithmetic, split from Prisma so it is testable without a database.
 *
 * `exhaustedToday` short-circuits to 0: once Google answered 429 for this property today, no
 * path should try again before the Pacific midnight reset — even if the two counters below
 * still look unspent (Google's accounting can lag ours).
 */
export function computeRemaining(
  used: number,
  auto: number,
  autoBudget: number,
  opts: { limit?: number; exhaustedToday?: boolean } = {},
): number {
  if (opts.exhaustedToday) return 0;
  const limit = opts.limit ?? INSPECTION_DAILY_LIMIT;
  return Math.max(0, Math.min(limit - used, autoBudget - auto));
}

/** Today's ledger state for a property. A row that doesn't exist yet is a fresh zero day. */
export async function quotaToday(property: string): Promise<{ day: string; used: number; auto: number; exhausted: boolean }> {
  const day = pacificDay(new Date());
  const row = await prisma.inspectionQuota.findUnique({ where: { property_day: { property, day } } });
  return {
    day,
    used: row?.used ?? 0,
    auto: row?.auto ?? 0,
    // exhaustedAt is a moment, not a day: only an exhaustedAt inside TODAY's Pacific day
    // stops us — yesterday's exhaustion must not leak into a reset quota.
    exhausted: row?.exhaustedAt != null && pacificDay(row.exhaustedAt) === day,
  };
}

/**
 * Add `n` inspections (and optional error count / exhaustion flag) to today's row. Upsert with
 * increment, so concurrent paths (scheduler tick + a manual click) both land.
 */
export async function recordInspections(property: string, n: number, opts: { auto: boolean; errors?: number; exhausted?: boolean }): Promise<void> {
  const day = pacificDay(new Date());
  await prisma.inspectionQuota.upsert({
    where: { property_day: { property, day } },
    create: {
      property, day,
      used: n,
      auto: opts.auto ? n : 0,
      errors: opts.errors ?? 0,
      exhaustedAt: opts.exhausted ? new Date() : null,
    },
    update: {
      used: { increment: n },
      auto: opts.auto ? { increment: n } : undefined,
      errors: opts.errors ? { increment: opts.errors } : undefined,
      exhaustedAt: opts.exhausted ? new Date() : undefined,
    },
  });
}

/** How many more inspections the auto queue may spend on this property today. */
export async function remainingToday(property: string, autoBudget: number): Promise<number> {
  const q = await quotaToday(property);
  return computeRemaining(q.used, q.auto, autoBudget, { exhaustedToday: q.exhausted });
}

/**
 * True when the T4 tables aren't in the database yet (an instance that pulled the code but
 * hasn't run `prisma db push`). Routes answer `{ notMigrated: true }`; the scheduler disables
 * itself. Same shape as schemaMissing() in drops/store.ts.
 */
export function indexingTablesMissing(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" ||
    /(?:InspectionQuota|IndexCoverageDaily).*(?:does not exist|no such table)|(?:does not exist|no such table).*(?:InspectionQuota|IndexCoverageDaily)/i.test(String(value?.message ?? ""))
  );
}
