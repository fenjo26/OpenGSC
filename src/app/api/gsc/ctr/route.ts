import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

// Industry-standard CTR benchmarks per position (Backlinko 2023)
const BENCHMARKS: Record<number, number> = {
  1: 27.6, 2: 15.8, 3: 11.0, 4: 8.4, 5: 6.3,
  6: 4.9,  7: 3.9,  8: 3.3,  9: 2.7, 10: 2.4,
};

// GET /api/gsc/ctr?siteId=&days=90&minImpressions=10&limit=200
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
  const days    = Math.min(365, parseInt(searchParams.get('days') ?? '90'));
  const minImpr = parseInt(searchParams.get('minImpressions') ?? '10');
  const limit   = Math.min(500, parseInt(searchParams.get('limit') ?? '200'));

  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const since = new Date();
  since.setDate(since.getDate() - days);

  // Only top-10 positions where CTR comparison makes sense
  type CtrRow = { url: string; query: string; _sum: { clicks: number | null; impressions: number | null }; _avg: { ctr: number | null; position: number | null } };
  const rawRows = await prisma.dailyMetric.groupBy({
    by: ['query', 'url'],
    where: {
      siteId,
      date:     { gte: since },
      position: { gte: 1, lte: 10 },
    },
    _sum:  { clicks: true, impressions: true },
    _avg:  { ctr: true, position: true },
    having: { impressions: { _sum: { gte: minImpr } } },
    orderBy: { _sum: { impressions: 'desc' } },
    take: limit,
  });

  const rows: CtrRow[] = (rawRows as unknown as CtrRow[]).filter(r => r.url !== '' && r.query !== '');

  const keywords = rows.map(r => {
    const position   = Math.round((r._avg.position ?? 1) * 10) / 10;
    const actualCtr  = Math.round((r._avg.ctr ?? 0) * 1000) / 10; // as %
    const posRounded = Math.max(1, Math.min(10, Math.round(position)));
    const expectedCtr = BENCHMARKS[posRounded] ?? 0;
    const diff = Math.round((actualCtr - expectedCtr) * 10) / 10;

    return {
      query:       r.query,
      page:        r.url.replace(/^https?:\/\/[^/]+/, '') || '/',
      fullUrl:     r.url,
      impressions: r._sum.impressions ?? 0,
      clicks:      r._sum.clicks ?? 0,
      position,
      actualCtr,
      expectedCtr,
      diff,
    };
  });

  return NextResponse.json({ keywords, total: keywords.length });
}
