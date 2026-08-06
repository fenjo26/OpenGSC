// MCP tools for Demand — keyword discovery, and the only place in this registry where an agent
// can spend money on something other than an AI model.
//
// `toolsMetrics.ts` states the opposite rule for its own tools, and the distinction is worth
// spelling out rather than leaving as an apparent inconsistency. Those tools read a cache that a
// human filled by pressing a button; letting an agent refill it would mean paying Ahrefs to
// answer a question nobody asked. Discovery is different in one specific way: **the result is
// written to the cache before the tool returns**. A client that gives up waiting has still
// bought something permanent — the same search replays for free from `DemandSearch`, in the web
// UI as well as here. Nothing is lost the way an abandoned synchronous rewrite loses an article.
//
// That is what makes this tool synchronous where `start_rewrite_job` had to be asynchronous. It
// is one HTTP call in the common case and three in the worst, not a multi-minute pipeline.
//
// The free path still comes first, and both descriptions say so:
//
//   get_keyword_demand  → what has already been researched, plus this site's own GSC position
//                         on those terms. Free, instant, and often the whole answer.
//   research_keywords   → PAID. Only when the seed has never been researched.

import { prisma } from "@/lib/prisma";
import { McpTool, Json, lim, resolveSite, siteArg, normDomain, getUserSettings } from "./shared";
import {
  estimateDemandCost, providerFor,
  type DemandMode, type DemandRow,
} from "@/lib/seo/demand";
import { expandKeywords, type KwSource } from "@/lib/seo/keywordSource";
import { writeKeywordCache, normalizeKeyword, recordUsage } from "@/lib/seo/metricsStore";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";

/** Mirrors `/api/demand/keywords`, which owns the canonical values. */
const SEARCH_TTL_DAYS = 14;
const GSC_LOOKBACK_DAYS = 90;
const REACH_POSITION = 30;
const UNITS_PER_USD = 1000;
const PROVIDER = "dataforseo";

type Verdict = "reach" | "wrong_page" | "none";

/**
 * The DataForSEO credential from the server-side settings mirror.
 *
 * An MCP request has no browser and therefore no localStorage, so the key can only come from
 * `User.seoSettings` — the same snapshot digest-cron and rank-cron already read. An instance
 * whose owner has never opened Settings will not have one, and that is a normal state to
 * report, not an error to throw.
 */
async function resolveDfsKey(userId: string, args: Json = {}): Promise<string> {
  const explicit = String(args.apiKey ?? "").trim();
  if (explicit) return explicit;
  const s = await getUserSettings(userId);
  return String(s.seoKey_dataforseo ?? s.dataforseoKey ?? "").trim();
}

/**
 * Which provider answers `research_keywords`, resolved from the same mirrored settings the web UI
 * writes.
 *
 * The tool used to be DataForSEO or nothing, which meant an instance paying for Ahrefs could not
 * research a keyword through an agent at all. The order matches `getKeywordSource()` in the
 * browser — Ahrefs, then Semrush, then DataForSEO — so the agent and the UI never disagree about
 * whose credits are being spent.
 *
 * `args.source` lets a caller pin one deliberately; anything else falls through the chain.
 */
async function resolveKwSource(
  userId: string, args: Json = {},
): Promise<{ source: KwSource; apiKey: string; baseUrl?: string }> {
  const s = await getUserSettings(userId);

  const metricsKey = (p: "ahrefs" | "semrush") => {
    const mode = String(s[`seoMetricsMode_${p}`] ?? "");
    const suffixed = mode === "reseller" || mode === "custom" ? `seoKey_${p}__${mode}` : `seoKey_${p}`;
    return String(s[suffixed] ?? s[`seoKey_${p}`] ?? "").trim();
  };
  const metricsHost = (p: "ahrefs" | "semrush") =>
    String(s[`seoMetricsBaseUrl_${p}`] ?? "").trim() || undefined;

  const pinned = String(args.source ?? "").trim().toLowerCase();
  const chain: KwSource[] = pinned === "ahrefs" || pinned === "semrush" || pinned === "dataforseo"
    ? [pinned as KwSource]
    : ["ahrefs", "semrush", "dataforseo"];

  for (const c of chain) {
    if (c === "dataforseo") {
      const k = await resolveDfsKey(userId, args);
      if (k) return { source: "dataforseo", apiKey: k };
      continue;
    }
    const k = metricsKey(c as "ahrefs" | "semrush");
    if (k.length > 4) return { source: c, apiKey: k, baseUrl: metricsHost(c as "ahrefs" | "semrush") };
  }
  return { source: "off", apiKey: "" };
}

/**
 * Spending gate, separate from `assertConfirmed` in shared.ts because the sentence has to be
 * true: this spends DataForSEO credits, not AI credits, and it points at a different free
 * alternative. An agent that reads a refusal naming the wrong provider will ask the user the
 * wrong question.
 */
function assertResearchConfirmed(args: Json): void {
  if (args.confirm === true) return;
  throw new Error(
    "research_keywords spends the instance owner's own DataForSEO credits, so it will not run unconfirmed. " +
    "Ask the user for permission first, then call again with confirm: true. " +
    "Before doing that, call get_keyword_demand: if this seed has been researched in the last 14 days the " +
    "answer is already stored and free, and get_striking_distance covers the queries the site already ranks for.",
  );
}

/**
 * The site's own side of the join: best average position per query over the last 90 days.
 *
 * Identical in shape to `get_competitor_gap` and to the web route, and recomputed every time for
 * the same reason — the external keyword list moves in weeks, GSC moves daily, and freezing the
 * join would mean re-buying the external half whenever your own rank changed.
 */
async function ourQueries(siteId: string) {
  const out = new Map<string, { position: number; url: string; impressions: number }>();
  try {
    const since = new Date();
    since.setDate(since.getDate() - GSC_LOOKBACK_DAYS);
    const rows = await prisma.dailyMetric.groupBy({
      by: ["query", "url"],
      where: { siteId, date: { gte: since } },
      _sum: { impressions: true },
      _avg: { position: true },
    });
    for (const r of rows) {
      const q = String(r.query ?? "").trim().toLowerCase();
      if (!q) continue;
      const pos = Number(r._avg.position ?? 0);
      const prev = out.get(q);
      if (!prev || pos < prev.position) {
        out.set(q, {
          position: pos,
          url: String(r.url ?? ""),
          impressions: Number(r._sum.impressions ?? 0),
        });
      }
    }
  } catch { /* no GSC data — every row reads as "none", which is the honest answer */ }
  return out;
}

function decorate(rows: DemandRow[], ours: Map<string, { position: number; url: string; impressions: number }>) {
  return rows.map(r => {
    const mine = ours.get(normalizeKeyword(r.keyword));
    const ourPosition = mine ? Math.round(mine.position * 10) / 10 : null;
    const verdict: Verdict =
      ourPosition == null ? "none" : ourPosition <= REACH_POSITION ? "reach" : "wrong_page";
    return {
      keyword: r.keyword,
      volume: r.volume,
      difficulty: r.difficulty,
      cpc: r.cpc,
      intent: r.intent,
      trend: r.trend,
      ourPosition,
      ourUrl: mine?.url ?? null,
      ourImpressions: mine?.impressions ?? 0,
      verdict,
    };
  });
}

const countVerdicts = (rows: { verdict: Verdict }[]) => ({
  reach: rows.filter(r => r.verdict === "reach").length,
  wrong_page: rows.filter(r => r.verdict === "wrong_page").length,
  none: rows.filter(r => r.verdict === "none").length,
});

const VERDICT_LEGEND = {
  reach: "You rank in the top 30 for this — the page exists and is findable. Improve it; the URL is in ourUrl.",
  wrong_page: "You appear for this but far down. Something on the site touches the topic without being treated as the answer — usually an intent mismatch, not a quality problem.",
  none: "Search Console has never shown you for this query. Net-new content.",
};

// Provider goes in as a KEY PREFIX rather than a column, following the `llm:` convention
// `api/aeo/mentions` already established in this same table. Two providers answering the same seed
// are different purchases with different numbers, and a shared key would let one overwrite the
// other. A prefix needs no migration; a column would.
const cacheKeyFor = (seed: string, country: string, language: string, mode: string, limit: number, clickstream: boolean, source = "dataforseo") =>
  `${source}:${normalizeKeyword(seed)}|${country}|${language}|${mode}|${limit}|${clickstream ? 1 : 0}`;

export const DEMAND_TOOLS: McpTool[] = [
  {
    name: "get_keyword_demand",
    description:
      "Keyword research already stored on this instance, joined against a site's own Search Console positions. " +
      "Free and instant. Call this BEFORE research_keywords: a seed researched in the last 14 days is answered " +
      "here at no cost. Each row carries a verdict — reach (you rank top 30, improve the page), wrong_page " +
      "(impressions but nothing winning), none (write it). With no seed, lists the searches that have been run. " +
      "An empty result means nobody has researched this seed yet; it is not evidence that the market is empty.",
    cost: "local",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "string", description: "Seed keyword to look up. Omit to list stored searches instead." },
        site: { ...siteArg, description: `${siteArg.description} Optional — without it, rows carry market data but no verdict.` },
        country: { type: "string", description: "Market, 2-letter code. Default us" },
        verdict: { type: "string", description: "Filter rows: reach | wrong_page | none" },
        limit: { type: "number", description: "Max rows (default 100, max 500)" },
      },
    },
    handler: async (userId, args) => {
      const seed = String(args.seed ?? "").trim();
      const country = String(args.country ?? "us").toLowerCase();
      const limit = lim(args.limit, 100, 500);

      // No seed: an index of what has been bought, so an agent can see the shape of existing
      // research before deciding anything costs money.
      if (!seed) {
        let searches: any[] = [];
        try {
          searches = await rawQuery(
            `SELECT seed, country, language, mode, source, createdAt FROM "DemandSearch"
              WHERE userId = ? ORDER BY createdAt DESC LIMIT 100`,
            userId,
          );
        } catch { searches = []; }
        return {
          searches: searches.map(s => ({ ...s, createdAt: new Date(s.createdAt).toISOString() })),
          note: searches.length
            ? "Pass one of these seeds to get its rows back for free."
            : "No keyword research stored yet. research_keywords is the only way to create some, and it is PAID.",
        };
      }

      let hit: any;
      try {
        const rows: any[] = await rawQuery(
          `SELECT rows, source, mode, language, createdAt FROM "DemandSearch"
            WHERE userId = ? AND seed = ? AND country = ?
            ORDER BY createdAt DESC LIMIT 1`,
          userId, normalizeKeyword(seed), country,
        );
        hit = rows?.[0];
      } catch { hit = null; }

      if (!hit) {
        return {
          seed, country, rows: [],
          note: "This seed has not been researched for this market. research_keywords can fetch it, but it is PAID and needs confirm: true.",
        };
      }

      const ageDays = Math.floor((Date.now() - new Date(hit.createdAt).getTime()) / 86_400_000);
      const stored: DemandRow[] = JSON.parse(hit.rows);

      const site = args.site ? await resolveSite(userId, args.site) : null;
      const rows = decorate(stored, site ? await ourQueries(site.id) : new Map());

      const wanted = String(args.verdict ?? "").toLowerCase();
      const filtered = ["reach", "wrong_page", "none"].includes(wanted)
        ? rows.filter(r => r.verdict === wanted)
        : rows;

      return {
        seed, country,
        target: site ? normDomain(site.url) : null,
        source: hit.source, mode: hit.mode, language: hit.language,
        researchedAt: new Date(hit.createdAt).toISOString(),
        ageDays,
        stale: ageDays > SEARCH_TTL_DAYS,
        counts: site ? countVerdicts(rows) : undefined,
        legend: site ? VERDICT_LEGEND : undefined,
        rows: filtered.slice(0, limit),
        note: site ? undefined : "No site given, so every verdict is 'none' by default — pass `site` to get the Search Console half of the answer.",
      };
    },
  },

  {
    name: "research_keywords",
    description:
      "PAID — spends the owner's own DataForSEO credits. Discovers what a market searches for from one seed " +
      "keyword, then joins it against a site's Search Console history so every row says whether you already " +
      "rank (reach), appear without ranking (wrong_page), or are absent (none). " +
      "Call get_keyword_demand first: a seed researched in the last 14 days comes back from cache for free, and " +
      "get_striking_distance already covers queries the site ranks for without spending anything. " +
      "Roughly $0.03 per call at the default 150 rows. Results are stored before this returns, so a client " +
      "timeout costs nothing — the same call replays from cache.",
    cost: "paid",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "string", description: "The seed keyword to research" },
        site: { ...siteArg, description: `${siteArg.description} Optional — without it there is no Search Console half and no verdicts.` },
        country: { type: "string", description: "Market, 2-letter code. Default us" },
        language: { type: "string", description: "Language code. Default en" },
        mode: {
          type: "string",
          description:
            "auto (default) walks related → suggestions → ideas and stops at the first source with enough terms. " +
            "related = semantic neighbours, suggestions = long tail containing the seed, ideas = same meaning, " +
            "different words. Auto is one billed call, not three.",
        },
        limit: { type: "number", description: "Rows to request (default 150, max 1000). Billed per row returned." },
        clickstream: { type: "boolean", description: "Clickstream-refined volumes. DOUBLES the cost and changes nothing else. Default false." },
        confirm: {
          type: "boolean",
          description: "Must be true. PAID: this spends the instance owner's own DataForSEO credits — get their permission before setting it.",
        },
      },
      required: ["seed", "confirm"],
    },
    handler: async (userId, args) => {
      assertResearchConfirmed(args);

      const seed = String(args.seed ?? "").trim();
      if (!seed) throw new Error("Missing required argument: seed");

      const country = String(args.country ?? "us").toLowerCase();
      const language = String(args.language ?? "en").toLowerCase();
      const mode = (["auto", "related", "suggestions", "ideas"].includes(String(args.mode))
        ? String(args.mode) : "auto") as DemandMode;
      const limit = lim(args.limit, 150, 1000);
      const clickstream = args.clickstream === true;

      const kw = await resolveKwSource(userId, args);
      if (kw.source === "off" || !kw.apiKey) {
        throw new Error(
          "No keyword data source is configured on this instance. The owner adds an Ahrefs, Semrush or " +
          "DataForSEO key under Settings → SEO Metrics; until then, get_keyword_demand and " +
          "get_striking_distance are the free sources of keyword data.",
        );
      }

      const site = args.site ? await resolveSite(userId, args.site) : null;

      // Cache check before spending, even though the caller was told to do it. An agent that
      // skipped the free tool should not be billed for the omission.
      const key = cacheKeyFor(seed, country, language, mode, limit, clickstream, kw.source);
      try {
        const cached: any[] = await rawQuery(
          `SELECT rows, source, createdAt FROM "DemandSearch" WHERE userId = ? AND cacheKey = ?`,
          userId, key,
        );
        const hit = cached?.[0];
        if (hit && Date.now() - new Date(hit.createdAt).getTime() < SEARCH_TTL_DAYS * 86_400_000) {
          const rows = decorate(JSON.parse(hit.rows) as DemandRow[], site ? await ourQueries(site.id) : new Map());
          return {
            seed, country, language, mode,
            target: site ? normDomain(site.url) : null,
            source: hit.source,
            spentUsd: 0,
            fromCache: true,
            counts: countVerdicts(rows),
            legend: VERDICT_LEGEND,
            rows: rows.slice(0, 500),
            note: "Served from cache — this call cost nothing.",
          };
        }
      } catch { /* table missing until prisma db push; fall through and fetch */ }

      // Through the shared source, so Ahrefs and Semrush answer here exactly as they do in the UI.
      // `mode` and `clickstream` are DataForSEO-only concepts and are simply ignored elsewhere —
      // reported back in the response so the caller can see what was actually honoured.
      const provider = providerFor(country);
      const res = await expandKeywords(kw, seed, {
        country, language, limit, withDifficulty: args.withDifficulty === true, fetch: true,
      });

      if (res.error && !res.rows.length) throw new Error(`Keyword research failed: ${res.error}`);

      // Charged, stored, and mirrored into the shared metric cache — in that order, and all
      // before returning, so an abandoned call still leaves the instance better off.
      // DataForSEO bills dollars and is converted at a fixed rate; Ahrefs and Semrush bill units
      // directly, so those are recorded as-is rather than round-tripped through a currency.
      const units = kw.source === "dataforseo"
        ? Math.max(1, Math.round((res.usd || estimateDemandCost(provider, limit, clickstream)) * UNITS_PER_USD))
        : Math.max(1, res.units);
      try {
        // Through the shared recorder rather than its own copy of the statement: the web route
        // and this tool spend from the same monthly budget, and two hand-written versions of
        // "add to this month's total" is how they drift apart.
        await recordUsage(userId, kw.source, units);
        await runUpsert({
          table: "DemandSearch",
          conflict: ["userId", "cacheKey"],
          values: {
            userId, cacheKey: key, seed: normalizeKeyword(seed), country, language,
            mode, source: res.source,
            rows: JSON.stringify(res.rows), createdAt: new Date().toISOString(),
          },
          update: { source: "set", rows: "set", createdAt: "set" },
        });
      } catch { /* pre-migration instance: the result is still returned, just not remembered */ }

      // The shared metric cache is written by `expandKeywords` itself, under whichever provider
      // actually answered. Repeating it here would file the same rows a second time under a
      // hardcoded "dataforseo" and make an Ahrefs purchase look like a DataForSEO one.

      const rows = decorate(res.rows, site ? await ourQueries(site.id) : new Map());

      return {
        seed, country, language, mode,
        target: site ? normDomain(site.url) : null,
        source: res.source,
        spentUsd: Math.round(res.usd * 10000) / 10000,
        units: res.units,
        fromCache: false,
        counts: countVerdicts(rows),
        legend: VERDICT_LEGEND,
        rows: rows.slice(0, 500),
        note: provider === "google_ads"
          ? "This country is served by Google Ads data: difficulty and intent are null for every row, and that is a coverage limit rather than a missing value."
          : undefined,
      };
    },
  },
];
