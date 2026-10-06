// Bootstrap proposals for an empty site context — the "first contact" moment.
//
// A brand-new site in the context store answers "we know nothing" to every agent. But the
// instance itself often already knows plenty: GSC's own top pages, the competitor scans the
// gap tool stored, the size of the sitemap. On an EMPTY context this module turns that local
// data into SUGGESTIONS — never writes: unreviewed rows are exactly the "agent beliefs nobody
// confirmed" the Context card exists to prevent. The agent (or the operator, from the card)
// confirms and writes through the normal update path.
//
// Everything here is local SQL over data the app already synced — no network, no units.

import { rawQuery } from "@/lib/db/raw";
import type { SiteContext } from "./store";

export interface SuggestedKeyPage {
  url: string;
  role: "hub" | "other";
  clicks: number;
  impressions: number;
}

export interface SuggestedCompetitor {
  domain: string;
  keywords: number;
}

export interface ContextBootstrap {
  suggestedKeyPages: SuggestedKeyPage[];
  suggestedCompetitors: SuggestedCompetitor[];
  sitemapUrls: number;
}

/** True when there is nothing worth reading: no filled section, no key page, no competitor.
 *  Pure, so the MCP tool and the API route agree on when to attach a bootstrap. */
export function contextIsEmpty(ctx: Pick<SiteContext, "sections" | "keyPages" | "competitors">): boolean {
  const hasContent = ctx.sections.some(s => s.content.trim());
  return !hasContent && ctx.keyPages.length === 0 && ctx.competitors.length === 0;
}

/** Root page is the hub by definition; everything else starts as "other" and is the agent's
 *  (or the operator's) call to re-role. A guess labelled as a guess is fine; a confident
 *  wrong "money" on a suggestion is not. */
export function inferKeyPageRole(url: string): "hub" | "other" {
  try {
    const path = /^https?:\/\//i.test(url) ? new URL(url).pathname : url;
    return (path.replace(/\/+$/, "") || "/") === "/" ? "hub" : "other";
  } catch {
    return "other";
  }
}

export async function bootstrapSuggestions(siteId: string): Promise<ContextBootstrap> {
  const since = new Date(Date.now() - 90 * 86_400_000);
  const empty: ContextBootstrap = { suggestedKeyPages: [], suggestedCompetitors: [], sitemapUrls: 0 };

  const [pages, competitors, sitemap] = await Promise.all([
    // The site's own top pages by clicks over 90 days — the honest shortlist of what matters.
    // Rollup rows (url='') are excluded: they carry the daily totals, not pages.
    rawQuery<Array<{ url: string; clicks: number | bigint; impressions: number | bigint }>>(
      `SELECT "url" AS url, SUM("clicks") AS clicks, SUM("impressions") AS impressions
       FROM "DailyMetric"
       WHERE "siteId" = ? AND "searchType" = 'web' AND "url" <> '' AND "date" >= ?
       GROUP BY "url" ORDER BY clicks DESC, impressions DESC LIMIT 10`,
      siteId, since,
    ).catch(() => [] as Array<{ url: string; clicks: number | bigint; impressions: number | bigint }>),
    // Competitors the gap tool already scanned — ranked by keyword overlap, not invented.
    rawQuery<Array<{ competitor: string; kw: number | bigint }>>(
      `SELECT "competitor" AS competitor, COUNT(DISTINCT "keyword") AS kw
       FROM "CompetitorKeyword" WHERE "siteId" = ?
       GROUP BY "competitor" ORDER BY kw DESC LIMIT 5`,
      siteId,
    ).catch(() => [] as Array<{ competitor: string; kw: number | bigint }>),
    rawQuery<Array<{ n: number | bigint }>>(
      `SELECT COUNT(*) AS n FROM "SitemapUrl" WHERE "siteId" = ?`,
      siteId,
    ).catch(() => [] as Array<{ n: number | bigint }>),
  ]);

  return {
    suggestedKeyPages: (pages ?? []).map(p => ({
      url: String(p.url),
      role: inferKeyPageRole(String(p.url)),
      clicks: Number(p.clicks ?? 0),
      impressions: Number(p.impressions ?? 0),
    })),
    suggestedCompetitors: (competitors ?? []).map(c => ({
      domain: String(c.competitor),
      keywords: Number(c.kw ?? 0),
    })),
    sitemapUrls: Number(sitemap?.[0]?.n ?? 0),
  };
}
