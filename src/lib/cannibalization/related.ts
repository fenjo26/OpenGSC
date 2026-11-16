// Related-intent cannibalization across one site or a portfolio — the database half.
// Rules: ./relatedIntent.ts (pure, tested).
//
// Per site: the 90-day query+page totals (DailyMetric) for volumes, and — when the instance has
// synced them — the per-day rows (QueryPageDaily) for the "winner changes" signal. Results are
// cached per site until the next sync, and a summary over every site feeds the portfolio picker.

import { prisma } from "@/lib/prisma";
import { newestWindow, queryPageWindows, siteDisplayName, type SummaryWindow } from "@/lib/gsc/reportData";
import { peekReportCache, putReportCache, reportCacheVersion } from "@/lib/gsc/reportCache";
import { parseSiteTags } from "@/lib/decay/logic";
import { buildRelatedIntentGroups, siteBrandTerms, type RelatedIntentGroup } from "./relatedIntent";
import { normalizePageUrl } from "@/lib/url-normalize";

/** Summary rows read per site (highest impressions first). */
export const RELATED_ROWS_PER_SITE = 30_000;
/** Per-day rows read per site — enough for every flip on the queries that matter. */
const DAILY_ROWS_PER_SITE = 200_000;

export interface RelatedSite { id: string; url: string; siteId: string; tags?: string | null }

export interface RelatedSiteSummary {
  siteId: string; siteName: string; tags: string[];
  groups: number; highGroups: number; impressions: number;
}

export interface DailyWindow { start: string; end: string; days: number }

export interface RelatedResult {
  groups: RelatedIntentGroup[];
  total: number;
  /** Some site had more summary rows than RELATED_ROWS_PER_SITE. */
  truncated: boolean;
  window: SummaryWindow | null;
  mixedWindows: boolean;
  /** Per-day data behind "winner changes"; null = not synced yet on this instance. */
  dailyWindow: DailyWindow | null;
  sites: RelatedSiteSummary[];
}

interface PerSite { groups: RelatedIntentGroup[]; truncated: boolean; daily: DailyWindow | null }

async function readDaily(siteId: string) {
  try {
    return await prisma.queryPageDaily.findMany({
      where: { siteId },
      select: { query: true, url: true, date: true, clicks: true, impressions: true, position: true },
      orderBy: { impressions: "desc" },
      take: DAILY_ROWS_PER_SITE,
    });
  } catch {
    // Table not created yet (`prisma db push` not run since the update): the signal is simply
    // unavailable, the rest of the report is unaffected.
    return null;
  }
}

async function computeSite(site: RelatedSite, minImpressions: number, limit: number): Promise<PerSite> {
  const rows = await prisma.dailyMetric.findMany({
    where: { siteId: site.id, query: { not: "" }, url: { not: "" } },
    select: { query: true, url: true, date: true, clicks: true, impressions: true, ctr: true, position: true },
    orderBy: { impressions: "desc" },
    take: RELATED_ROWS_PER_SITE,
  });
  const dailyRows = await readDaily(site.id);
  let daily: DailyWindow | null = null;
  if (dailyRows && dailyRows.length) {
    let min = Infinity, max = -Infinity;
    for (const r of dailyRows) { const t = r.date.getTime(); if (t < min) min = t; if (t > max) max = t; }
    daily = {
      start: new Date(min).toISOString().slice(0, 10),
      end: new Date(max).toISOString().slice(0, 10),
      days: Math.round((max - min) / 86_400_000) + 1,
    };
  }
  const groups = buildRelatedIntentGroups(rows.map(r => ({ ...r, url: normalizePageUrl(r.url, site.url) })), {
    siteId: site.id, siteName: siteDisplayName(site.url), brandTerms: siteBrandTerms(site.siteId),
    minImpressions, limit,
    ...(dailyRows && dailyRows.length ? { daily: dailyRows.map(r => ({ ...r, url: normalizePageUrl(r.url, site.url), ctr: r.impressions ? r.clicks / r.impressions : 0 })) } : {}),
  });
  return { groups, truncated: rows.length === RELATED_ROWS_PER_SITE, daily };
}

export async function findRelatedIntent(
  sites: RelatedSite[],
  opts: { minImpressions: number; limit: number; onlySites?: ReadonlySet<string> | null },
): Promise<RelatedResult> {
  const only = opts.onlySites && opts.onlySites.size ? opts.onlySites : null;
  const windows = await queryPageWindows(sites.map(s => s.id));
  const version = reportCacheVersion();
  const perSite = new Map<string, PerSite>();

  // One site at a time: each site gets its own row budget and its rows are dropped as soon as
  // its groups exist. Cached until the next sync, so a large portfolio is computed once.
  for (const s of sites) {
    if (!windows.has(s.id)) continue;
    const key = `related\n${s.id}\n${windows.get(s.id)!.end}\n${opts.minImpressions}\n${opts.limit}`;
    let v = peekReportCache<PerSite>(key);
    if (!v) {
      v = await computeSite(s, opts.minImpressions, opts.limit);
      putReportCache(key, v, version);
    }
    perSite.set(s.id, v);
  }

  const summaries: RelatedSiteSummary[] = [];
  const all: RelatedIntentGroup[] = [];
  let truncated = false;
  let dailyWindow: DailyWindow | null = null;
  for (const s of sites) {
    const v = perSite.get(s.id);
    const groups = v?.groups ?? [];
    summaries.push({
      siteId: s.id, siteName: siteDisplayName(s.url), tags: parseSiteTags(s.tags),
      groups: groups.length, highGroups: groups.filter(g => g.confidenceLevel === "high").length,
      impressions: groups.reduce((n, g) => n + g.totalImpressions, 0),
    });
    if (only && !only.has(s.id)) continue;
    all.push(...groups);
    if (v?.truncated) truncated = true;
    if (v?.daily && (!dailyWindow || v.daily.end > dailyWindow.end)) dailyWindow = v.daily;
  }

  all.sort((l, r) => r.confidence - l.confidence || r.totalImpressions - l.totalImpressions);
  const { window, mixed } = newestWindow(windows, only ? [...only] : sites.map(s => s.id));
  const limit = Math.max(1, opts.limit);
  return {
    groups: all.slice(0, limit),
    total: all.length,
    truncated,
    window,
    mixedWindows: mixed,
    dailyWindow,
    sites: summaries.sort((a, b) => b.impressions - a.impressions || a.siteName.localeCompare(b.siteName)),
  };
}
