// T4 — the read/write surface behind /api/indexing/auto and the get_index_coverage MCP tool
// (docs/tasks/wave-oct/T4-index-autocheck.md): the site's settings, today's quota, the priority
// queue counts, the 90-day coverage series, why-not-indexed reasons and recent losses.

import { prisma } from "@/lib/prisma";
import { classifyPriority, statusIndexed, utcDayStart } from "./queue";
import { quotaToday } from "./quota";
import { parseIndexInspect } from "./inspect";
import { INSPECTION_DAILY_LIMIT, type IndexAutoStatus, type IndexInspectSettings, type InspectPriority } from "./types";

const QUEUE_SELECT = {
  url: true, firstSeenAt: true, googleChecked: true, googleNextCheck: true,
  googleStatus: true, changeStatus: true, inventoryStatus: true, lastSeenAt: true,
} as const;

/**
 * Priority-queue counts and the current not-indexed reason breakdown, from one pass over the
 * site's active sitemap rows. Reuses the queue's own classifier so the numbers the panel shows
 * are exactly the numbers the scheduler acts on.
 */
export async function queueSnapshot(siteDbId: string): Promise<{
  queue: Record<InspectPriority, number>;
  reasons: { coverageState: string; count: number }[];
}> {
  const now = new Date();
  const rows = await prisma.sitemapUrl.findMany({
    where: { siteId: siteDbId, inventoryStatus: "active" },
    select: QUEUE_SELECT,
  });
  const queue: Record<InspectPriority, number> = { new: 0, changed: 0, not_indexed: 0, stale_indexed: 0 };
  const reasonCounts = new Map<string, number>();
  for (const row of rows) {
    const p = classifyPriority(row, now);
    if (p) queue[p]++;
    if (statusIndexed(row.googleStatus) === false) {
      const reason = row.googleStatus ?? "unknown";
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }
  const reasons = [...reasonCounts.entries()]
    .map(([coverageState, count]) => ({ coverageState, count }))
    .sort((a, b) => b.count - a.count || a.coverageState.localeCompare(b.coverageState));
  return { queue, reasons };
}

export interface IndexLoss {
  url: string;
  lostAt: Date;
  coverageState: string | null;
  clicks28d: number;
}

/**
 * URLs that dropped out of the index inside the last `days` UTC days: the latest known state
 * is a not-indexed one, and the state right before it (found in PageInspectionHistory) was
 * indexed. A first-ever inspection that comes back "not indexed" is not a loss — nothing was
 * ever known to be indexed. Losses are rare (a handful a day at most), so the per-URL
 * previous-row lookup is one indexed query each.
 */
export async function collectLosses(siteDbId: string, days: number, limit: number): Promise<IndexLoss[]> {
  const since = utcDayStart(new Date(Date.now() - (days - 1) * 86_400_000));
  const rows = await prisma.pageInspectionHistory.findMany({
    where: { siteId: siteDbId, date: { gte: since } },
    orderBy: { date: "asc" },
    select: { url: true, status: true, date: true },
  });

  // Latest row per URL inside the window.
  const latest = new Map<string, { status: string; date: Date }>();
  for (const r of rows) latest.set(r.url, { status: r.status, date: r.date });

  const losses: IndexLoss[] = [];
  for (const [url, last] of latest) {
    if (statusIndexed(last.status) !== false) continue;
    const prev = await prisma.pageInspectionHistory.findFirst({
      where: { siteId: siteDbId, url, date: { lt: last.date } },
      orderBy: { date: "desc" },
      select: { status: true },
    });
    if (!prev || statusIndexed(prev.status) !== true) continue;
    losses.push({ url, lostAt: last.date, coverageState: last.status, clicks28d: 0 });
    if (losses.length >= Math.min(limit, 200)) break;
  }
  if (!losses.length) return losses;

  // 28-day clicks per lost URL (any query, web search type) — the alert fires only for pages
  // that were actually getting traffic. One grouped query instead of one per URL.
  const since28 = new Date(Date.now() - 28 * 86_400_000);
  const clicks = await prisma.dailyMetric.groupBy({
    by: ["url"],
    where: { siteId: siteDbId, url: { in: losses.map(l => l.url) }, searchType: "web", date: { gte: since28 } },
    _sum: { clicks: true },
  });
  const byUrl = new Map(clicks.map(c => [c.url, c._sum.clicks ?? 0]));
  for (const loss of losses) loss.clicks28d = byUrl.get(loss.url) ?? 0;

  return losses.sort((a, b) => b.clicks28d - a.clicks28d || b.lostAt.getTime() - a.lostAt.getTime());
}

/** The panel/MCP status document. Null when the site isn't the user's. */
export async function indexAutoStatus(userId: string, siteDbId: string): Promise<IndexAutoStatus | null> {
  const site = await prisma.site.findFirst({
    where: { id: siteDbId, userId },
    select: { siteId: true, indexInspect: true },
  });
  if (!site) return null;

  const settings = parseIndexInspect(site.indexInspect);
  const quota = await quotaToday(site.siteId);
  const { queue, reasons } = await queueSnapshot(siteDbId);

  const coverageRows = await prisma.indexCoverageDaily.findMany({
    where: { siteId: siteDbId },
    orderBy: { day: "desc" },
    take: 90,
  });
  const coverage = coverageRows
    .map(r => ({ day: r.day, total: r.total, indexed: r.indexed, notIndexed: r.notIndexed, unknown: r.unknown }))
    .reverse(); // oldest → newest, chart-ready

  const recentLosses = (await collectLosses(siteDbId, 7, 20))
    .filter(l => l.clicks28d > 0)
    .map(l => ({ url: l.url, lostAt: l.lostAt.toISOString(), coverageState: l.coverageState, clicks28d: l.clicks28d }));

  return {
    settings,
    property: site.siteId,
    quota: { day: quota.day, used: quota.used, auto: quota.auto, limit: INSPECTION_DAILY_LIMIT, exhausted: quota.exhausted },
    queue,
    coverage,
    reasons,
    recentLosses,
  };
}

/** Save the settings (clamped by parseIndexInspect) onto the site. */
export async function saveIndexInspect(userId: string, siteDbId: string, s: IndexInspectSettings): Promise<void> {
  const cleaned = parseIndexInspect(JSON.stringify(s));
  await prisma.site.updateMany({ where: { id: siteDbId, userId }, data: { indexInspect: JSON.stringify(cleaned) } });
}
