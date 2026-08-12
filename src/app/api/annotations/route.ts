import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { getAlgoUpdates } from "@/lib/algoUpdatesServer";
import { rawQuery, rawExec, dayExpr } from "@/lib/db/raw";

// Annotations — dated notes about site changes, scored against real Search Console data.
//
// The tab that used to render these was a shell: notes lived in React state (gone on refresh) and
// every before/after figure was a literal 0. Everything here computes from DailyMetric instead.
//
// Nothing is precomputed or cached into the row. A note written today has no "after" data yet —
// Search Console lags two to three days — and it fills in on its own as sync catches up. Storing a
// snapshot would freeze that emptiness in place and would also go stale whenever history is
// re-synced.
//
// Raw SQL throughout, following the convention this codebase already uses for tables added after
// the initial schema (see docs/ARCHITECTURE.md §2): an instance that has not run `prisma db push`
// yet returns an empty list instead of crashing the site page.

type DayRow = { day: string; clicks: number; impressions: number; posw: number };

// Day bucketing differs per database — strftime does not exist in MySQL — so the expression comes
// from db/raw.ts rather than being spelled here. See {@link dayExpr} for why SQLite needs the
// long version.
const DAY_EXPR = dayExpr("date");

const iso = (d: Date) => d.toISOString().split("T")[0];
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/** Per-day totals for a window. Position is impression-weighted — a plain average would let a
 *  one-impression query at rank 90 count as much as a 10 000-impression query at rank 3.
 *
 *  CRITICAL — which rows to sum depends on scope, and getting it wrong double-counts. DailyMetric
 *  holds THREE shapes of rows per day: a site-level aggregate (url='', query=''), per-page rows
 *  (real url, query='') and per-query rows (real url, real query). Summing all of them — which a
 *  bare `WHERE siteId` does — counts the same clicks two or three times. Every other GSC reader in
 *  this codebase filters this (gsc/decay: "Exclude the site-level aggregate row", gsc/ctr,
 *  gsc/cannibalization, gsc/striking all drop url=''). Annotations must do the same:
 *    • all-pages note (urls=[]) → use ONLY the aggregate row (url='' AND query=''), so the day total
 *      matches what Search Console shows for the whole site, with no per-page duplication.
 *    • page-scoped note (urls=[...]) → use ONLY the per-page rows for those urls (query='' rows),
 *      which the IN(...) filter already selects; the extra AND query='' guards against any
 *      per-query detail rows those pages may also carry being summed on top. */
async function dailySeries(siteId: string, from: Date, to: Date, urls: string[]): Promise<DayRow[]> {
  const params: unknown[] = [siteId, from, to];
  let urlFilter = "";
  if (urls.length) {
    urlFilter = ` AND "url" IN (${urls.map(() => "?").join(",")}) AND "query" = ''`;
    params.push(...urls);
  } else {
    urlFilter = ` AND "url" = '' AND "query" = ''`;
  }
  const rows = await rawQuery<{ day: string; clicks: bigint | number; impressions: bigint | number; posw: number | null }[]>(
    `SELECT ${DAY_EXPR} AS day,
            SUM("clicks") AS clicks,
            SUM("impressions") AS impressions,
            SUM("position" * "impressions") AS posw
     FROM "DailyMetric"
     WHERE "siteId" = ? AND "date" >= ? AND "date" < ?${urlFilter}
     GROUP BY day
     ORDER BY day ASC`,
    ...params,
  );
  return rows.map(r => ({
    day: r.day,
    clicks: Number(r.clicks ?? 0),
    impressions: Number(r.impressions ?? 0),
    posw: Number(r.posw ?? 0),
  }));
}

function totals(rows: DayRow[]) {
  const clicks = rows.reduce((a, r) => a + r.clicks, 0);
  const impressions = rows.reduce((a, r) => a + r.impressions, 0);
  const posw = rows.reduce((a, r) => a + r.posw, 0);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    position: impressions > 0 ? posw / impressions : 0,
  };
}

// Percentage change guarded against a zero baseline: going 0 → 40 is not "infinity percent", and
// rendering it as such would make the whole column untrustworthy. Null means "no baseline".
const pct = (before: number, after: number): number | null =>
  before > 0 ? Math.round(((after - before) / before) * 100) : null;

/** Fill missing days with zeros so a sparkline shows a real gap instead of silently compressing. */
function densify(rows: DayRow[], from: Date, days: number): number[] {
  const byDay = new Map(rows.map(r => [r.day, r.clicks]));
  return Array.from({ length: days }, (_, i) => byDay.get(iso(addDays(from, i))) ?? 0);
}

export interface SeriesPoint {
  date: string; clicks: number; impressions: number; ctr: number; position: number | null;
  phase: "before" | "after";
}

/**
 * Day-by-day values for all four metrics across the whole window.
 *
 * The chart used to receive clicks alone, which is why toggling impressions or position changed the
 * numbers on the right but never the curve. Position is null on days with no impressions rather
 * than 0 — rank zero does not exist, and plotting it as zero draws a cliff that never happened.
 */
function toSeries(rows: DayRow[], from: Date, days: number, phase: "before" | "after"): SeriesPoint[] {
  const byDay = new Map(rows.map(r => [r.day, r]));
  return Array.from({ length: days }, (_, i) => {
    const date = iso(addDays(from, i));
    const r = byDay.get(date);
    const impressions = r?.impressions ?? 0;
    return {
      date,
      clicks: r?.clicks ?? 0,
      impressions,
      ctr: impressions > 0 ? +(((r?.clicks ?? 0) / impressions) * 100).toFixed(2) : 0,
      position: impressions > 0 ? +((r!.posw / impressions).toFixed(1)) : null,
      phase,
    };
  });
}

/**
 * Forward-fill position across days with no impressions, so the position chart draws a continuous
 * line like the other three metrics instead of breaking wherever rank was undefined.
 *
 * The other metrics use 0 for a missing day (0 clicks is a real value, and the line sits on the
 * axis). Position cannot use 0 — rank 0 does not exist and would render at the TOP of an inverted
 * axis as if the page were ranking #1. Holding the LAST KNOWN position forward is the honest
 * equivalent: "we don't have a new rank today, so the line continues at the rank we last saw",
 * which is what a person reading the chart assumes a gap means anyway.
 *
 * Applied to the merged before+after array (not per-phase) so a gap right at the change date is
 * bridged too. Leading nulls (no impressions yet at the start of the window) stay null: there is
 * no previous rank to hold, and connectNulls will still join once the first real point appears.
 */
function fillPositionGaps(series: SeriesPoint[]): SeriesPoint[] {
  let last: number | null = null;
  return series.map(p => {
    if (p.position != null) {
      last = p.position;
      return p;
    }
    // Only fill when we have something to hold forward; a leading gap stays null.
    if (last != null) return { ...p, position: last };
    return p;
  });
}

async function ownedSite(userId: string, siteId: string) {
  return prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
}

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") || "";
  const days = Math.max(1, Math.min(180, parseInt(searchParams.get("days") || "28", 10) || 28));
  // How far back the list reaches, as opposed to `days`, which is how far the before/after
  // comparison reaches on either side of each row. Two different questions that used to share one
  // number, which is why picking a longer period changed the figures but never the list.
  const lookback = Math.max(7, Math.min(1200, parseInt(searchParams.get("lookback") || "400", 10) || 400));
  if (!siteId) return NextResponse.json({ error: "no_site" }, { status: 400 });
  if (!(await ownedSite(userId, siteId))) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    // Notes and Google updates come back as one list rather than two views.
    //
    // They were separate because they have separate origins, but that is the app's problem, not
    // the reader's: the question is "what moved this site", and answering it meant flipping
    // between two screens and holding one of them in your head. Both are dated events scored the
    // same way against the same traffic, so they belong on one timeline — `kind` is all the
    // distinction the UI needs.
    const noteRows = await rawQuery<{
      id: string; date: Date | string | number; title: string; description: string | null;
      scope: string; urls: string | null;
    }[]>(
      // `date` is compared through the same normalizer the day bucketing uses, because the column
      // holds either milliseconds or an ISO string depending on how the row was written.
      `SELECT "id", "date", "title", "description", "scope", "urls"
       FROM "Annotation" WHERE "siteId" = ? AND ${DAY_EXPR} >= ?
       ORDER BY "date" DESC LIMIT 200`,
      siteId, iso(addDays(new Date(), -lookback)),
    );

    const { updates } = await getAlgoUpdates();
    // Only updates the site could have lived through, and only as far back as the selected period.
    // Yesterday's update would report a confident nothing, so the newest day is excluded too.
    const oldest = iso(addDays(new Date(), -lookback));
    const updateRows = updates
      .filter(u => u.date >= oldest && u.date <= iso(addDays(new Date(), -1)))
      .map(u => ({
        id: `google:${u.date}:${u.type}`,
        date: new Date(`${u.date}T00:00:00Z`),
        title: u.name,
        description: u.duration ? `Rollout: ${u.duration}` : null,
        scope: "all",
        urls: null as string | null,
        kind: "update" as const,
        updateType: u.type,
        endDate: u.end ?? null,
      }));

    const rows = [
      ...noteRows.map(r => ({ ...r, kind: "note" as const, updateType: null, endDate: null })),
      ...updateRows,
    ].sort((a, b) => +new Date(b.date as any) - +new Date(a.date as any));

    // One shared query covers every all-pages note; only page-scoped notes need their own.
    const dates = rows.map(r => new Date(r.date as any));
    const spanFrom = dates.length ? addDays(new Date(Math.min(...dates.map(d => +d))), -days) : new Date();
    const spanTo = dates.length ? addDays(new Date(Math.max(...dates.map(d => +d))), days) : new Date();
    const shared = dates.length ? await dailySeries(siteId, spanFrom, spanTo, []) : [];

    const notes = await Promise.all(rows.map(async r => {
      const d = new Date(r.date as any);
      d.setHours(0, 0, 0, 0);
      const beforeFrom = addDays(d, -days);
      const afterTo = addDays(d, days);
      const urls = (r.urls || "").split(/[\n,]/).map(s => s.trim()).filter(Boolean);

      const series = urls.length
        ? await dailySeries(siteId, beforeFrom, afterTo, urls)
        : shared.filter(x => x.day >= iso(beforeFrom) && x.day < iso(afterTo));

      const before = series.filter(x => x.day < iso(d));
      const after = series.filter(x => x.day >= iso(d));
      const b = totals(before), a = totals(after);

      return {
        id: r.id,
        kind: r.kind,
        // Only set on updates: the chart colours a rollout band by type and shades from start to
        // end, and a note has neither.
        updateType: r.updateType,
        endDate: r.endDate,
        date: iso(d),
        title: r.title,
        description: r.description || "",
        scope: r.scope,
        urls,
        dateRange: `${iso(beforeFrom)} → ${iso(addDays(afterTo, -1))}`,
        // `hasAfter` lets the UI say "waiting for data" instead of showing a confident 0 — the
        // normal state for a note written today.
        hasAfter: after.some(x => x.impressions > 0),
        clicks: { before: b.clicks, after: a.clicks, pct: pct(b.clicks, a.clicks) },
        impressions: { before: b.impressions, after: a.impressions, pct: pct(b.impressions, a.impressions) },
        ctr: { before: +b.ctr.toFixed(2), after: +a.ctr.toFixed(2), pct: pct(b.ctr, a.ctr) },
        // Position improves as it falls, so the delta is reported as before − after: positive = better.
        position: { before: +b.position.toFixed(1), after: +a.position.toFixed(1), delta: +(b.position - a.position).toFixed(1) },
        sparkBefore: densify(before, beforeFrom, days),
        sparkAfter: densify(after, d, days),
        // Full per-day values for the chart, with the change date marking the boundary. Position
        // gaps are forward-filled so its line is continuous like the other three metrics.
        series: fillPositionGaps([...toSeries(before, beforeFrom, days, "before"), ...toSeries(after, d, days, "after")]),
      };
    }));

    return NextResponse.json({ notes, days });
  } catch (e) {
    // Table not created yet (no `prisma db push`) — an empty list, not a 500.
    console.error("[Annotations] read failed", e);
    return NextResponse.json({ notes: [], days, unavailable: true });
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId || "");
  const title = String(b.title || "").trim();
  const date = b.date ? new Date(b.date) : new Date();
  if (!siteId || !title) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (isNaN(+date)) return NextResponse.json({ error: "bad_date" }, { status: 400 });
  if (!(await ownedSite(userId, siteId))) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const urls = Array.isArray(b.urls) ? b.urls.map(String).filter(Boolean).join("\n") : String(b.urls || "");
  const scope = urls.trim() ? "pages" : "all";

  try {
    const id = `ann_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    date.setHours(0, 0, 0, 0);
    await rawExec(
      `INSERT INTO "Annotation" ("id","siteId","date","title","description","scope","urls","createdAt")
       VALUES (?,?,?,?,?,?,?,?)`,
      id, siteId, date, title, String(b.description || ""), scope, urls || null, new Date(),
    );
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    console.error("[Annotations] create failed", e);
    return NextResponse.json({ error: "table_missing" }, { status: 503 });
  }
}

export async function DELETE(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "no_id" }, { status: 400 });

  try {
    // The join to Site is the ownership check — a note can only be deleted through a site the
    // caller owns, so an id guessed from elsewhere does nothing.
    await rawExec(
      `DELETE FROM "Annotation" WHERE "id" = ?
       AND "siteId" IN (SELECT "id" FROM "Site" WHERE "userId" = ?)`,
      id, userId,
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[Annotations] delete failed", e);
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const id = String(b.id || "");
  const title = String(b.title || "").trim();
  if (!id || !title) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const date = b.date ? new Date(b.date) : null;
  if (date && isNaN(+date)) return NextResponse.json({ error: "bad_date" }, { status: 400 });

  try {
    // Same ownership guard as DELETE: the row can only be touched through a site the caller owns.
    date?.setHours(0, 0, 0, 0);
    await rawExec(
      `UPDATE "Annotation" SET "title" = ?, "description" = ?, "date" = ?
       WHERE "id" = ? AND "siteId" IN (SELECT "id" FROM "Site" WHERE "userId" = ?)`,
      title, String(b.description || ""), date ?? null, id, userId,
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[Annotations] update failed", e);
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
}
