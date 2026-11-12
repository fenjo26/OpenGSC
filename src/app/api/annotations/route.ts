import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { getAlgoUpdates } from "@/lib/algoUpdatesServer";
import { rawQuery, rawExec, dayExpr } from "@/lib/db/raw";
import { purchaseOrderEvents, providerName } from "@/lib/magiclinks/purchases";
import {
  normalizeEventType, isPrefixMove, normalizePrefix, likePrefix, checkPrefixInProperty,
  type EventType,
} from "@/lib/annotations/events";
import { movesForSite } from "@/lib/siteMoves/store";

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
// A note's date is a calendar day on the wire (strict YYYY-MM-DD) and that day's UTC midnight in
// the column — never a local-time instant. The client-locale-string / server-local-parse / UTC
// serialize mix this file used to have walked every save one day backwards on any server east of
// UTC, silently re-dating notes and, with them, their before/after windows.
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

/**
 * UTC midnight (ms) of the day a request names — the one canonical storage form for Annotation.date.
 *
 * The wire format is a strict `YYYY-MM-DD`, parsed at UTC so the same string means the same day
 * whatever timezone the server happens to run in. A note's date is a calendar day, not an instant:
 * "what happened on Oct 12" cannot depend on the VPS's TZ env var. Anything looser than the strict
 * form is still accepted (floored to its UTC date) so an older client or a hand-rolled API call
 * cannot produce a 400 where the day is still recoverable, but the modal only ever sends the strict
 * form. Returns null only when no day can be read at all.
 */
function parseDayMs(s: string): number | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * The YYYY-MM-DD a stored Annotation.date value means. The column has historically held either
 * integer milliseconds or an ISO string (see {@link dayExpr}), and the pre-UTC-fix writes were
 * local midnights — for those, the UTC date of the instant is the date the tab was already
 * displaying, so taking the UTC date here preserves what readers saw instead of shifting it.
 */
const dayOf = (v: Date | string | number): string => new Date(v as never).toISOString().slice(0, 10);

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
    // The rollup row exists once per search type (web, discover, news, image, video); without
    // this filter every all-pages note summed all five — Discover traffic counted as search.
    urlFilter = ` AND "url" = '' AND "query" = '' AND "searchType" = 'web'`;
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

/** Per-page rows under a URL prefix — a folder or a subdomain inside this site's property. Same
 *  `query = ''` guard as page-scoped notes, for the same double-counting reason. "!" is the LIKE
 *  escape (see likePrefix). */
async function prefixSeries(siteId: string, from: Date, to: Date, prefix: string): Promise<DayRow[]> {
  const rows = await rawQuery<{ day: string; clicks: bigint | number; impressions: bigint | number; posw: number | null }[]>(
    `SELECT ${DAY_EXPR} AS day,
            SUM("clicks") AS clicks,
            SUM("impressions") AS impressions,
            SUM("position" * "impressions") AS posw
     FROM "DailyMetric"
     WHERE "siteId" = ? AND "date" >= ? AND "date" < ? AND "url" LIKE ? ESCAPE '!' AND "query" = ''
     GROUP BY day
     ORDER BY day ASC`,
    siteId, from, to, likePrefix(prefix),
  );
  return rows.map(r => ({
    day: r.day,
    clicks: Number(r.clicks ?? 0),
    impressions: Number(r.impressions ?? 0),
    posw: Number(r.posw ?? 0),
  }));
}

/** Day-wise sum of two series (union of days) — the "old + new" side of a move. */
function sumSeries(a: DayRow[], b: DayRow[]): DayRow[] {
  const m = new Map<string, DayRow>();
  for (const r of [...a, ...b]) {
    const x = m.get(r.day);
    if (x) { x.clicks += r.clicks; x.impressions += r.impressions; x.posw += r.posw; }
    else m.set(r.day, { ...r });
  }
  return [...m.values()].sort((p, q) => p.day.localeCompare(q.day));
}

/** The eventType/fromPrefix/toPrefix columns arrive with `prisma db push`; until then a read falls
 *  back to the old column set and a write that needs them says so instead of dropping them. */
function missingColumn(e: unknown): boolean {
  return /no such column|unknown column|does not exist/i.test(String((e as { message?: string })?.message ?? e));
}

type NoteRow = {
  id: string; date: Date | string | number; title: string; description: string | null;
  scope: string; urls: string | null;
  eventType: string | null; fromPrefix: string | null; toPrefix: string | null;
};

async function readNoteRows(siteId: string, since: string): Promise<{ rows: NoteRow[]; legacy: boolean }> {
  try {
    const rows = await rawQuery<NoteRow[]>(
      // `date` is compared through the same normalizer the day bucketing uses, because the column
      // holds either milliseconds or an ISO string depending on how the row was written.
      `SELECT "id", "date", "title", "description", "scope", "urls", "eventType", "fromPrefix", "toPrefix"
       FROM "Annotation" WHERE "siteId" = ? AND ${DAY_EXPR} >= ?
       ORDER BY "date" DESC LIMIT 200`,
      siteId, since,
    );
    return { rows, legacy: false };
  } catch (e) {
    if (!missingColumn(e)) throw e;
    const rows = await rawQuery<Omit<NoteRow, "eventType" | "fromPrefix" | "toPrefix">[]>(
      `SELECT "id", "date", "title", "description", "scope", "urls"
       FROM "Annotation" WHERE "siteId" = ? AND ${DAY_EXPR} >= ?
       ORDER BY "date" DESC LIMIT 200`,
      siteId, since,
    );
    return { rows: rows.map(r => ({ ...r, eventType: null, fromPrefix: null, toPrefix: null })), legacy: true };
  }
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
  return prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true, siteId: true } });
}

type EventFields =
  | { ok: true; eventType: EventType; fromPrefix: string | null; toPrefix: string | null; urls: string; scope: "all" | "pages" }
  | { ok: false; error: string };

/**
 * Body → stored event fields. A prefix move needs both prefixes, they must differ, and both must
 * sit inside this site's GSC property — otherwise the data is not in this site's DailyMetric and
 * the move is a cross-site one (link two sites instead). A move has no page list: its prefixes are
 * its scope.
 */
function parseEventFields(b: Record<string, unknown>, gscProperty: string): EventFields {
  const eventType = normalizeEventType(b.eventType);
  if (isPrefixMove(eventType)) {
    const fromPrefix = normalizePrefix(b.fromPrefix);
    const toPrefix = normalizePrefix(b.toPrefix);
    if (!fromPrefix || !toPrefix) return { ok: false, error: "bad_prefix" };
    if (fromPrefix === toPrefix) return { ok: false, error: "same_prefix" };
    if (checkPrefixInProperty(fromPrefix, gscProperty) !== "ok" || checkPrefixInProperty(toPrefix, gscProperty) !== "ok") {
      return { ok: false, error: "outside_property" };
    }
    return { ok: true, eventType, fromPrefix, toPrefix, urls: "", scope: "pages" };
  }
  const urls = Array.isArray(b.urls) ? b.urls.map(String).map(x => x.trim()).filter(Boolean).join("\n") : String(b.urls || "").trim();
  return { ok: true, eventType, fromPrefix: null, toPrefix: null, urls, scope: urls ? "pages" : "all" };
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
    const { rows: noteRows, legacy } = await readNoteRows(siteId, iso(addDays(new Date(), -lookback)));

    // Cross-site moves (src/lib/siteMoves) ride the same timeline on BOTH sites: the old one shows
    // where its traffic left, the new one where it arrived. Read-only here — they are edited in the
    // chain view, so their ids carry a "move:" prefix the UI uses to hide edit/delete.
    const moves = await movesForSite(siteId).catch(() => []);
    const otherIds = [...new Set(moves.map(m => (m.fromSiteId === siteId ? m.toSiteId : m.fromSiteId)))];
    const others = otherIds.length
      ? await prisma.site.findMany({ where: { id: { in: otherIds }, userId }, select: { id: true, url: true } })
      : [];
    const hostOf = new Map(others.map(o => [o.id, o.url.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/$/, "")]));
    const moveRows = moves
      .filter(m => hostOf.has(m.fromSiteId === siteId ? m.toSiteId : m.fromSiteId))
      .map(m => {
        const out = m.fromSiteId === siteId;
        const other = hostOf.get(out ? m.toSiteId : m.fromSiteId)!;
        return {
          id: `move:${m.id}`,
          date: new Date(`${m.date}T00:00:00Z`),
          title: out ? `→ ${other}` : `← ${other}`,
          description: m.note,
          scope: "all",
          urls: null as string | null,
          eventType: "domain_move" as EventType,
          fromPrefix: null as string | null,
          toPrefix: null as string | null,
        };
      });

    // `markers=1` — the dashboard chart only needs where the operator's own notes sit, not their
    // before/after figures. Skipping the scoring keeps the dashboard off the DailyMetric queries
    // the tab runs per page-scoped note.
    if (searchParams.get("markers") === "1") {
      return NextResponse.json({
        markers: [
          ...noteRows.map(r => ({ id: r.id, date: dayOf(r.date), title: r.title, scope: r.scope, eventType: normalizeEventType(r.eventType) })),
          ...moveRows.map(r => ({ id: r.id, date: dayOf(r.date), title: r.title, scope: r.scope, eventType: r.eventType })),
        ],
      });
    }

    const { updates } = await getAlgoUpdates();
    // Only updates the site could have lived through, and only as far back as the selected period.
    // Yesterday's update would report a confident nothing, so the newest day is excluded too.
    const oldest = iso(addDays(new Date(), -lookback));

    // Link purchases ride the same timeline: dated events scored against the same traffic,
    // with each order's target pages scoping its before/after exactly like a page-scoped
    // note. Derived from the purchase ledger on every read — nothing is copied into the
    // Annotation table, so a replayed submit or a re-import cannot fork the row.
    const purchaseEvents = await purchaseOrderEvents(siteId, oldest).catch(() => []);
    const purchaseEventRows = purchaseEvents.map(p => ({
      id: `purchase:${p.orderId}`,
      date: new Date(`${p.dayUtc}T00:00:00Z`),
      title: `Link purchase · ${p.quantity} · ${providerName(p.provider)}`,
      description: p.orderId,
      scope: "pages",
      urls: p.targetUrls.join("\n"),
      kind: "purchase" as const,
      updateType: null,
      endDate: null,
      mlQuantity: p.quantity,
      mlProvider: p.provider,
      orderId: p.orderId,
    }));

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
      ...noteRows.map(r => ({ ...r, eventType: normalizeEventType(r.eventType), kind: "note" as const, updateType: null, endDate: null })),
      ...moveRows.map(r => ({ ...r, kind: "note" as const, updateType: null, endDate: null })),
      ...purchaseEventRows,
      ...updateRows,
    ].sort((a, b) => +new Date(b.date) - +new Date(a.date));

    // One shared query covers every all-pages note; only page-scoped notes need their own.
    const dates = rows.map(r => new Date(r.date));
    const spanFrom = dates.length ? addDays(new Date(Math.min(...dates.map(d => +d))), -days) : new Date();
    const spanTo = dates.length ? addDays(new Date(Math.max(...dates.map(d => +d))), days) : new Date();
    const shared = dates.length ? await dailySeries(siteId, spanFrom, spanTo, []) : [];

    const notes = await Promise.all(rows.map(async r => {
      // The day the row names, normalized once at the boundary — a UTC-midnight anchor for all the
      // window math below. No setHours() anywhere: flooring an instant to the server's local
      // midnight and later re-serializing through the UTC iso() used to walk a note's date one day
      // into the past per save on any TZ-east-of-UTC server, which re-dated notes the operator had
      // just written and dragged their after-window into whatever partial data was nearest.
      const dayStr = dayOf(r.date);
      const d = new Date(`${dayStr}T00:00:00Z`);
      const beforeFrom = addDays(d, -days);
      const afterTo = addDays(d, days);
      const urls = (r.urls || "").split(/[\n,]/).map(s => s.trim()).filter(Boolean);

      // A folder/subdomain move is scored as "old prefix before" against "old + new after": the
      // question is how much of the traffic made it across, and the old URLs alone would only
      // ever show the fall. The breakdown below says which side the after-traffic sits on.
      const ev = (r as { eventType?: EventType }).eventType ?? "note";
      const mv = isPrefixMove(ev) && (r as NoteRow).fromPrefix && (r as NoteRow).toPrefix
        ? { from: (r as NoteRow).fromPrefix!, to: (r as NoteRow).toPrefix! } : null;
      let moveOld: DayRow[] = [], moveNew: DayRow[] = [];
      if (mv) {
        [moveOld, moveNew] = await Promise.all([
          prefixSeries(siteId, beforeFrom, afterTo, mv.from),
          prefixSeries(siteId, beforeFrom, afterTo, mv.to),
        ]);
      }
      const series = mv
        ? [...moveOld.filter(x => x.day < dayStr), ...sumSeries(moveOld.filter(x => x.day >= dayStr), moveNew.filter(x => x.day >= dayStr))]
        : urls.length
          ? await dailySeries(siteId, beforeFrom, afterTo, urls)
          : shared.filter(x => x.day >= iso(beforeFrom) && x.day < iso(afterTo));

      const beforeAll = series.filter(x => x.day < dayStr);
      const afterAll = series.filter(x => x.day >= dayStr);
      // Equal windows: however many synced days exist after the event, the before side is capped to
      // the same count (its last, i.e. nearest, days). Comparing a full week before against the
      // single lagging day Search Console has after is what printed a confident "-91%" on a note
      // written two days ago — a window-length artifact, not traffic. Both sides grow together as
      // sync catches up, so the numbers are fair at every moment rather than eventually.
      const w = Math.min(days, afterAll.length);
      const before = w > 0 ? beforeAll.slice(-w) : beforeAll;
      const after = afterAll;
      const b = totals(before), a = totals(after);

      // Move breakdown: clicks per day on each side after the move, and the share already on the
      // new prefix. Same after-window as the totals, so the two always add up.
      const move = mv ? (() => {
        const oA = totals(moveOld.filter(x => x.day >= dayStr));
        const nA = totals(moveNew.filter(x => x.day >= dayStr));
        const byOld = new Map(moveOld.map(x => [x.day, x.clicks]));
        const byNew = new Map(moveNew.map(x => [x.day, x.clicks]));
        return {
          from: mv.from, to: mv.to,
          oldAfterClicks: oA.clicks, newAfterClicks: nA.clicks,
          newShare: oA.clicks + nA.clicks > 0 ? Math.round((nA.clicks / (oA.clicks + nA.clicks)) * 100) : null,
          series: Array.from({ length: days * 2 }, (_, i) => {
            const day = iso(addDays(beforeFrom, i));
            return { date: day, old: byOld.get(day) ?? 0, new: byNew.get(day) ?? 0 };
          }),
        };
      })() : null;

      return {
        id: r.id,
        kind: r.kind,
        eventType: ev,
        fromPrefix: (r as NoteRow).fromPrefix ?? null,
        toPrefix: (r as NoteRow).toPrefix ?? null,
        move,
        // Only set on updates: the chart colours a rollout band by type and shades from start to
        // end, and a note has neither.
        updateType: r.updateType,
        endDate: r.endDate,
        // Only set on purchases: quantity and provider for the localized row label, orderId for
        // the jump to the order. FieldLink briefs are re-read from the service, so this is the
        // paid truth, not the browser's draft.
        mlQuantity: (r as { mlQuantity?: number }).mlQuantity ?? null,
        mlProvider: (r as { mlProvider?: string }).mlProvider ?? null,
        orderId: (r as { orderId?: string }).orderId ?? null,
        date: dayStr,
        title: r.title,
        description: r.description || "",
        scope: r.scope,
        urls,
        dateRange: `${iso(beforeFrom)} → ${iso(addDays(afterTo, -1))}`,
        // `hasAfter` lets the UI say "waiting for data" instead of showing a confident 0 — the
        // normal state for a note written today. A synced day with zero impressions still counts:
        // zero traffic on a day the sync wrote is data, not absence.
        hasAfter: after.length > 0,
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

    return NextResponse.json({ notes, days, needsDbPush: legacy });
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
  // A calendar day, stored as its UTC midnight — see parseDayMs. The client always sends the
  // strict form; the fallback keeps a bare API call working in UTC rather than 400-ing.
  const dayMs = parseDayMs(b.date ? String(b.date) : iso(new Date()));
  if (!siteId || !title) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (dayMs == null) return NextResponse.json({ error: "bad_date" }, { status: 400 });
  const site = await ownedSite(userId, siteId);
  if (!site) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const f = parseEventFields(b, site.siteId);
  if (!f.ok) return NextResponse.json({ error: f.error }, { status: 400 });

  const id = `ann_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    await rawExec(
      `INSERT INTO "Annotation" ("id","siteId","date","title","description","scope","urls","eventType","fromPrefix","toPrefix","createdAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, siteId, new Date(dayMs), title, String(b.description || ""), f.scope, f.urls || null,
      f.eventType, f.fromPrefix, f.toPrefix, new Date(),
    );
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    // Before `db push` the new columns are missing. A plain note still fits the old shape; a typed
    // event or a move would lose exactly what makes it one, so it is refused with a reason.
    if (missingColumn(e)) {
      if (f.eventType !== "note") return NextResponse.json({ error: "needs_db_push" }, { status: 503 });
      try {
        await rawExec(
          `INSERT INTO "Annotation" ("id","siteId","date","title","description","scope","urls","createdAt")
           VALUES (?,?,?,?,?,?,?,?)`,
          id, siteId, new Date(dayMs), title, String(b.description || ""), f.scope, f.urls || null, new Date(),
        );
        return NextResponse.json({ ok: true, id });
      } catch (e2) { e = e2; }
    }
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

  const date = b.date ? parseDayMs(String(b.date)) : null;
  if (b.date && date == null) return NextResponse.json({ error: "bad_date" }, { status: 400 });

  // The note's site decides which prefixes are in-property, so it is looked up through the same
  // ownership join the UPDATE uses.
  const owner = await rawQuery<{ gsc: string }[]>(
    `SELECT s."siteId" AS gsc FROM "Annotation" a JOIN "Site" s ON s."id" = a."siteId"
     WHERE a."id" = ? AND s."userId" = ?`,
    id, userId,
  ).catch(() => []);
  if (!owner.length) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Only a body that names the event fields rewrites them — an older client sending title/date
  // alone must not reset a move to a plain note.
  const touchesEvent = "eventType" in b || "fromPrefix" in b || "toPrefix" in b || "urls" in b;
  const f = touchesEvent ? parseEventFields(b, owner[0].gsc) : null;
  if (f && !f.ok) return NextResponse.json({ error: f.error }, { status: 400 });

  if (f && f.ok) {
    try {
      await rawExec(
        `UPDATE "Annotation" SET "eventType" = ?, "fromPrefix" = ?, "toPrefix" = ?, "scope" = ?, "urls" = ?
         WHERE "id" = ? AND "siteId" IN (SELECT "id" FROM "Site" WHERE "userId" = ?)`,
        f.eventType, f.fromPrefix, f.toPrefix, f.scope, f.urls || null, id, userId,
      );
    } catch (e) {
      if (!missingColumn(e) || f.eventType !== "note") {
        console.error("[Annotations] update event fields failed", e);
        return NextResponse.json({ error: missingColumn(e) ? "needs_db_push" : "update_failed" }, { status: missingColumn(e) ? 503 : 500 });
      }
    }
  }

  try {
    // Same ownership guard as DELETE: the row can only be touched through a site the caller owns.
    // COALESCE rather than `date ?? null`: writing a bare NULL used to blank the column outright on
    // an edit that carried no date, destroying the note's anchor — an absent date now keeps the
    // stored one.
    await rawExec(
      `UPDATE "Annotation" SET "title" = ?, "description" = ?, "date" = COALESCE(?, "date")
       WHERE "id" = ? AND "siteId" IN (SELECT "id" FROM "Site" WHERE "userId" = ?)`,
      title, String(b.description || ""), date != null ? new Date(date) : null, id, userId,
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[Annotations] update failed", e);
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
}
