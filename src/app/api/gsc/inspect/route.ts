import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { google } from 'googleapis';
import { safeFetch } from '@/lib/security/safeFetch';

function makeOAuth2(account: {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
}) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.expires_at ? account.expires_at * 1000 : undefined,
  });
  return oauth2;
}

// ─── GET ?siteId= → return cached inspections ─────────────────────────────────
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get('siteId') ?? '';

  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const pi = (prisma as any).pageInspection;
  const inspections = await pi.findMany({
    where: { siteId },
    orderBy: { lastInspect: 'desc' },
  });

  return NextResponse.json({ inspections });
}

// Helper to fetch and parse Sitemap URLs as fallback for URL inspection
async function getSitemapUrlsFallback(siteId: string, siteUrl: string, customSitemapUrl?: string | null): Promise<string[]> {
  try {
    // 1. Try querying existing SitemapUrl records
    const existing = await prisma.sitemapUrl.findMany({
      where: { siteId },
      select: { url: true },
      take: 20,
    });
    if (existing.length > 0) {
      return existing.map(u => u.url);
    }

    // 2. Try fetching sitemap.xml directly
    const targetSitemap = customSitemapUrl || `${siteUrl.replace(/\/$/, '')}/sitemap.xml`;
    const res = await safeFetch(targetSitemap, {
      timeoutMs: 10_000,
      maxBytes: 10 * 1024 * 1024,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OpenGSCCrawler/1.0)' },
    });
    if (res.ok) {
      const text = await res.text();
      const locRe = /<loc>\s*(https?:\/\/[^\s<]+)\s*<\/loc>/gi;
      const urls: string[] = [];
      let m;
      while ((m = locRe.exec(text)) !== null) {
        urls.push(m[1].trim());
        if (urls.length >= 20) break;
      }
      
      if (urls.length > 0) {
        // Save them to database in background
        prisma.$transaction(
          urls.map(url =>
            prisma.sitemapUrl.upsert({
              where: { siteId_url: { siteId, url } },
              create: { siteId, url },
              update: {},
            })
          )
        ).catch(() => {});
        return urls;
      }
    }
  } catch {}

  // 3. Ultimate fallback: homepage
  return [siteUrl];
}

// ─── POST { siteId, urls?, forceRefresh? } → inspect & cache ─────────────────
export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const siteId: string = body.siteId;
  const requestedUrls: string[] | undefined = body.urls;
  const forceRefresh: boolean = body.forceRefresh ?? false;

  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const accounts = await prisma.account.findMany({
    where: { userId, provider: 'google' },
    select: { id: true, access_token: true, refresh_token: true, expires_at: true },
  });
  if (accounts.length === 0) {
    return NextResponse.json({ error: 'No Google account connected' }, { status: 400 });
  }

  // ── Determine which URLs to process ──────────────────────────────────────────
  let urlsToProcess: string[];
  if (requestedUrls && requestedUrls.length > 0) {
    urlsToProcess = requestedUrls.slice(0, 25);
  } else {
    // Top 20 URLs by impressions from synced DailyMetric data
    const topUrls = await prisma.dailyMetric.groupBy({
      by: ['url'],
      where: { siteId },
      _sum: { impressions: true },
      orderBy: { _sum: { impressions: 'desc' } },
      take: 20,
    });
    urlsToProcess = topUrls.map(u => u.url).filter(u => u !== '');
    
    // FALLBACK: If no URLs are found from traffic data, fetch from Sitemap or DB
    if (urlsToProcess.length === 0) {
      urlsToProcess = await getSitemapUrlsFallback(siteId, site.url, site.sitemapUrl);
    }
  }

  if (urlsToProcess.length === 0) {
    return NextResponse.json({ inspections: [], inspected: 0, message: 'No URLs found.' });
  }

  // ── Decide which URLs actually need a fresh API call (24h TTL) ───────────────
  const pi  = (prisma as any).pageInspection;
  const pih = (prisma as any).pageInspectionHistory;

  const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cached = await pi.findMany({
    where: { siteId, url: { in: urlsToProcess } },
  });
  const cachedMap = new Map(cached.map((e: any) => [e.url, e]));

  const needsInspection = forceRefresh
    ? urlsToProcess
    : urlsToProcess.filter(url => {
        const e = cachedMap.get(url) as any;
        return !e || new Date(e.lastInspect) < staleThreshold;
      });

  // ── Call URL Inspection API for stale/missing URLs ────────────────────────────
  const freshResults: any[] = [];

  for (const url of needsInspection) {
    let inspected = false;
    for (const account of accounts) {
      try {
        const oauth2 = makeOAuth2(account);
        const sc = google.searchconsole({ version: 'v1', auth: oauth2 });

        const res = await sc.urlInspection.index.inspect({
          requestBody: { inspectionUrl: url, siteUrl: site.siteId },
        });

        const idx = res.data.inspectionResult?.indexStatusResult;
        const rich = res.data.inspectionResult?.richResultsResult;

        const status = (idx?.coverageState as string) ?? 'Unknown';
        const lastCrawl = idx?.lastCrawlTime ? new Date(idx.lastCrawlTime as string) : null;

        const richTypes = (rich?.detectedItems ?? [])
          .map((d: any) => d.richResultType)
          .filter(Boolean);
        const richResults = richTypes.length > 0 ? JSON.stringify(richTypes) : null;

        // Upsert into PageInspection
        const row = await pi.upsert({
          where: { siteId_url: { siteId, url } },
          create: { siteId, url, status, lastCrawl, richResults, lastInspect: new Date() },
          update: { status, lastCrawl, richResults, lastInspect: new Date() },
        });

        // Save one history row per day
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        await pih.upsert({
          where: { siteId_url_date: { siteId, url, date: today } },
          create: { siteId, url, date: today, status },
          update: { status },
        });

        freshResults.push(row);
        inspected = true;
        break;
      } catch (_e) {
        continue;
      }
    }
    // If all accounts failed, keep existing cached row if any
    if (!inspected && cachedMap.has(url)) {
      freshResults.push(cachedMap.get(url));
    }
  }

  // Merge: fresh results + still-valid cached rows
  const freshUrls = new Set(freshResults.map(r => r.url));
  const allResults = [
    ...freshResults,
    ...urlsToProcess
      .filter(url => !freshUrls.has(url) && cachedMap.has(url))
      .map(url => cachedMap.get(url)),
  ];

  return NextResponse.json({ inspections: allResults, inspected: needsInspection.length });
}
