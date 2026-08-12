import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

function periodToDays(period: string): number {
  const today = new Date();
  const map: Record<string, number> = {
    yesterday: 1,
    '7d': 7, '14d': 14, '28d': 28,
    last_week: 7,
    this_month: today.getDate(),
    last_month: new Date(today.getFullYear(), today.getMonth(), 0).getDate(),
    this_quarter: 90, last_quarter: 90,
    ytd: Math.floor((today.getTime() - new Date(today.getFullYear(), 0, 1).getTime()) / 86400000),
    '3m': 90, '6m': 180, '8m': 240, '12m': 365, '16m': 480, '2y': 730, '3y': 1095,
  };
  return map[period] ?? 28;
}

function pct(curr: number, prev: number) {
  if (prev === 0) return 0;   // no previous data — can't compute real change
  return Math.round(((curr - prev) / prev) * 100);
}

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const period   = searchParams.get('period')   || '7d';
  const matchWd  = searchParams.get('matchWd')  === 'true';
  const days = periodToDays(period);

  // GSC 'final' data lags ~2 days
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 2);
  endDate.setHours(23, 59, 59, 999);

  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - days + 1);
  startDate.setHours(0, 0, 0, 0);

  const prevEnd = new Date(startDate);
  prevEnd.setDate(startDate.getDate() - 1);
  prevEnd.setHours(23, 59, 59, 999);

  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevEnd.getDate() - days + 1);
  prevStart.setHours(0, 0, 0, 0);

  // Match Weekdays: shift comparison period so it ends on the same weekday as endDate
  if (matchWd) {
    const shift = (endDate.getDay() - prevEnd.getDay() + 7) % 7;
    if (shift > 0) {
      prevEnd.setDate(prevEnd.getDate() + shift);
      prevStart.setDate(prevStart.getDate() + shift);
    }
  }

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
          where: { siteId: site.id, date: { gte: startDate, lte: endDate }, url: '', query: '' },
          orderBy: { date: 'asc' },
        }),
        prisma.dailyMetric.findMany({
          where: { siteId: site.id, date: { gte: prevStart, lte: prevEnd }, url: '', query: '' },
        }),
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
      // by shifting the date back by `days`
      const clicksC: number[] = [];
      const impressionsC: number[] = [];
      const ctrsC: number[] = [];
      const positionsC: number[] = [];

      for (const r of currRows) {
        const shifted = new Date(r.date);
        shifted.setDate(shifted.getDate() - days);
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
