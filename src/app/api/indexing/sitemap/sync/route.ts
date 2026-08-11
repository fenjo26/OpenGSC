import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { safeFetch } from '@/lib/security/safeFetch';

// Extract all <loc> URLs from a sitemap XML string (handles both sitemapindex and urlset)
function extractUrls(xml: string): string[] {
  const urls: string[] = [];
  const locRe = /<loc>\s*(https?:\/\/[^\s<]+)\s*<\/loc>/gi;
  let m;
  while ((m = locRe.exec(xml)) !== null) {
    urls.push(m[1].trim());
  }
  return urls;
}

// Returns true if this XML is a sitemap index (links to other sitemaps)
function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex/i.test(xml);
}

async function fetchWithTimeout(url: string, ms = 15000): Promise<string> {
  const res = await safeFetch(url, {
    timeoutMs: ms,
    maxBytes: 10 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOGetsCrawler/1.0)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Recursively resolve sitemap index → collect all leaf URLs (max 20k)
async function collectSitemapUrls(sitemapUrl: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const xml = await fetchWithTimeout(sitemapUrl);
  if (!isSitemapIndex(xml)) {
    return extractUrls(xml);
  }
  // It's a sitemap index — get child sitemap URLs and recurse
  const childSitemaps = extractUrls(xml);
  const results: string[] = [];
  for (const child of childSitemaps.slice(0, 50)) {
    try {
      const childUrls = await collectSitemapUrls(child, depth + 1);
      results.push(...childUrls);
      if (results.length >= 20000) break;
    } catch {}
  }
  return results;
}

// POST { siteDbId: string, sitemapUrl?: string }
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const siteDbId: string = body.siteDbId;
  if (!siteDbId) return NextResponse.json({ error: 'siteDbId required' }, { status: 400 });

  const site = await prisma.site.findFirst({
    where: { id: siteDbId, userId },
    select: { id: true, url: true, sitemapUrl: true },
  });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  // Determine sitemap URL
  const customSitemapUrl: string | undefined = body.sitemapUrl || site.sitemapUrl || undefined;
  const baseUrl = site.url.replace(/\/$/, '');
  const targetSitemap = customSitemapUrl || `${baseUrl}/sitemap.xml`;

  let urls: string[] = [];
  let fetchError: string | null = null;

  try {
    urls = await collectSitemapUrls(targetSitemap);
  } catch (e: any) {
    fetchError = e?.message ?? 'Failed to fetch sitemap';
  }

  if (fetchError && urls.length === 0) {
    await prisma.indexingOperation.create({
      data: {
        siteId: siteDbId,
        type: 'sitemap_sync',
        result: 'error',
        detail: fetchError,
        urlCount: 0,
      },
    });
    return NextResponse.json({ error: fetchError }, { status: 502 });
  }

  // Deduplicate
  const uniqueUrls = [...new Set(urls)].slice(0, 20000);

  // Upsert all URLs — keep existing statuses, only add new rows
  const now = new Date();
  await prisma.$transaction(
    uniqueUrls.map(url =>
      prisma.sitemapUrl.upsert({
        where: { siteId_url: { siteId: siteDbId, url } },
        create: { siteId: siteDbId, url },
        update: {}, // don't overwrite existing status data on re-sync
      }),
    ),
    { timeout: 60000 },
  );

  // Save sitemap URL preference + last sync time
  await prisma.site.update({
    where: { id: siteDbId },
    data: {
      lastSitemapSync: now,
      ...(customSitemapUrl ? { sitemapUrl: customSitemapUrl } : {}),
    },
  });

  // Log operation
  await prisma.indexingOperation.create({
    data: {
      siteId: siteDbId,
      type: 'sitemap_sync',
      result: 'success',
      detail: targetSitemap,
      urlCount: uniqueUrls.length,
    },
  });

  return NextResponse.json({
    ok: true,
    total: uniqueUrls.length,
    sitemapUrl: targetSitemap,
    syncedAt: now.toISOString(),
  });
}
