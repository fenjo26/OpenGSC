// Exact cannibalization across one site or a portfolio — the database half.
// Rules: ./exact.ts (pure, tested). Shared helpers: @/lib/gsc/reportScope.

import { prisma } from "@/lib/prisma";
import { chunk, newestWindow, queryPageWindows, siteDisplayName, type SummaryWindow } from "@/lib/gsc/reportData";
import { peekReportCache, putReportCache, reportCacheVersion } from "@/lib/gsc/reportCache";
import { parseSiteTags } from "@/lib/decay/logic";
import { brandTermsOf, buildExactGroups, type CannibalGroup, type QueryPageRow } from "./exact";
import { normalizePageUrl } from "@/lib/url-normalize";

export interface CannibalSite { id: string; url: string; siteId: string; tags?: string | null }

export interface CannibalSiteSummary {
  siteId: string; siteName: string; tags: string[];
  groups: number; trueGroups: number; impressions: number;
}

export interface CannibalResult {
  groups: CannibalGroup[];
  total: number;
  truncated: boolean;
  window: SummaryWindow | null;
  mixedWindows: boolean;
  sites: CannibalSiteSummary[];
}

/**
 * Sites per database read. Unlike striking (in-band rows only), cannibalization needs every
 * query+page row of a site, so reads stay small and each site's rows are dropped once grouped.
 */
const SITE_CHUNK = 20;

async function readRows(batch: CannibalSite[]): Promise<Map<string, QueryPageRow[]>> {
  const rows = await prisma.dailyMetric.findMany({
    where: { siteId: { in: batch.map(s => s.id) }, url: { not: "" }, query: { not: "" }, impressions: { gt: 0 } },
    select: { siteId: true, query: true, url: true, clicks: true, impressions: true, ctr: true, position: true },
  });
  const hostById = new Map(batch.map(s => [s.id, s.url]));
  const out = new Map<string, QueryPageRow[]>();
  for (const r of rows) {
    const list = out.get(r.siteId);
    const norm = { ...r, url: normalizePageUrl(r.url, hostById.get(r.siteId)) };
    if (list) list.push(norm); else out.set(r.siteId, [norm]);
  }
  return out;
}

export async function findCannibalization(
  sites: CannibalSite[],
  opts: { minImpressions: number; limit: number; onlySites?: ReadonlySet<string> | null },
): Promise<CannibalResult> {
  const only = opts.onlySites && opts.onlySites.size ? opts.onlySites : null;
  const windows = await queryPageWindows(sites.map(s => s.id));
  const perSite = new Map<string, CannibalGroup[]>();

  // Cache hits first; whatever is left is read in small batches.
  const keyOf = (s: CannibalSite) => `cannibal\n${s.id}\n${windows.get(s.id)?.end ?? "-"}\n${opts.minImpressions}`;
  const version = reportCacheVersion();
  const missing: CannibalSite[] = [];
  for (const s of sites) {
    if (!windows.has(s.id)) { perSite.set(s.id, []); continue; }
    const hit = peekReportCache<CannibalGroup[]>(keyOf(s));
    if (hit) perSite.set(s.id, hit); else missing.push(s);
  }
  for (const batch of chunk(missing, SITE_CHUNK)) {
    const rowsBySite = await readRows(batch);
    for (const s of batch) {
      const groups = buildExactGroups(rowsBySite.get(s.id) ?? [], {
        siteId: s.id, siteName: siteDisplayName(s.url), brand: brandTermsOf(s.siteId || s.url), minImpressions: opts.minImpressions,
      });
      perSite.set(s.id, groups);
      putReportCache(keyOf(s), groups, version);
    }
  }

  const summaries: CannibalSiteSummary[] = [];
  const all: CannibalGroup[] = [];
  for (const s of sites) {
    const groups = perSite.get(s.id) ?? [];
    summaries.push({
      siteId: s.id, siteName: siteDisplayName(s.url), tags: parseSiteTags(s.tags),
      groups: groups.length, trueGroups: groups.filter(g => g.isTrue).length,
      impressions: groups.reduce((n, g) => n + g.impressions, 0),
    });
    if (!only || only.has(s.id)) all.push(...groups);
  }

  all.sort((a, b) => b.impressions - a.impressions);
  const { window, mixed } = newestWindow(windows, only ? [...only] : sites.map(s => s.id));
  const limit = Math.max(1, opts.limit);
  return {
    groups: all.slice(0, limit),
    total: all.length,
    truncated: all.length > limit,
    window,
    mixedWindows: mixed,
    sites: summaries.sort((a, b) => b.impressions - a.impressions || a.siteName.localeCompare(b.siteName)),
  };
}
