// Striking distance — the database half, shared by /api/gsc/striking (and usable by MCP).
//
// What changed (with #28's follow-up):
//  • Only query+page rows are read (url<>'' AND query<>''). The old groupBy let the site rollup
//    and per-day page rows into its `take`, then threw them away — on a portfolio they could take
//    most of the slots.
//  • Each site contributes all of its rows. One `take` across the portfolio let the biggest
//    sites fill it and left small ones out entirely.
//  • No fake period: these rows are one 90-day total per pair (gscSync Step 4), so the window is
//    reported from the rows instead of offered as a choice that changed nothing.

import { prisma } from "@/lib/prisma";
import { chunk, newestWindow, queryPageWindows, siteDisplayName, type SummaryWindow } from "@/lib/gsc/reportData";
import { parseSiteTags } from "@/lib/decay/logic";
import { estimatedGain } from "./logic";
import { normalizePageUrl } from "@/lib/url-normalize";

export interface StrikingSite { id: string; url: string; tags?: string | null }

export interface StrikingRow {
  siteId: string; siteName: string;
  query: string; page: string; fullUrl: string;
  impressions: number; clicks: number; ctr: number; position: number;
  /** Extra clicks at position 3 with today's impressions (see logic.estimatedGain). */
  gain: number;
}

export interface StrikingSiteSummary {
  siteId: string; siteName: string; tags: string[];
  keywords: number; impressions: number; gain: number;
}

export interface StrikingResult {
  rows: StrikingRow[];
  total: number;
  truncated: boolean;
  window: SummaryWindow | null;
  mixedWindows: boolean;
  /** Every site, unfiltered by the selection — for the picker. */
  sites: StrikingSiteSummary[];
}

export interface StrikingOptions {
  posFrom: number;
  posTo: number;
  minImpressions: number;
  limit: number;
  onlySites?: ReadonlySet<string> | null;
}

/** Sites per query. Each returns only the in-band rows, so this stays small. */
const SITE_CHUNK = 200;

export async function findStriking(sites: StrikingSite[], opts: StrikingOptions): Promise<StrikingResult> {
  const siteById = new Map(sites.map(s => [s.id, s]));
  const summary = new Map<string, StrikingSiteSummary>(sites.map(s => [s.id, {
    siteId: s.id, siteName: siteDisplayName(s.url), tags: parseSiteTags(s.tags), keywords: 0, impressions: 0, gain: 0,
  }]));
  const only = opts.onlySites && opts.onlySites.size ? opts.onlySites : null;
  const rows: StrikingRow[] = [];
  const rowsByKey = new Map<string, StrikingRow>();

  for (const ids of chunk(sites.map(s => s.id), SITE_CHUNK)) {
    const found = await prisma.dailyMetric.findMany({
      where: {
        siteId: { in: ids },
        url: { not: "" },
        query: { not: "" },
        position: { gte: opts.posFrom, lte: opts.posTo },
        impressions: { gte: Math.max(1, opts.minImpressions) },
      },
      select: { siteId: true, query: true, url: true, clicks: true, impressions: true, ctr: true, position: true },
    });
    for (const r of found) {
      const sum = summary.get(r.siteId);
      if (!sum) continue;
      const gain = estimatedGain(r.impressions, r.clicks);
      sum.keywords++; sum.impressions += r.impressions; sum.gain += gain;
      if (only && !only.has(r.siteId)) continue;
      const url = normalizePageUrl(r.url);
      // www and apex variants of the same page fold into ONE keyword row.
      const key = `${r.siteId}\n${r.query}\n${url}`;
      const prev = rowsByKey.get(key);
      if (prev) {
        prev.impressions += r.impressions;
        prev.clicks += r.clicks;
        prev.position = prev.impressions
          ? (prev.position * (prev.impressions - r.impressions) + r.position * r.impressions) / prev.impressions
          : r.position;
        prev.gain = estimatedGain(prev.impressions, prev.clicks);
        continue;
      }
      rowsByKey.set(key, {
        siteId: r.siteId,
        siteName: sum.siteName,
        query: r.query,
        page: url.replace(/^https?:\/\/[^/]+/i, "") || "/",
        fullUrl: url,
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: Math.round((r.impressions ? r.clicks / r.impressions : 0) * 1000) / 10,
        position: Math.round(r.position * 10) / 10,
        gain,
      });
    }
  }

  rows.push(...rowsByKey.values());
  rows.sort((a, b) => b.gain - a.gain || b.impressions - a.impressions);
  const windows = await queryPageWindows(sites.map(s => s.id));
  const { window, mixed } = newestWindow(windows, only ? [...only].filter(id => siteById.has(id)) : siteById.keys());
  const limit = Math.max(1, opts.limit);
  return {
    rows: rows.slice(0, limit),
    total: rows.length,
    truncated: rows.length > limit,
    window,
    mixedWindows: mixed,
    sites: [...summary.values()].sort((a, b) => b.gain - a.gain || a.siteName.localeCompare(b.siteName)),
  };
}
