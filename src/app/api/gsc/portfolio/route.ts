import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { resolveWindow, previousWindow, comparisonShift, SEARCH_TYPES } from '@/lib/periodWindow';

type DailyRow = Awaited<ReturnType<typeof prisma.dailyMetric.findMany>>[number];

function pct(curr: number, prev: number) {
  if (prev === 0) return 0;   // no previous data — can't compute real change
  return Math.round(((curr - prev) / prev) * 100);
}

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const period     = searchParams.get('period')   || '7d';
  const matchWd    = searchParams.get('matchWd')  === 'true';
  const comparison = searchParams.get('comparison') || 'previous';
  // Which GSC search type the window describes. The rollup stores one row-kind per type, so
  // every dailyMetric read below MUST carry this — an unfiltered read counts five types.
  const searchType = searchParams.get('searchType');
  const type = searchType && SEARCH_TYPES.has(searchType) ? searchType : 'web';

  // Current window from the period key or the custom range; the comparison window from the
  // mode (previous / yoy / prev_month, weekday-aligned) — or none at all when disabled, in
  // which case no previous-period query runs and every delta ships as 0.
  const window = resolveWindow(period, searchParams.get('start'), searchParams.get('end'));
  const { start: startDate, end: endDate, days } = window;
  const prev = previousWindow(window, comparison, matchWd);
  const shift = prev ? comparisonShift(window, prev) : 0;
  const noPrev: DailyRow[] = [];

  const sites = await prisma.site.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

  // Zeroed payload for archived properties. They still ship to the client — the dashboard
  // lists them in its Archive group — but the two metric reads and the sparkline maths are
  // skipped. A removed property has no new data by definition, so the work could only ever
  // produce a flat line, and on a large account this is two queries per dead domain per load.
  const emptySummary = {
    clicks:      { value: 0, change: 0 },
    impressions: { value: 0, change: 0 },
    ctr:         { value: 0, change: 0 },
    position:    { value: 0, change: 0 },
  };

  const result = await Promise.all(
    sites.map(async (site) => {
      if (site.archivedAt) {
        return { ...site, data: [], summary: emptySummary, hasData: false };
      }

      const [currRows, prevRows] = await Promise.all([
        prisma.dailyMetric.findMany({
          where: { siteId: site.id, date: { gte: startDate, lte: endDate }, url: '', query: '', searchType: type },
          orderBy: { date: 'asc' },
        }),
        prev
          ? prisma.dailyMetric.findMany({
              where: { siteId: site.id, date: { gte: prev.start, lte: prev.end }, url: '', query: '', searchType: type },
            })
          : Promise.resolve(noPrev),
      ]);

      // Summaries
      const sum = (rows: typeof currRows) =>
        rows.reduce(
          (a, m) => ({ clicks: a.clicks + m.clicks, impressions: a.impressions + m.impressions, ctr: a.ctr + m.ctr, position: a.position + m.position, n: a.n + 1 }),
          { clicks: 0, impressions: 0, ctr: 0, position: 0, n: 0 }
        );

      const c = sum(currRows);
      const p = sum(prevRows);

      const avgCtr = (s: typeof c) => (s.n > 0 ? +((s.ctr / s.n) * 100).toFixed(2) : 0);
      const avgPos = (s: typeof c) => (s.n > 0 ? +(s.position / s.n).toFixed(1) : 0);

      const summary = {
        clicks:      { value: c.clicks,      change: pct(c.clicks, p.clicks) },
        impressions: { value: c.impressions,  change: pct(c.impressions, p.impressions) },
        ctr:         { value: avgCtr(c),      change: pct(avgCtr(c), avgCtr(p)) },
        position:    { value: avgPos(c),      change: pct(avgPos(c), avgPos(p)) },
      };

      // Chart data (normalised 0–85 for sparkline)
      const norm = (arr: number[]) => {
        const lo = Math.min(...arr, 0), hi = Math.max(...arr, 1);
        return arr.map(v => hi === lo ? 50 : Math.round(((v - lo) / (hi - lo)) * 85 + 5));
      };

      // Build a date → row map for the previous period
      const prevByDate = new Map<string, typeof prevRows[number]>();
      for (const r of prevRows) {
        prevByDate.set(r.date.toISOString().split('T')[0], r);
      }

      const clicks      = currRows.map(r => r.clicks);
      const impressions = currRows.map(r => r.impressions);
      const ctrs        = currRows.map(r => +((r.ctr * 100).toFixed(2)));
      const positions   = currRows.map(r => +r.position.toFixed(1));

      // For each current row, look up the corresponding prev-period row
      // by shifting the date back to where the comparison window starts
      const clicksC: number[] = [];
      const impressionsC: number[] = [];
      const ctrsC: number[] = [];
      const positionsC: number[] = [];

      for (const r of currRows) {
        const shifted = new Date(r.date);
        shifted.setDate(shifted.getDate() - shift);
        const key = shifted.toISOString().split('T')[0];
        const prev = prevByDate.get(key);
        clicksC.push(prev?.clicks ?? 0);
        impressionsC.push(prev?.impressions ?? 0);
        ctrsC.push(prev ? +((prev.ctr * 100).toFixed(2)) : 0);
        positionsC.push(prev ? +prev.position.toFixed(1) : 0);
      }

      const nC  = norm(clicks),      nI  = norm(impressions),  nT  = norm(ctrs),   nP  = norm(positions);
      const nCC = norm(clicksC),      nIC = norm(impressionsC), nTC = norm(ctrsC),  nPC = norm(positionsC);

      const data = currRows.map((r, i) => ({
        date: r.date.toISOString().split('T')[0],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: ctrs[i],
        position: positions[i],
        clicksC:      clicksC[i],
        impressionsC: impressionsC[i],
        ctrC:         ctrsC[i],
        positionC:    positionsC[i],
        cN: nC[i],  iN: nI[i],  tN: nT[i],  pN: nP[i],
        cCN: nCC[i], iCN: nIC[i], tCN: nTC[i], pCN: nPC[i],
      }));

      return { ...site, data, summary, hasData: currRows.length > 0 };
    })
  );

  return NextResponse.json({ sites: result });
}
