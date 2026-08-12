import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import {
  fetchKeywordMetrics, estimateKeywordUnits, MetricsProvider,
} from "@/lib/seo/metrics";
import {
  readKeywordCache, writeKeywordCache, staleKeywords, readUsage, recordUsage, withinCap,
  normalizeKeyword,
} from "@/lib/seo/metricsStore";
import { marketFor } from "@/lib/seo/market";

// POST /api/metrics/warmup
//   { scope: "all" | "site" | "tag", siteId?, tag?, days?, positionFrom?, positionTo?,
//     minImpressions?, limit?, withDifficulty?, provider?, apiKey?, baseUrl?, cap?, fetch? }
//
// Loads keyword weights for a whole cohort in one request, instead of one screen at a time.
//
// The reason this endpoint exists rather than "just press Load weights on each page": a portfolio
// of 200 sites has thousands of striking-distance queries, and Ahrefs bills `max(50, cost × rows)`.
// Fetching them per page multiplies the 50-unit floor by the number of pages; fetching them in one
// batch pays it once. The difference is roughly the price of the whole exercise.
//
// Markets are resolved per site, never assumed. `marketFor` returns null for a generic TLD with no
// market set, and those sites are reported as skipped rather than folded into `us` — filing a
// Bosnian keyword under the American market spends real money to produce a row nothing will read.
//
// Same two call shapes as `/api/metrics/keywords`:
//   fetch: false — count and price the work. Free, and the only thing the button needs to render.
//   fetch: true  — charge the cap and buy the missing rows.

const MAX_KEYWORDS = 3000;

interface Cohort {
  /** country → keywords needing weights in that market */
  byCountry: Map<string, Set<string>>;
  sitesScanned: number;
  /** Sites whose market could not be resolved: counted, named, and never guessed. */
  skippedSites: string[];
  totalQueries: number;
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const scope = ["all", "site", "tag"].includes(String(b.scope)) ? String(b.scope) : "all";
  const days = Math.min(365, Math.max(7, Number(b.days ?? 90)));
  const positionFrom = Math.max(1, Number(b.positionFrom ?? 4));
  const positionTo = Math.min(100, Number(b.positionTo ?? 20));
  const minImpressions = Math.max(1, Number(b.minImpressions ?? 10));
  const limit = Math.min(MAX_KEYWORDS, Math.max(10, Number(b.limit ?? 1000)));
  const withDifficulty = !!b.withDifficulty;
  const provider = (b.provider === "semrush" ? "semrush" : "ahrefs") as MetricsProvider;
  const wantFetch = !!b.fetch;
  const apiKey = String(b.apiKey ?? "").trim();
  const baseUrl = String(b.baseUrl ?? "").trim() || undefined;
  const cap = Number(b.cap ?? 0);

  // ── Which sites are in scope ──
  const where: any = { userId, archivedAt: null };
  if (scope === "site") {
    if (!b.siteId) return NextResponse.json({ error: "no_site" }, { status: 400 });
    where.id = String(b.siteId);
  }

  const sites = await prisma.site.findMany({
    where,
    select: { id: true, url: true, siteId: true, market: true, tags: true },
  });

  const tag = String(b.tag ?? "").trim().toLowerCase();
  const inScope = scope === "tag" && tag
    ? sites.filter(s => siteTags(s.tags).includes(tag))
    : sites;

  if (!inScope.length) return NextResponse.json({ error: "no_sites" }, { status: 400 });

  const cohort = await collectCohort(inScope, { days, positionFrom, positionTo, minImpressions, limit });

  // ── Price it, per market, against what is already cached ──
  const perCountry: { country: string; total: number; missing: number; units: number }[] = [];
  const missingByCountry = new Map<string, string[]>();

  for (const [country, set] of cohort.byCountry) {
    const keywords = [...set];
    const cache = await readKeywordCache(keywords, country, provider);
    const stale = staleKeywords(keywords, cache, { needDifficulty: withDifficulty });
    missingByCountry.set(country, stale);
    perCountry.push({
      country,
      total: keywords.length,
      missing: stale.length,
      // Zero missing costs zero: the 50-unit floor makes a "just to be safe" call a real charge.
      units: stale.length ? estimateKeywordUnits(stale.length, withDifficulty) : 0,
    });
  }
  perCountry.sort((a, z) => z.missing - a.missing);

  const units = perCountry.reduce((n, c) => n + c.units, 0);
  const usage = await readUsage(userId, provider);

  const summary = {
    scope,
    sitesScanned: cohort.sitesScanned,
    skippedSites: cohort.skippedSites,
    totalQueries: cohort.totalQueries,
    markets: perCountry,
    units,
    usage,
  };

  if (!wantFetch) {
    return NextResponse.json({ ...summary, fetched: 0, ...(apiKey ? {} : { error: "no_key" }) });
  }
  if (!apiKey) return NextResponse.json({ ...summary, fetched: 0, error: "no_key" }, { status: 400 });
  if (!units) return NextResponse.json({ ...summary, fetched: 0, fromCache: true });

  // Charged before the calls, exactly as the per-page loader does: the price is fully known from
  // the field selection and the row count, and a cap that notices afterwards is not a cap.
  if (!(await withinCap(userId, provider, units, cap))) {
    return NextResponse.json({ ...summary, fetched: 0, error: "cap_exceeded", wouldSpend: units }, { status: 429 });
  }
  await recordUsage(userId, provider, units);

  let fetched = 0;
  const errors: string[] = [];

  // Sequential across markets on purpose. The client already caps itself at three concurrent
  // requests per key, and a portfolio warm-up is the one caller big enough to sit in that queue
  // for minutes — running markets in parallel would only reorder the same wait.
  for (const [country, stale] of missingByCountry) {
    if (!stale.length) continue;
    const res = await fetchKeywordMetrics({ provider, apiKey, baseUrl }, stale, { country, withDifficulty });
    if (res.error) { errors.push(`${country}: ${res.error}`); continue; }
    await writeKeywordCache(res.items, country, provider, "api");
    fetched += res.items.length;
  }

  return NextResponse.json({
    ...summary,
    usage: await readUsage(userId, provider),
    fetched,
    ...(errors.length ? { error: errors.join("; ") } : {}),
  });
}

/** Site.tags is either a JSON array or a comma-separated string, depending on when it was written. */
function siteTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(x => String(x).trim().toLowerCase()).filter(Boolean);
  } catch { /* fall through to CSV */ }
  return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * The striking-distance queries of every in-scope site, bucketed by the site's market.
 *
 * Grouped per site rather than in one query across all of them, because the market is a property
 * of the site and the same phrase can legitimately belong to two markets at once — "transfer
 * thessaloniki" is a Greek keyword on a `.gr` site and a British one on a `.uk` site, and they
 * carry different volumes and different cache rows.
 */
async function collectCohort(
  sites: { id: string; url: string; siteId: string; market: string | null }[],
  o: { days: number; positionFrom: number; positionTo: number; minImpressions: number; limit: number },
): Promise<Cohort> {
  const since = new Date();
  since.setDate(since.getDate() - o.days);

  const byCountry = new Map<string, Set<string>>();
  const skippedSites: string[] = [];
  let totalQueries = 0;
  let sitesScanned = 0;
  let budget = o.limit;

  for (const site of sites) {
    if (budget <= 0) break;

    const country = marketFor(site);
    if (!country) { skippedSites.push(site.url); continue; }

    const rows = await prisma.dailyMetric.groupBy({
      by: ["query"],
      where: {
        siteId: site.id,
        date: { gte: since },
        position: { gte: o.positionFrom, lte: o.positionTo },
      },
      _sum: { impressions: true },
      having: { impressions: { _sum: { gte: o.minImpressions } } },
      orderBy: { _sum: { impressions: "desc" } },
      take: Math.min(budget, 500),
    });

    sitesScanned++;
    const set = byCountry.get(country) ?? new Set<string>();
    for (const r of rows as unknown as { query: string }[]) {
      const kw = normalizeKeyword(String(r.query ?? ""));
      // Ahrefs takes keywords as a comma-separated list, so a keyword containing a comma cannot
      // be expressed. Dropping it here keeps the estimate honest rather than promising a row the
      // provider layer will silently discard.
      if (!kw || kw.includes(",")) continue;
      if (!set.has(kw)) { set.add(kw); totalQueries++; budget--; }
      if (budget <= 0) break;
    }
    byCountry.set(country, set);
  }

  return { byCountry, sitesScanned, skippedSites, totalQueries };
}
