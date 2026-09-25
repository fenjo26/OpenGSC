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

import { prisma } from "@/lib/prisma";
import { uptimeSummary } from "@/lib/uptime/store";
import { sovForSite } from "@/lib/visibility/store";
import { AUDIT_RULES } from "@/lib/audit/rules";
import type { PsiSummary } from "@/lib/audit/psi";
import { normDomain } from "@/lib/mcp/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema
const db = prisma as any;

const DAY_MS = 86_400_000;

export interface ReportWindow {
  from: Date;
  to: Date;
  prevFrom: Date;
  prevTo: Date;
  days: number;
}

export function reportWindow(days: number, now = new Date()): ReportWindow {
  const to = new Date(now);
  const from = new Date(to.getTime() - days * DAY_MS);
  const prevTo = new Date(from);
  const prevFrom = new Date(prevTo.getTime() - days * DAY_MS);
  return { from, to, prevFrom, prevTo, days };
}

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
  const [current, previous, seriesRows] = await Promise.all([
    trafficTotals(siteId, w.from, w.to),
    trafficTotals(siteId, w.prevFrom, w.prevTo),
    db.dailyMetric.findMany({
      where: { siteId, url: "", query: "", searchType: "web", date: { gte: w.from, lt: w.to } },
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

export interface MetricRow {
  key: string;
  clicks: number;
  impressions: number;
  prevClicks: number | null;
  delta: number | null; // clicks vs previous period; null = the query is new or has no baseline
}

export interface RowsData { rows: MetricRow[] }

async function collectRows(siteId: string, w: ReportWindow, field: "query" | "url"): Promise<RowsData | undefined> {
  const [cur, prev] = await Promise.all([
    db.dailyMetric.groupBy({
      by: [field],
      where: { siteId, searchType: "web", date: { gte: w.from, lt: w.to }, [field]: { not: "" } },
      _sum: { clicks: true, impressions: true },
      orderBy: { _sum: { clicks: "desc" } },
      take: 20,
    }),
    db.dailyMetric.groupBy({
      by: [field],
      where: { siteId, searchType: "web", date: { gte: w.prevFrom, lt: w.prevTo }, [field]: { not: "" } },
      _sum: { clicks: true },
      take: 5000,
    }),
  ]);
  if (!cur.length) return undefined;
  const prevMap = new Map<string, number>(prev.map((r: Record<string, unknown>) => [String(r[field]), Number((r._sum as { clicks?: number })?.clicks) || 0]));
  const rows: MetricRow[] = cur.map((r: Record<string, unknown>) => {
    const clicks = Number((r._sum as { clicks?: number })?.clicks) || 0;
    const prevClicks = prevMap.has(String(r[field])) ? prevMap.get(String(r[field])) ?? 0 : null;
    return {
      key: String(r[field]),
      clicks,
      impressions: Number((r._sum as { impressions?: number })?.impressions) || 0,
      prevClicks,
      delta: prevClicks === null ? null : clicks - prevClicks,
    };
  });
  return { rows };
}

export const collectQueries = (siteId: string, w: ReportWindow) => collectRows(siteId, w, "query");
export const collectPages = (siteId: string, w: ReportWindow) => collectRows(siteId, w, "url");

// ─── positions (Rank Tracker) ─────────────────────────────────────────────────

export interface KeywordMove { keyword: string; location: string; position: number | null; prevPosition: number | null; change: number | null }

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
  }[] = await db.trackedKeyword.findMany({
    where: { siteId },
    select: { keyword: true, location: true, lastPosition: true, prevPosition: true, lastCheckedAt: true },
  });
  if (!rows.length) return undefined;
  const moves: KeywordMove[] = rows.map(r => ({
    keyword: r.keyword,
    location: r.location ?? "",
    position: r.lastPosition ?? null,
    prevPosition: r.prevPosition ?? null,
    change: r.lastPosition != null && r.prevPosition != null ? r.prevPosition - r.lastPosition : null,
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

export interface LocalKeywordRow { keyword: string; location: string; position: number | null; localPack: number | null }
export interface LocalData {
  keywords: LocalKeywordRow[];
  inPack: number;
  nap: { status: string; count: number }[] | null;
}

export async function collectLocal(siteId: string): Promise<LocalData | undefined> {
  const rows: { keyword: string; location: string; lastPosition: number | null; lastLocalPack: number | null }[] =
    await db.trackedKeyword.findMany({
      where: { siteId, location: { not: "" } },
      select: { keyword: true, location: true, lastPosition: true, lastLocalPack: true },
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

export interface BacklinkRow { urlFrom: string; domainFrom: string; dr: number | null; anchor: string }
export interface BacklinksData {
  newCount: number;
  lostCount: number;
  avgDr: number | null;
  topNew: BacklinkRow[];
}

export async function collectBacklinks(siteId: string, w: ReportWindow): Promise<BacklinksData | undefined> {
  const rows: {
    urlFrom: string; domainFrom: string; apiDr: number | null; apiAnchor: string;
    apiFirstSeen: string; apiLost: boolean;
  }[] = await db.siteBacklink.findMany({
    where: { siteId },
    select: { urlFrom: true, domainFrom: true, apiDr: true, apiAnchor: true, apiFirstSeen: true, apiLost: true },
  }).catch(() => []); // wave-oct table; absent on old instances
  if (!rows.length) return undefined;
  const fromDay = w.from.toISOString().slice(0, 10);
  const toDay = w.to.toISOString().slice(0, 10);
  const isNew = (r: { apiFirstSeen: string }) => /^\d{4}-\d{2}-\d{2}$/.test(r.apiFirstSeen) && r.apiFirstSeen >= fromDay && r.apiFirstSeen <= toDay;
  const fresh = rows.filter(isNew);
  const drs = rows.map(r => r.apiDr).filter((d): d is number => typeof d === "number" && d > 0);
  const topNew = fresh
    .sort((a, b) => (b.apiDr ?? 0) - (a.apiDr ?? 0))
    .slice(0, 10)
    .map(r => ({ urlFrom: r.urlFrom, domainFrom: r.domainFrom ?? "", dr: r.apiDr ?? null, anchor: r.apiAnchor ?? "" }));
  return {
    newCount: fresh.length,
    lostCount: rows.filter(r => r.apiLost).length,
    avgDr: drs.length ? Math.round(drs.reduce((s, d) => s + d, 0) / drs.length * 10) / 10 : null,
    topNew,
  };
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
  window: { from: string; to: string; days: number; prevFrom: string; prevTo: string };
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
    },
  };
  // Independent collectors; one failing section must not take the report down.
  const jobs: Promise<void>[] = [];
  const run = (p: Promise<unknown>, set: (v: unknown) => void) =>
    jobs.push(p.then(set).catch(e => console.warn("[reports] section collector failed:", e)));
  if (has("traffic")) run(collectTraffic(siteId, w), v => { data.traffic = v as TrafficData; });
  if (has("queries")) run(collectQueries(siteId, w), v => { data.queries = v as RowsData; });
  if (has("pages")) run(collectPages(siteId, w), v => { data.pages = v as RowsData; });
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
