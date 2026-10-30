// N8 — the section data collectors. This is the only module of the renderer that talks to
// the database: it turns a (site, period) into plain JSON every section can render from.
//
// Rules the rest of the pipeline depends on:
//   • A section with nothing to show is `undefined` — the renderer then skips it entirely.
//     "No data" is never a zero: a null-ish aggregate simply does not enter the data (the
//     null ≠ 0 rule; the "no data" pill is the renderer's business, not the number's).
//   • Every collector swallows its own absence: a site with no uptime monitor must not
//     break the traffic section of the same report.
//
// Reachable models go through the untyped accessor (drops/store convention): the generated
// client only knows ClientReport* after `prisma db push`, and a pulled-but-not-restarted
// instance must answer `notMigrated`, not crash at import time.

import { dbAny } from "@/lib/prisma";
import { uptimeSummary } from "@/lib/uptime/store";
import { sovForSite } from "@/lib/visibility/store";
import { AUDIT_RULES } from "@/lib/audit/rules";
import type { PsiSummary } from "@/lib/audit/psi";
import { normDomain } from "@/lib/mcp/shared";
import { getUserGoogleAccounts, queryGscWithStatus, type GscAccount } from "@/lib/gscQuery";
// The two windows (calendar vs Search Console) and their date math live in ./window, which
// is pure and unit-tested; re-exported so existing imports keep working.
import { summarizeBacklinks, type BacklinksData, type StoredBacklink } from "./backlinks";
import { latestBacklinkProvider } from "@/lib/seo/siteBacklinkStore";
import { providerDrLabel } from "@/lib/seo/backlinkProvider";
import { DAY_MS, gscRowsToTop, mergeTopRows, reportWindow, type MetricRow, type ReportWindow, type TopRow } from "./window";
export { reportWindow, type MetricRow, type ReportWindow };

 
const db = dbAny;

// ─── traffic ──────────────────────────────────────────────────────────────────

export interface TrafficTotals { clicks: number; impressions: number; ctr: number | null; position: number | null }
export interface TrafficPoint { date: string; clicks: number; impressions: number }

export interface TrafficData {
  current: TrafficTotals;
  previous: TrafficTotals | null;
  series: TrafficPoint[];
}

/** Totals over the date-only web rollup (url='' query='' searchType='web' — the only row
 *  kind a whole-site aggregate may read; mixing types counts every day five times). */
async function trafficTotals(siteId: string, from: Date, to: Date): Promise<TrafficTotals> {
  const rows: { clicks: number; impressions: number; ctr: number; position: number }[] =
    await db.dailyMetric.findMany({
      where: { siteId, url: "", query: "", searchType: "web", date: { gte: from, lt: to } },
      select: { clicks: true, impressions: true, ctr: true, position: true },
    });
  return totalsOf(rows);
}

function totalsOf(rows: { clicks: number; impressions: number; ctr: number; position: number }[]): TrafficTotals {
  let clicks = 0, impressions = 0, posWeighted = 0, posDays = 0;
  for (const r of rows) {
    clicks += Number(r.clicks) || 0;
    impressions += Number(r.impressions) || 0;
    if (Number.isFinite(r.position) && r.position > 0) { posWeighted += r.position * (Number(r.impressions) || 0); posDays += Number(r.impressions) || 0; }
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    position: posDays > 0 ? posWeighted / posDays : null,
  };
}

export async function collectTraffic(siteId: string, w: ReportWindow): Promise<TrafficData | undefined> {
  // Search window, not calendar window: the dashboard's KPIs end two days back (GSC lag), and
  // the report must quote the same numbers for "the same 7 days" (issue #27).
  const s = w.search;
  const [current, previous, seriesRows] = await Promise.all([
    trafficTotals(siteId, s.from, s.to),
    trafficTotals(siteId, s.prevFrom, s.prevTo),
    db.dailyMetric.findMany({
      where: { siteId, url: "", query: "", searchType: "web", date: { gte: s.from, lt: s.to } },
      select: { date: true, clicks: true, impressions: true },
      orderBy: { date: "asc" },
    }) as { date: Date; clicks: number; impressions: number }[],
  ]);
  if (current.clicks === 0 && current.impressions === 0 && !seriesRows.length) return undefined;
  const series: TrafficPoint[] = seriesRows.map(r => ({
    date: new Date(r.date).toISOString().slice(0, 10),
    clicks: Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
  }));
  return { current, previous: previous.clicks === 0 && previous.impressions === 0 ? null : previous, series };
}

// ─── queries / pages ──────────────────────────────────────────────────────────
//
// Issue #27: these used to groupBy DailyMetric over the report window with `query != ""` /
// `url != ""`. That filter also catches the query+page rows of sync step 4 — 90-day TOTALS
// with no date dimension, stamped date=endDate so "date >= since" readers find them. Any window
// containing the sync day therefore summed 90 days of data (and, for queries, summed it again
// across every page the query ranked on); Top pages double-counted on top of that, adding
// those totals to the genuine per-day url rows. The www/non-www mix in the report was the
// same bug: old URLs from 90 days back leaking into a 7-day table.
//
// Now: both come from Search Console live — the same call the dashboard makes, for the same
// window — so the two agree by construction. There are no per-day query rows in the database
// at all, so a query table without GSC is simply absent (never 90-day totals passed off as a
// week). Pages can fall back to the per-day url rows (query = ""), which are exact for the
// 90 days the sync keeps.

export interface RowsData { rows: MetricRow[] }

const TOP_N = 20;
/** Previous-period lookup depth: enough that a current top-20 key almost always finds its
 *  baseline. One API call either way — rowLimit costs no extra quota. */
const PREV_DEPTH = 5000;
/** How many days of per-day url rows gscSync keeps (step 3). */
const URL_ROWS_KEPT_DAYS = 90;

interface GscSource { accounts: GscAccount[]; property: string }

async function gscSource(userId: string, siteId: string): Promise<GscSource | null> {
  const site: { siteId: string | null } | null = await db.site.findFirst({
    where: { id: siteId, userId }, select: { siteId: true },
  });
  if (!site?.siteId) return null;
  const accounts = await getUserGoogleAccounts(userId).catch(() => [] as GscAccount[]);
  return accounts.length ? { accounts, property: site.siteId } : null;
}

async function liveTop(src: GscSource, dimension: "query" | "page", w: ReportWindow): Promise<RowsData | undefined | null> {
  const s = w.search;
  const [cur, prev] = await Promise.all([
    queryGscWithStatus<{ keys?: string[] | null; clicks?: number | null; impressions?: number | null; position?: number | null }>(
      src.accounts, src.property, { startDate: s.startStr, endDate: s.endStr, dimensions: [dimension], rowLimit: TOP_N }),
    queryGscWithStatus<{ keys?: string[] | null; clicks?: number | null; impressions?: number | null; position?: number | null }>(
      src.accounts, src.property, { startDate: s.prevStartStr, endDate: s.prevEndStr, dimensions: [dimension], rowLimit: PREV_DEPTH }),
  ]);
  if (cur.failure) {
    // Named on purpose: "over quota" is transient and passes by the next scheduled report,
    // "unreachable" means a human should look at the Google connection (issue #38).
    console.warn(`[reports] Top ${dimension}s: Search Console ${cur.failure === "quota" ? "is over quota" : "is unreachable"} for ${src.property}`);
    return null;
  }
  const rows = mergeTopRows(gscRowsToTop(cur.rows), prev.failure ? null : gscRowsToTop(prev.rows), TOP_N);
  return rows.length ? { rows } : undefined;
}

/** Per-day url rows only (query = ""): sync step 3, exact, kept for 90 days. */
async function storedPages(siteId: string, w: ReportWindow): Promise<RowsData | undefined> {
  const s = w.search;
  const sum = async (from: Date, to: Date, take: number): Promise<TopRow[]> => {
    const rows: { url: string; _sum: { clicks: number | null; impressions: number | null } }[] =
      await db.dailyMetric.groupBy({
        by: ["url"],
        where: { siteId, searchType: "web", query: "", url: { not: "" }, date: { gte: from, lt: to } },
        _sum: { clicks: true, impressions: true },
        // Prisma requires an explicit orderBy whenever take is used on groupBy (issue #24).
        orderBy: { _sum: { clicks: "desc" } },
        take,
      });
    return rows.map(r => ({ key: r.url, clicks: Number(r._sum?.clicks) || 0, impressions: Number(r._sum?.impressions) || 0 }));
  };
  const [cur, prev] = await Promise.all([sum(s.from, s.to, TOP_N), sum(s.prevFrom, s.prevTo, PREV_DEPTH)]);
  if (!cur.length) return undefined;
  // The sync only keeps 90 days of url rows: a previous window reaching past that has no
  // baseline, which must read as "—", not as every page being new.
  const oldestKept = s.to.getTime() - URL_ROWS_KEPT_DAYS * DAY_MS;
  const prevCovered = s.prevFrom.getTime() >= oldestKept;
  return { rows: mergeTopRows(cur, prevCovered ? prev : null, TOP_N) };
}

export async function collectQueries(userId: string, siteId: string, w: ReportWindow): Promise<RowsData | undefined> {
  const src = await gscSource(userId, siteId);
  if (!src) return undefined;
  const live = await liveTop(src, "query", w);
  if (live === null) console.warn(`[reports] Top queries: Search Console unreachable for site ${siteId}; section omitted`);
  return live ?? undefined;
}

export async function collectPages(userId: string, siteId: string, w: ReportWindow): Promise<RowsData | undefined> {
  const src = await gscSource(userId, siteId);
  if (src) {
    const live = await liveTop(src, "page", w);
    if (live !== null) return live;
  }
  return storedPages(siteId, w);
}

// ─── positions (Rank Tracker) ─────────────────────────────────────────────────

export interface KeywordMove {
  keyword: string;
  location: string;
  position: number | null;
  prevPosition: number | null;
  change: number | null;
  /** ISO time of the last successful check. Null = never. Omitted on reports built before the column existed. */
  foundAt?: string | null;
}

export interface PositionsData {
  checked: number | null; // keywords with at least one check; null = tracker never ran
  top3: number;
  top10: number;
  improved: KeywordMove[];
  declined: KeywordMove[];
}

export async function collectPositions(siteId: string, limit = 8): Promise<PositionsData | undefined> {
  const rows: {
    keyword: string; location: string; lastPosition: number | null; prevPosition: number | null; lastCheckedAt: Date | null;
    lastSuccessfulCheckAt: Date | null;
  }[] = await db.trackedKeyword.findMany({
    where: { siteId },
    select: { keyword: true, location: true, lastPosition: true, prevPosition: true, lastCheckedAt: true, lastSuccessfulCheckAt: true },
  });
  if (!rows.length) return undefined;
  const moves: KeywordMove[] = rows.map(r => ({
    keyword: r.keyword,
    location: r.location ?? "",
    position: r.lastPosition ?? null,
    prevPosition: r.prevPosition ?? null,
    change: r.lastPosition != null && r.prevPosition != null ? r.prevPosition - r.lastPosition : null,
    foundAt: r.lastSuccessfulCheckAt ? r.lastSuccessfulCheckAt.toISOString() : null,
  }));
  const checked = rows.filter(r => r.lastCheckedAt).length;
  // null = not found in depth; only ranked keywords count towards top-N.
  const ranked = moves.filter(m => m.position != null);
  const improved = moves
    .filter(m => (m.change ?? 0) > 0)
    .sort((a, b) => (b.change ?? 0) - (a.change ?? 0) || (a.position ?? 99) - (b.position ?? 99))
    .slice(0, limit);
  const declined = moves
    .filter(m => (m.change ?? 0) < 0)
    .sort((a, b) => (a.change ?? 0) - (b.change ?? 0) || (b.position ?? 0) - (a.position ?? 0))
    .slice(0, limit);
  return {
    checked: rows.some(r => r.lastCheckedAt) ? checked : null,
    top3: ranked.filter(m => (m.position ?? 99) <= 3).length,
    top10: ranked.filter(m => (m.position ?? 99) <= 10).length,
    improved,
    declined,
  };
}

// ─── local visibility (N3/N4 data) ────────────────────────────────────────────

export interface LocalKeywordRow {
  keyword: string;
  location: string;
  position: number | null;
  localPack: number | null;
  foundAt?: string | null;
}
export interface LocalData {
  keywords: LocalKeywordRow[];
  inPack: number;
  nap: { status: string; count: number }[] | null;
}

export async function collectLocal(siteId: string): Promise<LocalData | undefined> {
  const rows: { keyword: string; location: string; lastPosition: number | null; lastLocalPack: number | null; lastSuccessfulCheckAt: Date | null }[] =
    await db.trackedKeyword.findMany({
      where: { siteId, location: { not: "" } },
      select: { keyword: true, location: true, lastPosition: true, lastLocalPack: true, lastSuccessfulCheckAt: true },
    });
  const citations: { status: string }[] = await db.localCitation.findMany({
    where: { siteId },
    select: { status: true },
  }).catch(() => []); // table is N4's; a merge without it must not break the local template
  if (!rows.length && !citations.length) return undefined;
  const keywords: LocalKeywordRow[] = rows.map(r => ({
    keyword: r.keyword,
    location: r.location ?? "",
    position: r.lastPosition ?? null,
    localPack: r.lastLocalPack != null ? r.lastLocalPack : null,
    foundAt: r.lastSuccessfulCheckAt ? r.lastSuccessfulCheckAt.toISOString() : null,
  }));
  const nap = citations.length
    ? Object.entries(citations.reduce<Record<string, number>>((acc, c) => {
        acc[c.status] = (acc[c.status] ?? 0) + 1;
        return acc;
      }, {})).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count)
    : null;
  return { keywords, inPack: keywords.filter(k => (k.localPack ?? 0) >= 1 && (k.localPack ?? 0) <= 3).length, nap };
}

// ─── indexing (IndexCoverageDaily) ────────────────────────────────────────────

export interface CoveragePoint { day: string; total: number; indexed: number; notIndexed: number; unknown: number }
export interface IndexingData { first: CoveragePoint | null; latest: CoveragePoint | null; series: CoveragePoint[] }

export async function collectIndexing(siteId: string, w: ReportWindow): Promise<IndexingData | undefined> {
  const rows: { day: string; total: number; indexed: number; notIndexed: number; unknown: number }[] =
    await db.indexCoverageDaily.findMany({
      where: { siteId, day: { gte: w.from.toISOString().slice(0, 10) } },
      orderBy: { day: "asc" },
    }).catch(() => []); // T4 table; absent on old instances
  if (!rows.length) return undefined;
  const series: CoveragePoint[] = rows.map(r => ({
    day: r.day, total: Number(r.total) || 0, indexed: Number(r.indexed) || 0,
    notIndexed: Number(r.notIndexed) || 0, unknown: Number(r.unknown) || 0,
  }));
  return { first: series[0] ?? null, latest: series[series.length - 1] ?? null, series };
}

// ─── audit (last completed run, incl. the Core Web Vitals sample) ─────────────

export interface AuditIssueRow { code: string; severity: string; count: number }
export interface CwvRow { url: string; lcp: number | null; inp: number | null; cls: number | null; score: number | null; source: string }
export interface AuditData {
  startedAt: string;
  pages: number | null;
  healthScore: number | null;
  pagesWithIssues: number | null;
  topIssues: AuditIssueRow[];
  cwv: CwvRow[];
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export async function collectAudit(siteId: string): Promise<AuditData | undefined> {
  const audit: { id: string; startedAt: Date; summary: string | null } | null = await db.siteAudit.findFirst({
    where: { siteId, status: "completed" },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true, summary: true },
  });
  if (!audit) return undefined;
  let summary: Record<string, unknown> = {};
  try { summary = audit.summary ? JSON.parse(audit.summary) : {}; } catch { /* legacy row */ }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const issues = (summary.issues && typeof summary.issues === "object" && !Array.isArray(summary.issues))
    ? issuesWithSeverity(summary.issues as Record<string, unknown>)
    : [];
  const psi = summary.psi as PsiSummary | undefined;
  const cwv: CwvRow[] = Array.isArray(psi?.items)
    ? psi.items.map(i => ({
        url: i.url, lcp: i.lcp ?? null, inp: i.inp ?? null, cls: i.cls ?? null,
        score: i.score ?? null, source: i.source,
      }))
    : [];
  return {
    startedAt: new Date(audit.startedAt).toISOString(),
    pages: num(summary.pages),
    healthScore: num(summary.healthScore),
    pagesWithIssues: num(summary.pagesWithIssues),
    topIssues: issues,
    cwv,
  };
}

function issuesWithSeverity(counts: Record<string, unknown>): AuditIssueRow[] {
  const severityOf = new Map(AUDIT_RULES.map(r => [r.id, r.severity]));
  return Object.entries(counts)
    .filter(([, n]) => typeof n === "number" && (n as number) > 0)
    .map(([code, n]) => ({ code, severity: severityOf.get(code) ?? "warning", count: n as number }))
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || b.count - a.count)
    .slice(0, 8);
}

// ─── uptime ───────────────────────────────────────────────────────────────────

export interface UptimeIncidentRow { startedAt: string; endedAt: string | null; durationMs: number | null; cause: string; detail: string | null }
export interface UptimeData { url: string; uptimePct: number | null; incidents: UptimeIncidentRow[] }

export async function collectUptime(userId: string, siteId: string, w: ReportWindow): Promise<UptimeData | undefined> {
  const summary = await uptimeSummary(userId, siteId).catch(() => null);
  if (!summary) return undefined;
  // The window closes on the report's `to`; incidents that started inside it.
  const incidents: UptimeIncidentRow[] = summary.incidents
    .filter(i => new Date(i.startedAt).getTime() >= w.from.getTime() - DAY_MS)
    .slice(0, 10)
    .map(i => ({
      startedAt: i.startedAt, endedAt: i.endedAt, durationMs: i.durationMs,
      cause: i.cause, detail: i.detail ?? null,
    }));
  const uptimePct = w.days <= 7 ? summary.uptime.d7 : w.days <= 30 ? summary.uptime.d30 : summary.uptime.d90;
  return { url: summary.monitor.url, uptimePct, incidents };
}

// ─── backlinks (SiteBacklink) ─────────────────────────────────────────────────
// The arithmetic lives in ./backlinks (pure, tested); this only reads the rows, the window's
// api-origin `lost` events and the provider that filled the table.

export type { BacklinkRow, BacklinksData } from "./backlinks";

export async function collectBacklinks(siteId: string, w: ReportWindow): Promise<BacklinksData | undefined> {
  const rows: StoredBacklink[] = await db.siteBacklink.findMany({
    where: { siteId },
    select: {
      id: true, urlFrom: true, domainFrom: true, apiDr: true, apiAnchor: true,
      apiFirstSeen: true, apiLastSeen: true, apiLost: true,
    },
  }).catch(() => []); // wave-oct table; absent on old instances
  if (!rows.length) return undefined;
  const events: { backlinkId: string }[] = await db.siteBacklinkEvent.findMany({
    where: { siteId, kind: "lost", origin: "api", createdAt: { gte: w.from, lt: w.to } },
    select: { backlinkId: true },
  }).catch(() => []);
  const provider = await latestBacklinkProvider(siteId);
  return summarizeBacklinks({
    rows, lostEventIds: events.map(e => e.backlinkId), from: w.from, to: w.to,
    provider, drLabel: providerDrLabel(provider),
  });
}

// ─── AI visibility (share of voice) ───────────────────────────────────────────

export interface AiVisibilityData {
  windowDays: number;
  questions: number;
  answers: number;
  ourShare: number | null;      // mention share 0..1, null = no answers at all
  citationShare: number | null; // citation share 0..1
  topCited: { domain: string; citations: number; isUs: boolean }[];
}

export async function collectAiVisibility(userId: string, siteId: string, w: ReportWindow): Promise<AiVisibilityData | undefined> {
  const res = await sovForSite(userId, siteId, w.days <= 7 ? 7 : w.days <= 30 ? 30 : 90).catch(() => null);
  if (!res) return undefined;
  const { report, cited } = res;
  if (!report.answers) return undefined; // questions tracked but never checked → no data, not 0 %
  const us = report.shareOfVoice.find(s => s.isUs);
  const usCite = report.citationShare.find(s => s.isUs);
  return {
    windowDays: w.days <= 7 ? 7 : w.days <= 30 ? 30 : 90,
    questions: report.questions,
    answers: report.answers,
    ourShare: us ? us.share : 0,
    citationShare: usCite ? usCite.share : 0,
    topCited: cited.slice(0, 8).map(c => ({ domain: c.domain, citations: c.citations, isUs: c.isUs })),
  };
}

// ─── GBP reviews (N4 data) ────────────────────────────────────────────────────

export interface ReviewRow { author: string; rating: number; comment: string; createTime: string; replyText: string | null }
export interface ReviewsData { count: number; avgRating: number | null; latest: ReviewRow[] }

export async function collectReviews(siteId: string, w: ReportWindow): Promise<ReviewsData | undefined> {
  const rows: {
    author: string; rating: number; comment: string; createTime: Date; replyText: string | null;
  }[] = await db.gbpReview.findMany({
    where: { siteId, createTime: { gte: w.prevFrom } },
    orderBy: { createTime: "desc" },
    select: { author: true, rating: true, comment: true, createTime: true, replyText: true },
  }).catch(() => []); // table is N4's
  if (!rows.length) return undefined;
  const inWindow = rows.filter(r => new Date(r.createTime).getTime() <= w.to.getTime());
  const ratings = inWindow.map(r => Number(r.rating)).filter(n => n >= 1 && n <= 5);
  return {
    count: inWindow.length,
    avgRating: ratings.length ? Math.round(ratings.reduce((s, r) => s + r, 0) / ratings.length * 10) / 10 : null,
    latest: inWindow.slice(0, 5).map(r => ({
      author: r.author ?? "", rating: Number(r.rating) || 0,
      comment: (r.comment ?? "").slice(0, 400), createTime: new Date(r.createTime).toISOString(),
      replyText: r.replyText ?? null,
    })),
  };
}

// ─── the whole picture ────────────────────────────────────────────────────────

export interface ReportData {
  siteDomain: string;
  // `searchFrom`/`searchTo` (inclusive) are the Search Console dates the traffic / queries /
  // pages sections cover — two days behind the calendar window, like the dashboard. Optional:
  // snapshots frozen before issue #27 do not carry them.
  window: { from: string; to: string; days: number; prevFrom: string; prevTo: string; searchFrom?: string; searchTo?: string };
  traffic?: TrafficData;
  queries?: RowsData;
  pages?: RowsData;
  positions?: PositionsData;
  local?: LocalData;
  indexing?: IndexingData;
  audit?: AuditData;
  uptime?: UptimeData;
  backlinks?: BacklinksData;
  ai?: AiVisibilityData;
  reviews?: ReviewsData;
}

export async function collectReportData(
  userId: string,
  siteId: string,
  w: ReportWindow,
  sections: readonly string[],
): Promise<ReportData> {
  const has = (s: string) => sections.includes(s);
  const site: { siteId: string; url: string | null } | null = await db.site.findFirst({
    where: { id: siteId, userId }, select: { siteId: true, url: true },
  });
  const data: ReportData = {
    siteDomain: site ? normDomain(site.siteId) : "",
    window: {
      from: w.from.toISOString().slice(0, 10), to: w.to.toISOString().slice(0, 10), days: w.days,
      prevFrom: w.prevFrom.toISOString().slice(0, 10), prevTo: w.prevTo.toISOString().slice(0, 10),
      searchFrom: w.search.startStr, searchTo: w.search.endStr,
    },
  };
  // Independent collectors; one failing section must not take the report down.
  const jobs: Promise<void>[] = [];
  const run = (p: Promise<unknown>, set: (v: unknown) => void) =>
    jobs.push(p.then(set).catch(e => console.warn("[reports] section collector failed:", e)));
  if (has("traffic")) run(collectTraffic(siteId, w), v => { data.traffic = v as TrafficData; });
  if (has("queries")) run(collectQueries(userId, siteId, w), v => { data.queries = v as RowsData; });
  if (has("pages")) run(collectPages(userId, siteId, w), v => { data.pages = v as RowsData; });
  if (has("positions")) run(collectPositions(siteId), v => { data.positions = v as PositionsData; });
  if (has("local_positions")) run(collectLocal(siteId), v => { data.local = v as LocalData; });
  if (has("indexing")) run(collectIndexing(siteId, w), v => { data.indexing = v as IndexingData; });
  if (has("audit")) run(collectAudit(siteId), v => { data.audit = v as AuditData; });
  if (has("uptime")) run(collectUptime(userId, siteId, w), v => { data.uptime = v as UptimeData; });
  if (has("backlinks")) run(collectBacklinks(siteId, w), v => { data.backlinks = v as BacklinksData; });
  if (has("ai_visibility")) run(collectAiVisibility(userId, siteId, w), v => { data.ai = v as AiVisibilityData; });
  if (has("reviews")) run(collectReviews(siteId, w), v => { data.reviews = v as ReviewsData; });
  await Promise.all(jobs);
  return data;
}
