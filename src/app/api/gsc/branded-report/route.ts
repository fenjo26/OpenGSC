import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { google } from 'googleapis';

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get('siteId') ?? '';
  const period = searchParams.get('period') ?? '30d';

  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const brandedKeywords: string[] = site.brandedKeywords ? JSON.parse(site.brandedKeywords) : [];
  if (brandedKeywords.length === 0) return NextResponse.json({ rows: [] });

  // Date range
  const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : period === '180d' ? 180 : 30;
  const end = new Date(); end.setDate(end.getDate() - 2);
  const start = new Date(end); start.setDate(end.getDate() - days);
  const startStr = start.toISOString().split('T')[0];
  const endStr = end.toISOString().split('T')[0];

  const accounts = await prisma.account.findMany({
    where: { userId, provider: 'google' },
    select: { access_token: true, refresh_token: true, expires_at: true },
  });

  // Fetch query+date breakdown from GSC
  let rows: any[] = [];
  for (const account of accounts) {
    try {
      const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
      oauth2.setCredentials({ access_token: account.access_token, refresh_token: account.refresh_token });
      const wm = google.webmasters({ version: 'v3', auth: oauth2 });
      const res = await wm.searchanalytics.query({
        siteUrl: site.siteId,
        requestBody: {
          startDate: startStr, endDate: endStr,
          dimensions: ['date', 'query'],
          rowLimit: 25000,
          dataState: 'all',
        },
      });
      rows = res.data.rows ?? [];
      break;
    } catch { continue; }
  }

  // Aggregate by date: branded vs non-branded
  const isBranded = (query: string) =>
    brandedKeywords.some(kw => query.toLowerCase().includes(kw.toLowerCase()));

  const byDate = new Map<string, { branded: number; nonBranded: number; brandedImpr: number; nonBrandedImpr: number }>();

  for (const row of rows) {
    const date = row.keys?.[0] ?? '';
    const query = row.keys?.[1] ?? '';
    if (!date) continue;

    if (!byDate.has(date)) byDate.set(date, { branded: 0, nonBranded: 0, brandedImpr: 0, nonBrandedImpr: 0 });
    const entry = byDate.get(date)!;

    if (isBranded(query)) {
      entry.branded += row.clicks ?? 0;
      entry.brandedImpr += row.impressions ?? 0;
    } else {
      entry.nonBranded += row.clicks ?? 0;
      entry.nonBrandedImpr += row.impressions ?? 0;
    }
  }

  const result = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, ...v }));

  return NextResponse.json({ rows: result, keywords: brandedKeywords });
}
