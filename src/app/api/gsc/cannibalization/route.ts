import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { buildRelatedIntentGroups, siteBrandTerms } from '@/lib/cannibalization/relatedIntent';

// Extract brand terms from site URL for non-brand filtering
function brandTerms(siteUrl: string): string[] {
  const clean = siteUrl
    .replace(/^https?:\/\//, '')
    .replace(/^sc-domain:/, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('.')[0];
  return [clean.toLowerCase()];
}

// GET /api/gsc/cannibalization?siteId=&days=90&minImpressions=30&limit=60
export async function GET(req: Request) {
  let userId = await workspaceUserId();
  if (!userId) {
    // Guest access via a share link: the token must match the requested site (never 'all').
    const sp = new URL(req.url).searchParams;
    const shareToken = sp.get('shareToken') ?? '';
    const sharedSiteId = sp.get('siteId') ?? '';
    if (shareToken && sharedSiteId && sharedSiteId !== 'all') {
      const shared = await prisma.site.findFirst({ where: { id: sharedSiteId, shareToken, shareEnabled: true } });
      if (shared) userId = shared.userId;
    }
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const siteId  = searchParams.get('siteId') ?? '';
  const days    = Math.min(parseInt(searchParams.get('days') ?? '90'), 365);
  const minImpr = parseInt(searchParams.get('minImpressions') ?? '30');
  const limit   = Math.min(parseInt(searchParams.get('limit') ?? '60'), 200);
  const mode    = searchParams.get('mode') === 'related' ? 'related' : 'exact';

  let siteIds: string[];
  let siteMap: Map<string, any>;

  if (siteId === 'all' || !siteId) {
    const sites = await prisma.site.findMany({ where: { userId } });
    siteIds = sites.map(s => s.id);
    siteMap = new Map(sites.map(s => [s.id, s]));
  } else {
    const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
    if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    siteIds = [site.id];
    siteMap = new Map([[site.id, site]]);
  }

  const since = new Date();
  since.setDate(since.getDate() - days);

  // Additive second mode: the default exact-query response below remains byte-for-byte the same
  // shape for existing UI/MCP consumers. Related Intent uses only already-synced GSC rows and a
  // deterministic candidate index — no LLM, live SERP call or paid provider.
  if (mode === 'related') {
    const dailyRows = await prisma.dailyMetric.findMany({
      where: { siteId: { in: siteIds }, date: { gte: since }, query: { not: '' }, url: { not: '' } },
      select: { siteId: true, query: true, url: true, date: true, clicks: true, impressions: true, ctr: true, position: true },
      orderBy: { impressions: 'desc' },
      take: 30_000,
    });
    const rowsBySite = new Map<string, typeof dailyRows>();
    for (const row of dailyRows) {
      const rows = rowsBySite.get(row.siteId) ?? [];
      rows.push(row);
      rowsBySite.set(row.siteId, rows);
    }
    const groups = siteIds.flatMap(currentSiteId => {
      const site = siteMap.get(currentSiteId);
      if (!site) return [];
      const siteName = site.url.replace('sc-domain:', '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      return buildRelatedIntentGroups(
        rowsBySite.get(currentSiteId) ?? [],
        { siteId: currentSiteId, siteName, brandTerms: siteBrandTerms(site.siteId), minImpressions: minImpr, limit },
      );
    }).sort((left, right) => right.confidence - left.confidence || right.totalImpressions - left.totalImpressions).slice(0, limit);

    return NextResponse.json({
      mode: 'related',
      groups,
      brand: siteIds.length === 1 ? brandTerms(siteMap.values().next().value.siteId) : [],
      methodology: { deterministic: true, paidCalls: 0, candidateIndex: ['query_tokens', 'ranking_urls'], autoActions: false },
      truncated: dailyRows.length === 30_000,
    });
  }

  // ── Aggregate (query, url) pairs ───────────────────────────────────────────────
  type AggRow = { siteId: string; url: string; query: string; _sum: { clicks: number | null; impressions: number | null }; _avg: { ctr: number | null; position: number | null } };
  const aggsRaw = await prisma.dailyMetric.groupBy({
    by: ['siteId', 'query', 'url'],
    where: { siteId: { in: siteIds }, date: { gte: since } },
    _sum: { clicks: true, impressions: true },
    _avg: { ctr: true, position: true },
    orderBy: { _sum: { impressions: 'desc' } },
    take: 10000,
  });
  // Exclude site-level aggregate rows (url='' or query='') that have no per-URL meaning
  const aggs: AggRow[] = (aggsRaw as unknown as AggRow[]).filter(a => a.url !== '' && a.query !== '');

  // ── Build siteId + URL → top query map ──
  const urlBest = new Map<string, { query: string; impr: number }>();
  for (const a of aggs) {
    const key = `${a.siteId}::${a.url}`;
    const impr = a._sum.impressions ?? 0;
    const cur  = urlBest.get(key);
    if (!cur || impr > cur.impr) urlBest.set(key, { query: a.query, impr });
  }

  // ── Group by siteId + query ─────────────────────────────────────────────────────────────
  const queryMap = new Map<string, typeof aggs>();
  for (const a of aggs) {
    const key = `${a.siteId}::${a.query}`;
    if (!queryMap.has(key)) queryMap.set(key, []);
    queryMap.get(key)!.push(a);
  }

  // ── Build cannibalization groups ───────────────────────────────────────────────
  const groups: {
    query: string;
    siteId: string;
    siteName: string;
    pages: {
      url: string; fullUrl: string; topQuery: string;
      impressions: number; clicks: number; ctr: number; position: number;
    }[];
    isTrue: boolean;
  }[] = [];

  for (const [key, entries] of queryMap) {
    const [grpSiteId, query] = key.split('::');
    const grpSite = siteMap.get(grpSiteId);
    if (!grpSite) continue;

    const brand = brandTerms(grpSite.siteId);

    // Skip branded queries
    if (brand.some(b => query.toLowerCase().includes(b))) continue;

    // Need 2+ distinct URLs
    const uniqueUrls = [...new Set(entries.map(e => e.url))];
    if (uniqueUrls.length < 2) continue;

    // Aggregate per URL (sum across dates already done by groupBy)
    const perUrl = uniqueUrls.map(url => {
      const row = entries.find(e => e.url === url)!;
      return {
        url,
        impressions: row._sum.impressions ?? 0,
        clicks:      row._sum.clicks ?? 0,
        ctr:         Math.round((row._avg.ctr ?? 0) * 1000) / 10,
        position:    Math.round((row._avg.position ?? 0) * 10) / 10,
      };
    }).sort((a, b) => b.impressions - a.impressions);

    const totalImpr = perUrl.reduce((s, p) => s + p.impressions, 0);
    if (totalImpr < minImpressions(minImpr)) continue;

    // Filter: remove pages with <10% share of query impressions
    const significant = perUrl.filter(p => (p.impressions / totalImpr) >= 0.10);
    if (significant.length < 2) continue;

    // Filter: if position gap between top-2 > 20, not really competing
    const pos1 = significant[0].position;
    const pos2 = significant[1].position;
    if (Math.abs(pos2 - pos1) > 20) continue;

    // Build result pages
    const pages = significant.map(p => ({
      url:         p.url.replace(/^https?:\/\/[^/]+/, '') || '/',
      fullUrl:     p.url,
      topQuery:    urlBest.get(`${grpSiteId}::${p.url}`)?.query ?? query,
      impressions: p.impressions,
      clicks:      p.clicks,
      ctr:         p.ctr,
      position:    p.position,
    }));

    // True cannibalization: top queries overlap with group query keywords
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const topQueries = pages.map(p => p.topQuery.toLowerCase());
    const sameTopQuery = new Set(topQueries).size < topQueries.length;
    const overlapping  = queryWords.length > 0 && topQueries.filter(tq =>
      queryWords.some(w => tq.includes(w))
    ).length >= 2;
    const isTrue = sameTopQuery || overlapping;

    const domain = grpSite.url.replace("sc-domain:", "").replace(/^https?:\/\//, "").replace(/\/$/, "");

    groups.push({ query, siteId: grpSiteId, siteName: domain, pages, isTrue });
  }

  // Sort by total impressions desc, limit
  const result = groups
    .sort((a, b) =>
      b.pages.reduce((s, p) => s + p.impressions, 0) -
      a.pages.reduce((s, p) => s + p.impressions, 0)
    )
    .slice(0, limit);

  return NextResponse.json({ groups: result, brand: siteIds.length === 1 ? brandTerms(siteMap.values().next().value.siteId) : [] });
}

function minImpressions(n: number) { return n; }
