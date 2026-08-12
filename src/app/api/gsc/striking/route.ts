import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

// GET /api/gsc/striking?siteId=&posFrom=4&posTo=20&days=90&minImpressions=10&limit=100
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
  const siteId      = searchParams.get('siteId') ?? '';
  const posFrom     = Math.max(1,   parseFloat(searchParams.get('posFrom') ?? '4'));
  const posTo       = Math.min(100, parseFloat(searchParams.get('posTo')   ?? '20'));
  const days        = Math.min(365, parseInt(searchParams.get('days')       ?? '90'));
  const minImpr     = parseInt(searchParams.get('minImpressions') ?? '10');
  const limit       = Math.min(500, parseInt(searchParams.get('limit')      ?? '100'));

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

  // Aggregate (query, url) pairs within position band
  type StrikingRow = { siteId: string; url: string; query: string; _sum: { clicks: number | null; impressions: number | null }; _avg: { ctr: number | null; position: number | null } };
  const rawRows = await prisma.dailyMetric.groupBy({
    by: ['siteId', 'query', 'url'],
    where: {
      siteId: { in: siteIds },
      date:     { gte: since },
      position: { gte: posFrom, lte: posTo },
    },
    _sum: { clicks: true, impressions: true },
    _avg: { ctr: true, position: true },
    having: { impressions: { _sum: { gte: minImpr } } },
    orderBy: { _sum: { impressions: 'desc' } },
    take: limit,
  });

  const rows: StrikingRow[] = (rawRows as unknown as StrikingRow[]).filter(r => r.url !== '' && r.query !== '');

  const keywords = rows.map(r => {
    const site = siteMap.get(r.siteId);
    const domain = site ? site.url.replace("sc-domain:", "").replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
    return {
      query:       r.query,
      page:        r.url.replace(/^https?:\/\/[^/]+/, '') || '/',
      fullUrl:     r.url,
      siteId:      r.siteId,
      siteName:    domain,
      impressions: r._sum.impressions ?? 0,
      clicks:      r._sum.clicks ?? 0,
      ctr:         Math.round((r._avg.ctr ?? 0) * 1000) / 10,
      position:    Math.round((r._avg.position ?? 0) * 10) / 10,
    };
  });

  return NextResponse.json({ keywords, total: keywords.length });
}
