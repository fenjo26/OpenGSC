import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { extAuth, extPreflight, extTablesMissing, type ExtAuthOk } from "@/lib/ext/auth";
import { matchPortfolioSite, normalizePageUrl, pathOnly, urlVariants } from "@/lib/ext/urlMatch";
import { isIndexedCoverage } from "@/lib/indexing/queue";

// GET /api/ext/page?url= — everything OpenGSC knows about the page in the active tab, in one
// request (N11 brief, п.1). Local data only: no Google calls, no fetches, nothing spent.
// The extension's popup renders this; a foreign URL answers { inPortfolio: false } so the
// popup can offer the outreach path instead.
//
// Bearer User.extToken; CORS restricted to allowed extension ids; 60 req/min (extAuth).

const WINDOW_DAYS = 28;
const TOP_QUERIES = 5;
const TOP_RANKS = 10;

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function pageSummary(auth: ExtAuthOk, rawUrl: string): Promise<object> {
  const nu = normalizePageUrl(rawUrl);
  if (!nu) return { url: rawUrl, inPortfolio: false, error: "invalid_url" };

  const sites = await prisma.site.findMany({
    where: { userId: auth.userId },
    select: { id: true, siteId: true, url: true },
  });
  const site = matchPortfolioSite(sites, nu);
  if (!site) return { url: nu.href, inPortfolio: false };

  const variants = urlVariants(nu);
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

  // ── performance: the page's rows over the window (web page/query rows, never rollups) ──
  const rows = await prisma.dailyMetric.findMany({
    where: { siteId: site.id, url: { in: variants }, date: { gte: since } },
    select: { query: true, clicks: true, impressions: true, position: true },
  });
  let clicks = 0;
  let impressions = 0;
  let posSum = 0;
  const byQuery = new Map<string, { clicks: number; impressions: number; posSum: number; n: number }>();
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    posSum += r.position;
    if (!r.query) continue;
    const cur = byQuery.get(r.query) ?? { clicks: 0, impressions: 0, posSum: 0, n: 0 };
    cur.clicks += r.clicks;
    cur.impressions += r.impressions;
    cur.posSum += r.position;
    cur.n++;
    byQuery.set(r.query, cur);
  }
  const topQueries = [...byQuery.entries()]
    .map(([query, v]) => ({ query, clicks: v.clicks, impressions: v.impressions, position: Math.round((v.posSum / v.n) * 10) / 10 }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, TOP_QUERIES);

  // ── index status: the freshest of the sitemap inventory row and the last manual inspection ──
  const [sitemapRow, inspectionRow] = await Promise.all([
    prisma.sitemapUrl.findFirst({
      where: { siteId: site.id, url: { in: variants }, inventoryStatus: "active" },
      orderBy: { googleChecked: "desc" },
      select: { googleCoverage: true, googleVerdict: true, googleStatus: true, googleChecked: true, googleNextCheck: true, googleCanonical: true },
    }),
    prisma.pageInspection.findFirst({
      where: { siteId: site.id, url: { in: variants } },
      orderBy: { lastInspect: "desc" },
      select: { status: true, lastInspect: true, lastCrawl: true },
    }),
  ]);
  const sitemapAt = sitemapRow?.googleChecked?.getTime() ?? 0;
  const inspectAt = inspectionRow?.lastInspect?.getTime() ?? 0;
  let index: object | null = null;
  if (sitemapRow && sitemapAt >= inspectAt) {
    // Fresh rows carry (coverage, verdict); rows last inspected before wave-oct carry only the
    // combined googleStatus column. Unknown on both → indexed: null, never a guess.
    const indexed = isIndexedCoverage(sitemapRow.googleCoverage ?? null, sitemapRow.googleVerdict ?? null)
      ?? (sitemapRow.googleStatus ? isIndexedCoverage(sitemapRow.googleStatus, null) : null);
    index = {
      source: "sitemap",
      status: sitemapRow.googleCoverage ?? sitemapRow.googleStatus ?? null,
      indexed, // true | false | null = never checked / unrecognized state
      checkedAt: sitemapRow.googleChecked,
      nextCheck: sitemapRow.googleNextCheck,
      canonical: sitemapRow.googleCanonical,
    };
  } else if (inspectionRow) {
    index = {
      source: "inspection",
      status: inspectionRow.status,
      indexed: isIndexedCoverage(inspectionRow.status, null),
      checkedAt: inspectionRow.lastInspect,
      lastCrawl: inspectionRow.lastCrawl,
    };
  }

  // ── the last completed audit's findings for this exact page ──
  let audit: object | null = null;
  const lastAudit = await prisma.siteAudit.findFirst({
    where: { siteId: site.id, status: "completed" },
    orderBy: { startedAt: "desc" },
    select: { id: true, finishedAt: true, summary: true },
  });
  if (lastAudit) {
    const page = await prisma.siteAuditPage.findFirst({
      where: { auditId: lastAudit.id, url: { contains: pathOnly(nu.href) } },
      select: { url: true, httpStatus: true, issues: true, evidence: true, noindex: true, wordCount: true, loadMs: true },
    });
    if (page) {
      audit = {
        auditedAt: lastAudit.finishedAt,
        pageUrl: page.url,
        httpStatus: page.httpStatus,
        noindex: page.noindex,
        wordCount: page.wordCount,
        loadMs: page.loadMs,
        issues: parseJson(page.issues) ?? [],
        evidence: parseJson(page.evidence),
      };
    }
  }

  // ── tracked keywords this URL ranks for (latest check) ──
  const ranks = await prisma.trackedKeyword.findMany({
    where: { siteId: site.id, lastUrl: { in: variants } },
    orderBy: [{ lastPosition: "asc" }, { keyword: "asc" }],
    take: TOP_RANKS,
    select: { keyword: true, lastPosition: true, lastCheckedAt: true, country: true, location: true, lastLocalPack: true },
  });

  return {
    url: nu.href,
    inPortfolio: true,
    site: {
      id: site.id,
      siteId: site.siteId,
      label: site.url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/$/, ""),
      openPath: `/site/${site.id}`,
    },
    windowDays: WINDOW_DAYS,
    metrics: rows.length ? { clicks, impressions, avgPosition: Math.round((posSum / rows.length) * 10) / 10 } : null,
    topQueries,
    index,
    audit,
    ranks: ranks.map(k => ({
      keyword: k.keyword,
      position: k.lastPosition, // null = not found in scanned depth — an honest state, not 0
      localPack: k.lastLocalPack ?? null,
      country: k.country,
      location: k.location || null,
      lastCheckedAt: k.lastCheckedAt,
    })),
  };
}

export async function GET(req: Request) {
  const auth = await extAuth(req, "read");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url).searchParams.get("url") ?? "";
  if (!url.trim()) {
    return NextResponse.json({ error: "url_required" }, { status: 400, headers: auth.auth.cors });
  }
  try {
    const body = await pageSummary(auth.auth, url);
    return NextResponse.json(body, { headers: auth.auth.cors });
  } catch (e) {
    if (extTablesMissing(e)) {
      return NextResponse.json({ notMigrated: true }, { status: 200, headers: auth.auth.cors });
    }
    throw e;
  }
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
