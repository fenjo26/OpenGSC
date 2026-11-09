// wave-ext E2 — the panel's OpenGSC tab beyond GET /api/ext/page: the page's main GSC query,
// sitemap membership, the free meta suggestion and the network-wide footprint check.
//
// pageInsights is the DB-bound half (one call, local reads only). pickMainQuery and
// footprintHits are pure and unit-tested in insights.test.ts.
import { prisma } from "@/lib/prisma";
import {
  collectPortfolio, siteEntities, skeletonOf, skeletonWordCount,
  MIN_SKELETON_WORDS, SIMILARITY_THRESHOLD,
  type FootprintItem,
} from "@/lib/footprint";
import { fitMetaLocal } from "@/lib/seo/metaFit";
import { pageMatchesQuery } from "@/lib/audit/queryAlign";
import { matchPortfolioSite, normalizePageUrl, urlVariants } from "@/lib/ext/urlMatch";
import { EXT_QUERY_WINDOW_DAYS, type InsightsRequest, type InsightsResponse, type FootprintHit } from "./types";

// ── pure (tested) ──

/** The page's main query: more clicks → more impressions → lower position → alphabetical. */
export function pickMainQuery(rows: { query: string; clicks: number; impressions: number; position: number }[]):
  { query: string; clicks: number; impressions: number; position: number } | null {
  if (!rows.length) return null;
  let best: { query: string; clicks: number; impressions: number; position: number } | null = null;
  for (const r of rows) {
    const q = String(r.query ?? "").trim();
    if (!q) continue;
    const cur = {
      query: q,
      clicks: Number(r.clicks) || 0,
      impressions: Number(r.impressions) || 0,
      // position 0 is GSC's "no impression" artefact, not a rank — sort as the worst
      position: Number(r.position) || 0,
    };
    if (
      !best ||
      cur.clicks > best.clicks ||
      (cur.clicks === best.clicks && cur.impressions > best.impressions) ||
      (cur.clicks === best.clicks && cur.impressions === best.impressions &&
        (best.position === 0 ? Infinity : best.position) > (cur.position === 0 ? Infinity : cur.position)) ||
      (cur.clicks === best.clicks && cur.impressions === best.impressions && cur.position === best.position &&
        cur.query.localeCompare(best.query) < 0)
    ) {
      best = cur;
    }
  }
  return best;
}

// Copies of similarityWords/jaccard from src/lib/footprint/skeleton.ts (not exported there;
// footprint/** must not be touched by this wave). insights.test.ts asserts the copy clusters
// the same pairs similarGroups() does, so a drift there fails here.
function similarityWords(skeleton: string): Set<string> {
  return new Set(
    skeleton.split(/\s+/).filter((tok) => tok !== "{x}" && /[\p{L}\p{N}]/u.test(tok)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Footprint matches of this page's title/description/H1 skeletons against the rest of the
 *  portfolio: other identities only (a generated-history identity is never a Site.id, so the
 *  single check admits all generated rows), short skeletons skipped, ≤ maxMatches per kind. */
export function footprintHits(
  page: { siteId: string; url: string; title: string; description: string; h1: string; entities: string[] },
  items: FootprintItem[],
  opts?: { threshold?: number; minWords?: number; maxMatches?: number },
): FootprintHit[] {
  const threshold = opts?.threshold ?? SIMILARITY_THRESHOLD;
  const minWords = opts?.minWords ?? MIN_SKELETON_WORDS;
  const maxMatches = opts?.maxMatches ?? 5;

  const texts: [FootprintHit["kind"], string][] = [
    ["title", page.title],
    ["description", page.description],
    ["h1", page.h1],
  ];
  const out: FootprintHit[] = [];
  for (const [kind, text] of texts) {
    const value = String(text ?? "").trim();
    if (!value) continue;
    const skeleton = skeletonOf(value, page.entities);
    if (skeletonWordCount(skeleton) < minWords) continue;

    const mine = similarityWords(skeleton);
    const matches: { siteLabel: string; url: string; text: string; similarity: number }[] = [];
    for (const item of items) {
      if (item.kind !== kind || !item.skeleton) continue;
      if (item.identity === page.siteId) continue; // own site — not a footprint
      const sim = item.skeleton === skeleton ? 1 : jaccard(mine, similarityWords(item.skeleton));
      if (sim < threshold) continue;
      matches.push({
        siteLabel: item.label,
        url: item.example,
        text: item.skeleton,
        similarity: Math.round(sim * 100) / 100,
      });
    }
    matches.sort((a, b) => b.similarity - a.similarity || a.siteLabel.localeCompare(b.siteLabel));
    if (matches.length) out.push({ kind, skeleton, matches: matches.slice(0, maxMatches) });
  }
  return out;
}

// ── DB-bound ──

/** Everything the panel's OpenGSC tab needs beyond GET /api/ext/page. Local reads only. */
export async function pageInsights(userId: string, req: InsightsRequest): Promise<InsightsResponse> {
  const nu = normalizePageUrl(req.url);
  if (!nu) {
    return {
      inPortfolio: false, mainQuery: null, titleMatchesMainQuery: null, inSitemap: null,
      meta: { title: null, description: null }, footprint: [],
    };
  }

  const sites = await prisma.site.findMany({
    where: { userId },
    select: { id: true, siteId: true, url: true, brandedKeywords: true },
  });
  const site = matchPortfolioSite(sites, nu);
  if (!site) {
    return {
      inPortfolio: false, mainQuery: null, titleMatchesMainQuery: null, inSitemap: null,
      meta: { title: null, description: null }, footprint: [],
    };
  }

  const variants = urlVariants(nu);
  const since = new Date(Date.now() - EXT_QUERY_WINDOW_DAYS * 86_400_000);

  // ── the main query: DailyMetric rows of this page grouped by query, exactly like page/route.ts
  const rows = await prisma.dailyMetric.findMany({
    where: { siteId: site.id, url: { in: variants }, date: { gte: since }, query: { not: "" } },
    select: { query: true, clicks: true, impressions: true, position: true },
  });
  const byQuery = new Map<string, { clicks: number; impressions: number; posSum: number; n: number }>();
  for (const r of rows) {
    if (!r.query) continue;
    const cur = byQuery.get(r.query) ?? { clicks: 0, impressions: 0, posSum: 0, n: 0 };
    cur.clicks += r.clicks;
    cur.impressions += r.impressions;
    cur.posSum += r.position;
    cur.n++;
    byQuery.set(r.query, cur);
  }
  const mainQuery = pickMainQuery(
    [...byQuery.entries()].map(([query, v]) => ({
      query, clicks: v.clicks, impressions: v.impressions, position: Math.round((v.posSum / v.n) * 10) / 10,
    })),
  );

  // ── does the page name its main query? Same rule as the audit's title_query_mismatch.
  const titleMatchesMainQuery = mainQuery
    ? pageMatchesQuery(String(req.title ?? ""), String(req.h1 ?? ""), mainQuery.query)
    : null;

  // ── sitemap membership: true/false when the site has an inventory at all, null otherwise
  const [exact, anyInventory] = await Promise.all([
    prisma.sitemapUrl.findFirst({
      where: { siteId: site.id, url: { in: variants }, inventoryStatus: "active" },
      select: { id: true },
    }),
    prisma.sitemapUrl.findFirst({
      where: { siteId: site.id, inventoryStatus: "active" },
      select: { id: true },
    }),
  ]);
  const inSitemap = exact ? true : anyInventory ? false : null;

  // ── free meta suggestion: code-only, never an LLM call from here
  let meta: InsightsResponse["meta"] = { title: null, description: null };
  if (mainQuery) {
    const t = fitMetaLocal("title", String(req.title ?? ""), [], mainQuery.query);
    const d = fitMetaLocal("description", String(req.description ?? ""), [], mainQuery.query);
    meta = { title: t.inBand ? null : t, description: d.inBand ? null : d };
  }

  // ── footprint across the portfolio (collectPortfolio has its own cache)
  let footprint: FootprintHit[] = [];
  try {
    const portfolio = await collectPortfolio(userId);
    footprint = footprintHits(
      {
        siteId: site.id,
        url: nu.href,
        title: String(req.title ?? ""),
        description: String(req.description ?? ""),
        h1: String(req.h1 ?? ""),
        entities: siteEntities(site.url, site.brandedKeywords),
      },
      portfolio.items,
    );
  } catch {
    footprint = []; // a missing footprint table must not cost the tab the rest of its data
  }

  return { inPortfolio: true, mainQuery, titleMatchesMainQuery, inSitemap, meta, footprint };
}
