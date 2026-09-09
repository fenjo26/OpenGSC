// The panel's own DR history: one row per (domain, month), appended as a side effect of every
// fresh DR measurement. DrCache answers "what is this domain's DR"; DrSnapshot answers "what
// has it been doing" — and a single overwritten number cannot, because DR 22→24→12→11→8 is a
// Google filter, not decayed links. That series is exactly what GoAnyAPI's dr-history sells at
// 2 credits per month per domain; here it accumulates for free off the same public endpoint the
// dashboard already queries. Reads never record: only a measurement does.

import { rawQuery } from "@/lib/db/raw";
import { runUpsert } from "@/lib/db/upsert";

export interface DrPoint {
  month: string; // YYYY-MM
  dr: number;
}

export interface DrFlag {
  flagged: boolean;
  /** last − first across the stored window; negative means the rating fell. */
  drop: number;
  first: number;
  last: number;
}

/** Current month as YYYY-MM. UTC on purpose: this is a storage key, not a display locale. */
export function monthKey(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Record a DR measurement per domain. The (domain, month) key makes repeats within a month
 * idempotent — last measurement wins — so callers need no rate reasoning of their own. `month`
 * defaults to the current one; passing an explicit month is the vendor-backfill path (paid
 * history becoming permanent local history), never the panel's own measurements, which are
 * always "now". Errors are swallowed: history is best-effort, exactly like the DrCache writes
 * it sits beside, and an instance that has not run `prisma db push` must keep working without it.
 */
export async function recordDrSnapshots(
  rows: Array<{ domain: string; dr: number; source?: string; month?: string }>,
): Promise<void> {
  const now = new Date().toISOString();
  for (const r of rows) {
    if (!r.domain || !Number.isFinite(r.dr)) continue;
    try {
      await runUpsert({
        table: "DrSnapshot",
        conflict: ["domain", "month"],
        values: { domain: r.domain, month: r.month ?? monthKey(), dr: r.dr, source: r.source ?? "ahrefs-free", checkedAt: now },
        update: { dr: "set", source: "set", checkedAt: "set" },
      });
    } catch { /* best-effort, same as the DrCache writes beside it */ }
  }
}

/**
 * The stored monthly series per domain, oldest first, capped to the most recent `months`.
 * Returns {} on a missing table — callers render "no history yet", not an error.
 */
export async function readDrHistory(domains: string[], months = 24): Promise<Record<string, DrPoint[]>> {
  const unique = [...new Set(domains.map(d => d.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean))];
  if (!unique.length) return {};
  try {
    const rows = await rawQuery(
      `SELECT domain, month, dr FROM "DrSnapshot" WHERE domain IN (${unique.map(() => "?").join(",")}) ORDER BY domain, month`,
      ...unique,
    ) as Array<{ domain: string; month: string; dr: number | string }>;
    const out: Record<string, DrPoint[]> = {};
    for (const r of rows) (out[r.domain] ??= []).push({ month: r.month, dr: Number(r.dr) });
    for (const d of Object.keys(out)) if (out[d].length > months) out[d] = out[d].slice(-months);
    return out;
  } catch {
    return {};
  }
}

/**
 * The veto signal over a stored series: last vs first, the same −5 rule drops_dr_history
 * applies to the paid GoAnyAPI series. Fewer than two points means no verdict yet — that is
 * null, not "clean", and callers must not render it as either.
 */
export function flagDrSeries(points: DrPoint[] | undefined): DrFlag | null {
  if (!points || points.length < 2) return null;
  const first = points[0].dr;
  const last = points[points.length - 1].dr;
  const drop = last - first;
  return { flagged: drop <= -5, drop, first, last };
}
