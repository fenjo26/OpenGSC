import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { getUserGoogleAccounts, queryGsc, isoDaysAgo } from '@/lib/gscQuery';

// Position decay scatter — each query's rank in the previous 30 days against the last 30 days.
//
// WHY THIS READS FROM SEARCH CONSOLE INSTEAD OF THE LOCAL STORE. It used to compare two date ranges
// of DailyMetric, which could never return anything. Query-level rows are written by the sync's
// step 4 with `dimensions: ['query', 'page']` and NO date dimension — a single 90-day aggregate
// stamped with the sync date (gscSync.ts says so in a comment). Every query row therefore carries
// the same date, so the "30 to 60 days ago" window matched zero rows, the previous-period map came
// back empty, every point was filtered out, and the chart reported "no sufficient search queries"
// on every site, forever. The empty state was not a data problem; the comparison was impossible.
//
// Changing the sync to store per-date query rows would multiply its row count and disturb the
// summary model Cannibalization and Striking Distance are built on. Asking Search Console for the
// two windows directly is exact, costs quota rather than storage, and leaves that model alone.

// Search Console data lags a couple of days; ending the window at today would compare a complete
// period against a partial one and manufacture a decline that never happened.
const LAG_DAYS = 3;
const WINDOW = 30;
const MIN_IMPRESSIONS = 10;

// Two live calls per site, so repeat opens are served from memory. Search Console publishes at most
// once a day and both windows are 30 days wide, so a 15-minute cache costs no accuracy at all.
// `?refresh=1` bypasses it. Single process, single map — same approach as the indexer stats route.
const CACHE_TTL_MS = 15 * 60_000;
const cache = new Map<string, { at: number; payload: unknown }>();

// 'all' fans out across sites; a small pool keeps a portfolio view from turning into a long
// sequential chain of round trips without hammering the API either.
const POOL = 4;

async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

type Row = { keys?: string[] | null; impressions?: number | null; clicks?: number | null; position?: number | null };

export async function GET(req: Request) {
  let userId = await workspaceUserId();
  const { searchParams } = new URL(req.url);

  if (!userId) {
    // Guest access via a share link: the token must match the requested site (never 'all').
    const shareToken = searchParams.get('shareToken') ?? '';
    const sharedSiteId = searchParams.get('siteId') ?? '';
    if (shareToken && sharedSiteId && sharedSiteId !== 'all') {
      const shared = await prisma.site.findFirst({ where: { id: sharedSiteId, shareToken, shareEnabled: true } });
      if (shared) userId = shared.userId;
    }
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const siteId = searchParams.get('siteId') ?? '';
  if (!siteId) return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });

  const cacheKey = `${userId}:${siteId}`;
  const hit = cache.get(cacheKey);
  if (searchParams.get('refresh') !== '1' && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json(hit.payload);
  }

  // 'all' is capped: this makes two live API calls per site, and an unbounded portfolio would
  // turn one chart into a hundred round trips.
  const sites = siteId === 'all'
    ? await prisma.site.findMany({ where: { userId }, select: { siteId: true }, take: 10 })
    : await prisma.site.findMany({ where: { id: siteId, userId }, select: { siteId: true } });
  if (!sites.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const accounts = await getUserGoogleAccounts(userId);
  if (!accounts.length) return NextResponse.json({ points: [], reason: 'no_google_account' });

  const currStart = isoDaysAgo(LAG_DAYS + WINDOW);
  const currEnd = isoDaysAgo(LAG_DAYS);
  const prevStart = isoDaysAgo(LAG_DAYS + WINDOW * 2);
  const prevEnd = isoDaysAgo(LAG_DAYS + WINDOW + 1);

  try {
    const points: {
      query: string; clicks: number; impressions: number; prevPos: number; currPos: number; delta: number;
    }[] = [];

    await pooled(sites, POOL, async s => {
      const [curr, prev] = await Promise.all([
        queryGsc(accounts, s.siteId, { startDate: currStart, endDate: currEnd, dimensions: ['query'], rowLimit: 5000 }) as Promise<Row[]>,
        queryGsc(accounts, s.siteId, { startDate: prevStart, endDate: prevEnd, dimensions: ['query'], rowLimit: 5000 }) as Promise<Row[]>,
      ]);

      // Positions arrive already aggregated by Search Console for each window, so nothing is
      // averaged here — averaging daily positions unweighted is what makes rank charts lie.
      const prevMap = new Map<string, number>();
      for (const r of prev) {
        const q = r.keys?.[0];
        if (q && r.position != null) prevMap.set(q, r.position);
      }

      for (const r of curr) {
        const q = r.keys?.[0];
        const impressions = r.impressions ?? 0;
        if (!q || impressions < MIN_IMPRESSIONS) continue;
        const prevPos = prevMap.get(q);
        if (prevPos == null) continue; // absent from one window — nothing to compare against
        const currPos = r.position ?? 0;
        points.push({
          query: q,
          clicks: r.clicks ?? 0,
          impressions,
          prevPos: Math.round(prevPos * 10) / 10,
          currPos: Math.round(currPos * 10) / 10,
          // Positive = improved (moved up the page), matching how rank deltas read elsewhere.
          delta: Math.round((prevPos - currPos) * 10) / 10,
        });
      }
    });

    // Biggest movers first, so a truncated view still shows what actually changed.
    points.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    const payload = {
      points: points.slice(0, 1000),
      periods: { previous: `${prevStart} → ${prevEnd}`, current: `${currStart} → ${currEnd}` },
      // Lets the UI explain an empty result instead of implying the site has no traffic at all.
      reason: points.length ? undefined : 'no_overlap',
    };
    cache.set(cacheKey, { at: Date.now(), payload });
    return NextResponse.json(payload);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'GSC query failed' }, { status: 500 });
  }
}
