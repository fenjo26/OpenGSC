import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyAuthOrShare } from '@/lib/authShare';
import { google } from 'googleapis';
import { makeOAuth2, dateWindows, type GoogleAccount } from '@/lib/ga4';

type Row = { label: string; value: number; sub?: number };

const num = (v: string | null | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Map runReport rows → [{ label, value, sub }] using the first dimension as the
// label, the first metric as the value and the (optional) second metric as sub.
function mapRows(res: any): Row[] {
  return (res?.data?.rows ?? []).map((r: any) => ({
    label: r.dimensionValues?.[0]?.value ?? '',
    value: num(r.metricValues?.[0]?.value),
    sub: r.metricValues?.[1] ? num(r.metricValues?.[1]?.value) : undefined,
  }));
}

const val = <T,>(r: PromiseSettledResult<T>): T | null =>
  r.status === 'fulfilled' ? r.value : null;

// GET /api/ga4/breakdowns?domain=...&period=7d
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const domain = (searchParams.get('domain') ?? '').trim();
  const period = searchParams.get('period') ?? '7d';

  const auth = await verifyAuthOrShare(req, domain, true);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { userId, site } = auth;

  const propertyId = (site as any).ga4PropertyId as string | null;
  if (!propertyId) return NextResponse.json({ linked: false });

  const accounts = (await prisma.account.findMany({
    where: { userId, provider: 'google' },
    select: { id: true, access_token: true, refresh_token: true, expires_at: true },
  })) as GoogleAccount[];

  const w = dateWindows(period);
  const property = `properties/${propertyId}`;
  const dateRanges = [{ startDate: w.start, endDate: w.end }];

  const report = (dimensions: string[], metrics: string[], limit = 10) => ({
    property,
    requestBody: {
      dateRanges,
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      orderBys: [{ metric: { metricName: metrics[0] }, desc: true }],
      limit: String(limit),
    },
  });

  let lastError = '';
  for (const account of accounts) {
    try {
      const oauth2 = makeOAuth2(account);
      const data = google.analyticsdata({ version: 'v1beta', auth: oauth2 });

      // Probe this account/token can read the property before committing.
      await data.properties.runReport({
        property,
        requestBody: { dateRanges, metrics: [{ name: 'sessions' }] },
      });

      const [pages, channels, sources, countries, devices, events, realtime] =
        await Promise.allSettled([
          data.properties.runReport(report(['pagePath'], ['screenPageViews', 'sessions'])),
          data.properties.runReport(report(['sessionDefaultChannelGroup'], ['sessions', 'totalUsers'])),
          data.properties.runReport(report(['sessionSourceMedium'], ['sessions'])),
          data.properties.runReport(report(['country'], ['activeUsers', 'sessions'])),
          data.properties.runReport(report(['deviceCategory'], ['sessions', 'totalUsers'])),
          data.properties.runReport(report(['eventName'], ['eventCount'])),
          data.properties.runRealtimeReport({
            property,
            requestBody: { dimensions: [{ name: 'country' }], metrics: [{ name: 'activeUsers' }], limit: '10' },
          }),
        ]);

      const rtRows = mapRows(val(realtime));
      const rtTotal = rtRows.reduce((s, r) => s + r.value, 0);

      return NextResponse.json({
        linked: true,
        topPages: mapRows(val(pages)),
        channels: mapRows(val(channels)),
        sources: mapRows(val(sources)),
        countries: mapRows(val(countries)),
        devices: mapRows(val(devices)),
        events: mapRows(val(events)),
        realtime: { activeUsers: rtTotal, byCountry: rtRows },
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
