import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyAuthOrShare } from '@/lib/authShare';
import { google } from 'googleapis';
import { makeOAuth2, dateWindows, pct, GA4_API_METRICS, type GoogleAccount } from '@/lib/ga4';

type Totals = { sessions: number; engagement: number; events: number; revenue: number };

const num = (v: string | null | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Map an ordered metricValues[] (sessions, engagementRate, keyEvents, totalRevenue)
// into a typed Totals object.
function toTotals(values: { value?: string | null }[] | undefined): Totals {
  return {
    sessions: num(values?.[0]?.value),
    engagement: num(values?.[1]?.value), // ratio 0..1
    events: num(values?.[2]?.value),
    revenue: num(values?.[3]?.value),
  };
}

const metricDefs = GA4_API_METRICS.map((name) => ({ name }));

// GET /api/ga4/report?domain=...&period=7d
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const domain = (searchParams.get('domain') ?? '').trim();
  const period = searchParams.get('period') ?? '7d';

  const auth = await verifyAuthOrShare(req, domain, true);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { userId, site } = auth;

  const propertyId = (site as any).ga4PropertyId as string | null;
  if (!propertyId) {
    return NextResponse.json({ linked: false });
  }

  const accounts = (await prisma.account.findMany({
    where: { userId, provider: 'google' },
    select: { id: true, access_token: true, refresh_token: true, expires_at: true },
  })) as GoogleAccount[];

  const w = dateWindows(period);
  const property = `properties/${propertyId}`;

  // Try each linked account until one can read this property.
  let lastError = '';
  for (const account of accounts) {
    try {
      const oauth2 = makeOAuth2(account);
      const data = google.analyticsdata({ version: 'v1beta', auth: oauth2 });

      // 1) Time series over the current period (for the chart).
      const seriesRes = await data.properties.runReport({
        property,
        requestBody: {
          dateRanges: [{ startDate: w.start, endDate: w.end }],
          dimensions: [{ name: 'date' }],
          metrics: metricDefs,
          orderBys: [{ dimension: { dimensionName: 'date' } }],
          limit: '1000',
        },
      });

      // 2) Aggregate totals for current + previous period (for deltas) in one call.
      //    With 2 dateRanges GA4 adds a synthetic "dateRange" dimension per row.
      const totalsRes = await data.properties.runReport({
        property,
        requestBody: {
          dateRanges: [
            { startDate: w.start, endDate: w.end },
            { startDate: w.prevStart, endDate: w.prevEnd },
          ],
          metrics: metricDefs,
        },
      });

      // ── Build the time series ──────────────────────────────────────────────
      const series = (seriesRes.data.rows ?? []).map((row) => {
        const raw = row.dimensionValues?.[0]?.value ?? ''; // "YYYYMMDD"
        const t = toTotals(row.metricValues ?? undefined);
        const date =
          raw.length === 8
            ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
            : raw;
        return {
          date,
          sessions: t.sessions,
          engagement: +(t.engagement * 100).toFixed(2), // percent for the UI
          events: t.events,
          revenue: +t.revenue.toFixed(2),
        };
      });

      // ── Current vs previous totals ─────────────────────────────────────────
      let curr: Totals = { sessions: 0, engagement: 0, events: 0, revenue: 0 };
      let prev: Totals = { sessions: 0, engagement: 0, events: 0, revenue: 0 };
      for (const row of totalsRes.data.rows ?? []) {
        const tag = row.dimensionValues?.[0]?.value ?? '';
        const t = toTotals(row.metricValues ?? undefined);
        if (tag === 'date_range_0') curr = t;
        else if (tag === 'date_range_1') prev = t;
      }

      return NextResponse.json({
        linked: true,
        property: { id: propertyId, name: (site as any).ga4PropertyName ?? '' },
        range: { start: w.start, end: w.end },
        totals: {
          sessions: Math.round(curr.sessions),
          engagement: +(curr.engagement * 100).toFixed(1), // percent
          events: Math.round(curr.events),
          revenue: +curr.revenue.toFixed(2),
        },
        deltas: {
          sessions: pct(curr.sessions, prev.sessions),
          engagement: pct(curr.engagement, prev.engagement),
          events: pct(curr.events, prev.events),
          revenue: pct(curr.revenue, prev.revenue),
        },
        series,
      });
    } catch (err: any) {
      lastError = err?.message ?? 'error';
      continue;
    }
  }

  return NextResponse.json(
    { linked: true, error: lastError || 'Could not read GA4 property' },
    { status: 502 }
  );
}
