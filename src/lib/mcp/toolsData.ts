// MCP tools for the app surfaces that live outside the GSC core (tools.ts).
//
// Everything here is read-only. Most of it is a Prisma read over data the app has
// already synced; the two exceptions are labeled in their descriptions and in `cost`:
// get_analytics calls GA4 on the user's own OAuth (quota), and get_engine_performance
// can hit Bing/Yandex live when the cached snapshot is cold.
//
// These reimplement the computation of their `/api/**` counterparts rather than calling
// them over HTTP: those routes authenticate with a session cookie, which an MCP request
// does not have, and an internal fetch to your own server just to re-authenticate is a
// deadlock waiting for a single-process deployment under load.

import { prisma } from "@/lib/prisma";
import { google } from "googleapis";
import {
  McpTool, type Json, lim, pct, r1, sinceDate, resolveSite, resolveSites,
  siteArg, siteOrAllArg, parseJson, getUserSettings, normDomain,
} from "./shared";
import { makeOAuth2, dateWindows, GA4_API_METRICS, type GoogleAccount } from "@/lib/ga4";
import { aggregateSnapshots } from "@/lib/clarityParse";
import { rawQuery } from "@/lib/db/raw";

// ─── decay bucketing (mirrors /api/gsc/decay) ───────────────────────────────────

function buildBuckets(type: "month" | "week", count: number) {
  const now = new Date();
  const buckets: { label: string; start: Date; end: Date }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    if (type === "month") {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({
        label: `${d.toLocaleDateString("en-US", { month: "short" })} ${d.getFullYear()}`,
        start: new Date(d.getFullYear(), d.getMonth(), 1),
        end: new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59),
      });
    } else {
      const ref = new Date(now);
      ref.setDate(ref.getDate() - i * 7);
      const day = ref.getDay();
      const mon = new Date(ref); mon.setDate(ref.getDate() - (day === 0 ? 6 : day - 1)); mon.setHours(0, 0, 0, 0);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6); sun.setHours(23, 59, 59);
      buckets.push({ label: ref.toLocaleDateString("en-US", { month: "short", day: "numeric" }), start: mon, end: sun });
    }
  }
  return buckets;
}

const bucketIndex = (date: Date, buckets: { start: Date; end: Date }[]): number => {
  const t = date.getTime();
  return buckets.findIndex(b => t >= b.start.getTime() && t <= b.end.getTime());
};

// CTR by position, Backlinko 2023 — the same table the CTR Benchmark tab uses.
const CTR_BENCHMARKS: Record<number, number> = {
  1: 27.6, 2: 15.8, 3: 11.0, 4: 8.4, 5: 6.3, 6: 4.9, 7: 3.9, 8: 3.3, 9: 2.7, 10: 2.4,
};

// ─── tools ──────────────────────────────────────────────────────────────────────

export const DATA_TOOLS: McpTool[] = [
  {
    name: "get_content_decay",
    cost: "local",
    description:
      "Content Decay: pages whose traffic is trending DOWN, with the per-bucket history behind the verdict. Compares the last 2 buckets against the 2 before them; a drop past 5% is Warning, past 25% is Critical. This is the primary way to find pages that need refreshing — feed a decaying URL straight into get_optimization_brief.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteOrAllArg,
        metric: { type: "string", enum: ["clicks", "impressions"], description: "Which metric decays (default clicks)" },
        period: { type: "string", enum: ["month", "week"], description: "Bucket size (default month)" },
        buckets: { type: "number", description: "How many buckets of history (default 16, min 4, max 24)" },
        limit: { type: "number", description: "How many top pages to examine (default 20, max 50)" },
      },
    },
    handler: async (userId, args) => {
      const sites = await resolveSites(userId, args.site);
      if (!sites.length) return { decay: [], note: "No sites connected." };
      const siteIds = sites.map(s => s.id);
      const siteMap = new Map(sites.map(s => [s.id, s]));
      const metric = args.metric === "impressions" ? "impressions" : "clicks";
      const cols = Math.min(24, Math.max(4, parseInt(String(args.buckets ?? 16), 10) || 16));
      const topN = lim(args.limit, 20, 50);
      const buckets = buildBuckets(args.period === "week" ? "week" : "month", cols);
      const rangeStart = buckets[0].start;
      const rangeEnd = buckets[buckets.length - 1].end;

      // query='' keeps this at URL-level rows; the url='' row is the site-level aggregate.
      // orderBy is spelled out per branch rather than built with a computed key: Prisma's
      // groupBy overload can't resolve a dynamic one and silently falls back to `string`,
      // which turns every downstream row into `any`.
      const top = await prisma.dailyMetric.groupBy({
        by: ["siteId", "url"],
        where: { siteId: { in: siteIds }, query: "", date: { gte: rangeStart, lte: rangeEnd } },
        _sum: { clicks: true, impressions: true },
        orderBy: metric === "impressions" ? { _sum: { impressions: "desc" } } : { _sum: { clicks: "desc" } },
        take: topN * 2,
      });
      const urls = top.filter(u => u.url !== "").slice(0, topN);
      if (!urls.length) return { sites: sites.map(s => s.url), decay: [], note: "No page-level metrics in this window yet — run a GSC sync." };

      const records = await prisma.dailyMetric.findMany({
        where: { siteId: { in: siteIds }, url: { in: urls.map(u => u.url) }, query: "", date: { gte: rangeStart, lte: rangeEnd } },
        select: { siteId: true, url: true, date: true, clicks: true, impressions: true },
      });

      const series = new Map<string, number[]>();
      for (const u of urls) series.set(`${u.siteId}::${u.url}`, new Array(cols).fill(0));
      for (const rec of records) {
        const arr = series.get(`${rec.siteId}::${rec.url}`);
        if (!arr) continue;
        const idx = bucketIndex(new Date(rec.date), buckets);
        if (idx >= 0) arr[idx] += metric === "clicks" ? rec.clicks : rec.impressions;
      }

      const pages = urls.map(u => {
        const vals = series.get(`${u.siteId}::${u.url}`)!;
        const curr = vals.slice(-2).reduce((a, b) => a + b, 0);
        const prev = vals.slice(-4, -2).reduce((a, b) => a + b, 0);
        const changePct = prev > 0 ? Math.round(((curr - prev) / prev) * 100) : 0;
        return {
          site: siteMap.get(u.siteId)?.url ?? "",
          url: u.url,
          current: curr,
          previous: prev,
          changePercent: changePct,
          status: changePct <= -25 ? "Critical" : changePct <= -5 ? "Warning" : "Stable",
          history: vals,
        };
      });

      return {
        sites: sites.map(s => s.url),
        metric,
        buckets: buckets.map(b => b.label),
        decay: pages.filter(p => p.status !== "Stable" && !(p.current === 0 && p.previous === 0))
          .sort((a, b) => a.changePercent - b.changePercent),
        stable: pages.filter(p => p.status === "Stable").length,
      };
    },
  },

  {
    name: "get_ctr_benchmark",
    cost: "local",
    description:
      "CTR Benchmark: for queries already ranking in the top 10, the page's real CTR against the industry-standard CTR for that position (Backlinko 2023). A large negative `diff` means the ranking is fine but the search snippet is not — a title/meta rewrite, not a content rewrite. Sorted worst-first by default.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        days: { type: "number", description: "Lookback window in days (default 90, max 365)" },
        minImpressions: { type: "number", description: "Minimum summed impressions per query/page pair (default 10)" },
        underperformingOnly: { type: "boolean", description: "Only rows below their benchmark (default true)" },
        limit: { type: "number", description: "Max rows (default 50, max 500)" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const since = sinceDate(args.days, 90, 365);
      const rows = await prisma.dailyMetric.groupBy({
        by: ["query", "url"],
        where: { siteId: site.id, date: { gte: since }, position: { gte: 1, lte: 10 } },
        _sum: { clicks: true, impressions: true },
        _avg: { ctr: true, position: true },
        having: { impressions: { _sum: { gte: Math.max(0, Number(args.minImpressions ?? 10)) } } },
        orderBy: { _sum: { impressions: "desc" } },
        take: lim(args.limit, 50, 500),
      });

      const keywords = rows
        .filter(r => r.url !== "" && r.query !== "")
        .map(r => {
          const position = r1(r._avg.position ?? 1);
          const actualCtr = pct(r._avg.ctr ?? 0);
          const expectedCtr = CTR_BENCHMARKS[Math.max(1, Math.min(10, Math.round(position)))] ?? 0;
          return {
            query: r.query,
            page: r.url,
            impressions: r._sum.impressions ?? 0,
            clicks: r._sum.clicks ?? 0,
            position,
            actualCtrPercent: actualCtr,
            expectedCtrPercent: expectedCtr,
            diff: r1(actualCtr - expectedCtr),
          };
        });

      const under = args.underperformingOnly === false ? keywords : keywords.filter(k => k.diff < 0);
      return {
        site: site.url,
        benchmarkSource: "Backlinko 2023 CTR-by-position study",
        count: under.length,
        keywords: under.sort((a, b) => a.diff - b.diff),
      };
    },
  },

  {
    name: "get_content_groups",
    cost: "local",
    description:
      "The site's Content Groups and Topic Clusters — the user's own URL/query groupings — with aggregate clicks, impressions and average position per group over a window. Use to answer \"which section of the site is growing\" without guessing at URL patterns.",
    inputSchema: {
      type: "object",
      properties: { site: siteArg, days: { type: "number", description: "Lookback window in days (default 28)" } },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const since = sinceDate(args.days, 28);
      const [groups, clusters] = await Promise.all([
        prisma.contentGroup.findMany({ where: { siteId: site.id } }),
        prisma.topicCluster.findMany({ where: { siteId: site.id } }),
      ]);
      if (!groups.length && !clusters.length) {
        return { site: site.url, groups: [], clusters: [], note: "No content groups or topic clusters defined — the user creates them on the site's dashboard." };
      }

      // Groups match URLs, clusters match queries — same rule shape, different field.
      const rows = await prisma.dailyMetric.findMany({
        where: { siteId: site.id, date: { gte: since } },
        select: { url: true, query: true, clicks: true, impressions: true, position: true },
      });

      const applyRules = (rulesJson: string, field: "url" | "query") => {
        let rules: any[] = [];
        try { rules = JSON.parse(rulesJson); } catch { rules = []; }
        const matched = rows.filter(row => {
          const v = String(row[field] ?? "").toLowerCase();
          if (!v) return false;
          return rules.some(rule =>
            (rule?.values ?? []).some((needle: string) => {
              const n = String(needle).toLowerCase();
              return rule.type === "equals" ? v === n : v.includes(n);
            }));
        });
        const clicks = matched.reduce((s, m) => s + m.clicks, 0);
        const impressions = matched.reduce((s, m) => s + m.impressions, 0);
        const avgPos = matched.length ? matched.reduce((s, m) => s + m.position, 0) / matched.length : 0;
        return {
          rows: matched.length,
          clicks,
          impressions,
          ctrPercent: impressions ? pct(clicks / impressions) : 0,
          avgPosition: r1(avgPos),
        };
      };

      return {
        site: site.url,
        windowDays: Math.round((Date.now() - since.getTime()) / 86_400_000),
        groups: groups.map(g => ({ name: g.name, matchOn: "url", ...applyRules(g.rules, "url") })),
        clusters: clusters.map(c => ({ name: c.name, matchOn: "query", ...applyRules(c.rules, "query") })),
      };
    },
  },

  {
    name: "get_rank_history",
    cost: "local",
    description:
      "Full SERP position history for tracked keywords (Rank Tracker), not just the latest check — every RankCheck point with its date and ranking URL. get_rank_tracker gives the current standing; this gives the trend, so you can tell a one-off SERP wobble from a sustained slide.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        keyword: { type: "string", description: "Optional: one keyword (exact or substring). Omit for every tracked keyword." },
        days: { type: "number", description: "Lookback window in days (default 90, max 480)" },
        limit: { type: "number", description: "Max history points per keyword (default 60, max 300)" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const needle = String(args.keyword ?? "").trim().toLowerCase();
      const since = sinceDate(args.days, 90);
      const all = await prisma.trackedKeyword.findMany({ where: { siteId: site.id }, orderBy: { keyword: "asc" } });
      const keywords = needle ? all.filter(k => k.keyword.toLowerCase().includes(needle)) : all;
      if (!keywords.length) return { site: site.url, keywords: [], note: needle ? `No tracked keyword matches "${needle}".` : "No tracked keywords for this site yet." };

      const take = lim(args.limit, 60, 300);
      const out = await Promise.all(keywords.map(async k => {
        const checks = await prisma.rankCheck.findMany({
          where: { keywordId: k.id, checkedAt: { gte: since } },
          orderBy: { checkedAt: "desc" },
          take,
        });
        const found = checks.filter(c => c.position != null).map(c => c.position as number);
        return {
          keyword: k.keyword,
          country: k.country,
          device: k.device,
          current: k.lastPosition,
          best: k.bestPosition,
          // Positive = improved (moved toward 1) over the window, since lower is better.
          trend: found.length >= 2 ? r1((found[found.length - 1] ?? 0) - (found[0] ?? 0)) : null,
          history: checks.map(c => ({ date: c.checkedAt, position: c.position, url: c.url, error: c.error })).reverse(),
        };
      }));
      return { site: site.url, windowDays: Math.round((Date.now() - since.getTime()) / 86_400_000), keywords: out };
    },
  },

  {
    name: "get_geo_audits",
    cost: "local",
    description:
      "GEO audits (Generative Engine Optimization): stored reports on how AI search engines answer a target query — which brands and sources they cite, and where this site stands. Pass an id for the full report, omit it for the list. Unlike AEO Tracker (tracked questions over time) these are one-off deep audits.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Optional: a specific audit id from the list, to get its full report" },
        query: { type: "string", description: "Optional: filter the list by audited query (substring)" },
        limit: { type: "number", description: "Max audits to list (default 20, max 100)" },
      },
    },
    handler: async (userId, args) => {
      const id = String(args.id ?? "").trim();
      if (id) {
        const audit = await prisma.geoAudit.findFirst({ where: { id, userId } });
        if (!audit) throw new Error(`GEO audit not found: ${id}`);
        return {
          id: audit.id, query: audit.query, language: audit.language, country: audit.country,
          model: audit.model, status: audit.status, createdAt: audit.createdAt,
          report: parseJson(audit.report), error: audit.error,
        };
      }
      const needle = String(args.query ?? "").trim();
      const audits = await prisma.geoAudit.findMany({
        where: { userId, ...(needle ? { query: { contains: needle } } : {}) },
        orderBy: { createdAt: "desc" },
        take: lim(args.limit, 20, 100),
        select: { id: true, query: true, language: true, country: true, model: true, status: true, createdAt: true },
      });
      return { count: audits.length, audits, note: audits.length ? "Pass an id to read the full report." : "No GEO audits yet — the user runs them in SEO Tools → GEO Audit." };
    },
  },

  {
    name: "get_generations",
    cost: "local",
    description:
      "The SEO Tools generation history: outlines, articles, analyses and landing pages this instance has produced, newest first. Call before writing anything new — it shows what already exists for a keyword, so you extend the existing piece instead of producing a near-duplicate that will cannibalize it. Pass an id to read one in full.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Optional: one record id, to get its full content" },
        type: { type: "string", description: "Optional filter: outline | text | analysis | landing | cluster" },
        keyword: { type: "string", description: "Optional: filter by keyword (substring)" },
        limit: { type: "number", description: "Max records to list (default 25, max 100)" },
      },
    },
    handler: async (userId, args) => {
      const id = String(args.id ?? "").trim();
      try {
        if (id) {
          const rows: any[] = await rawQuery(
            `SELECT id, type, keyword, status, data, meta, createdAt FROM "SeoHistory" WHERE id = ? AND userId = ?`, id, userId);
          if (!rows.length) throw new Error(`Generation not found: ${id}`);
          const r = rows[0];
          return { id: r.id, type: r.type, keyword: r.keyword, status: r.status, createdAt: r.createdAt, meta: parseJson(r.meta), data: parseJson(r.data) };
        }
        const type = String(args.type ?? "").trim();
        const keyword = String(args.keyword ?? "").trim();
        const where = [`userId = ?`];
        const params: any[] = [userId];
        if (type) { where.push(`type = ?`); params.push(type); }
        if (keyword) { where.push(`keyword LIKE ?`); params.push(`%${keyword}%`); }
        const rows: any[] = await rawQuery(
          `SELECT id, type, keyword, status, createdAt, LENGTH(data) as size FROM "SeoHistory"
           WHERE ${where.join(" AND ")} ORDER BY createdAt DESC LIMIT ${lim(args.limit, 25, 100)}`, ...params);
        return {
          count: rows.length,
          generations: rows.map(r => ({ id: r.id, type: r.type, keyword: r.keyword, status: r.status, createdAt: r.createdAt, chars: Number(r.size ?? 0) })),
          note: rows.length ? "Pass an id to read the full outline/article." : "No generations recorded on the server yet.",
        };
      } catch (e: any) {
        if (String(e?.message ?? "").startsWith("Generation not found")) throw e;
        return { count: 0, generations: [], note: "SeoHistory table not available on this instance (run: npx prisma db push)." };
      }
    },
  },

  {
    name: "get_engine_performance",
    cost: "local",
    description:
      "Bing and Yandex portfolio performance from the server-side snapshot (EnginePortfolioCache) — per-site clicks, impressions, CTR and average position across every connected Bing/Yandex Webmaster account, plus period-over-period deltas. Google data comes from the local store via get_search_performance instead. Returns the cached snapshot; if it is empty the user needs to press Sync on the dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", enum: ["bing", "yandex"], description: "Which engine (default bing)" },
        period: { type: "string", description: "Cached period key as used by the dashboard, e.g. 28d / 3m (default 28d)" },
      },
    },
    handler: async (userId, args) => {
      const engine = args.engine === "yandex" ? "yandex" : "bing";
      const period = String(args.period ?? "28d");
      try {
        const rows: any[] = await rawQuery(
          `SELECT data, updatedAt FROM "EnginePortfolioCache" WHERE userId = ? AND engine = ? AND period = ?`,
          userId, engine, period);
        if (!rows.length) {
          const settings = await getUserSettings(userId);
          const configured = !!(settings[`seoKey_${engine}`] || settings[`seoKey_${engine}_accounts_list`]);
          return {
            engine, period, sites: [],
            note: configured
              ? `No cached ${engine} snapshot for period "${period}". The user can build it by opening the ${engine} tab on the dashboard or pressing Sync.`
              : `No ${engine} credentials configured — see Settings → Search engines (docs/SEARCH-ENGINES-SETUP.md).`,
          };
        }
        return { engine, period, cachedAt: rows[0].updatedAt, ...(parseJson(rows[0].data) as object ?? {}) };
      } catch {
        return { engine, period, sites: [], note: "EnginePortfolioCache table not available on this instance (run: npx prisma db push)." };
      }
    },
  },

  {
    name: "get_analytics",
    cost: "quota",
    description:
      "LIVE Google Analytics 4 for a site (calls GA4 through the user's own OAuth — free, but uses Google's quota): sessions, engagement rate, key events and revenue for a period, with the previous-period comparison. GSC tells you how people arrive; this tells you what they did next. Returns linked:false when the site has no GA4 property attached.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        period: { type: "string", description: "Period key: 7d, 28d, 3m, 6m, 12m (default 28d)" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const propertyId = (site as any).ga4PropertyId as string | null;
      if (!propertyId) return { site: site.url, linked: false, note: "No GA4 property linked to this site — see docs/GA4-SETUP.md." };

      const accounts = (await prisma.account.findMany({
        where: { userId, provider: "google" },
        select: { id: true, access_token: true, refresh_token: true, expires_at: true },
      })) as GoogleAccount[];
      if (!accounts.length) throw new Error("No Google account connected to this instance.");

      const w = dateWindows(String(args.period ?? "28d"));
      const metrics = GA4_API_METRICS.map(name => ({ name }));
      const num = (v: string | null | undefined) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

      let lastError = "";
      for (const account of accounts) {
        try {
          const data = google.analyticsdata({ version: "v1beta", auth: makeOAuth2(account) });
          const res = await data.properties.runReport({
            property: `properties/${propertyId}`,
            requestBody: {
              dateRanges: [{ startDate: w.start, endDate: w.end }, { startDate: w.prevStart, endDate: w.prevEnd }],
              metrics,
            },
          });
          // With two dateRanges GA4 tags each row with a synthetic dateRange dimension.
          const pick = (tag: string) => {
            const row = (res.data.rows ?? []).find(r => (r.dimensionValues?.[0]?.value ?? "") === tag);
            const v = row?.metricValues ?? [];
            return { sessions: num(v[0]?.value), engagementRatePercent: r1(num(v[1]?.value) * 100), keyEvents: num(v[2]?.value), revenue: Math.round(num(v[3]?.value) * 100) / 100 };
          };
          const current = pick("date_range_0");
          const previous = pick("date_range_1");
          const delta = (a: number, b: number) => (b === 0 ? (a > 0 ? 100 : 0) : Math.round(((a - b) / b) * 100));
          return {
            site: site.url,
            linked: true,
            propertyId,
            period: { days: w.days, from: w.start, to: w.end, previousFrom: w.prevStart, previousTo: w.prevEnd },
            current,
            previous,
            changePercent: {
              sessions: delta(current.sessions, previous.sessions),
              keyEvents: delta(current.keyEvents, previous.keyEvents),
              revenue: delta(current.revenue, previous.revenue),
            },
          };
        } catch (e: any) {
          lastError = String(e?.message ?? e); // try the next linked account
        }
      }
      throw new Error(`No linked Google account can read GA4 property ${propertyId}. Last error: ${lastError}`);
    },
  },

  {
    name: "get_clarity",
    cost: "local",
    description:
      "Microsoft Clarity behaviour data for a site from the stored snapshots: sessions, dead clicks, rage clicks, scroll depth and the worst-performing pages over the last 30 days. Rage and dead clicks on a page that ranks well are a UX problem, not an SEO one — worth separating before recommending a content rewrite.",
    inputSchema: { type: "object", properties: { site: siteArg }, required: ["site"] },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      if (!site.clarityProjectId || !site.clarityToken) {
        return { site: site.url, configured: false, note: "Clarity is not configured for this site (needs a project id + Data Export token in the site's settings)." };
      }
      const snapshots = await prisma.claritySnapshot.findMany({
        where: { siteId: site.id }, orderBy: { fetchedAt: "desc" }, take: 35,
      });
      if (!snapshots.length) return { site: site.url, configured: true, note: "No Clarity snapshots collected yet." };
      const parsed = snapshots.map(s => ({ fetchedAt: s.fetchedAt, data: JSON.parse(s.data) }));
      const aggregate = aggregateSnapshots(parsed, 30);
      return {
        site: site.url,
        configured: true,
        latestSnapshotAt: snapshots[0].fetchedAt,
        snapshotCount: snapshots.length,
        aggregate30d: aggregate,
      };
    },
  },

  {
    name: "get_indexer_stats",
    cost: "local",
    description:
      "Private Indexer Network status: every doorway domain with its template, money-site target and allowed crawlers, plus verified bot hits over the last 30 days broken down by engine (Google/Bing/Yandex/Mail.ru/AI) and the redirect count for non-bot visitors. A domain with zero Google hits is not being crawled and its deployed script needs checking.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Optional: one doorway domain to detail" },
        days: { type: "number", description: "Lookback window for the hit counts (default 30, max 180)" },
      },
    },
    handler: async (userId, args) => {
      const since = sinceDate(args.days, 30, 180);
      const needle = String(args.domain ?? "").trim().toLowerCase();
      const domains = await prisma.indexerDomain.findMany({
        where: { userId, ...(needle ? { domain: { contains: needle } } : {}) },
        orderBy: { domain: "asc" },
      });
      if (!domains.length) return { domains: [], note: needle ? `No indexer domain matches "${needle}".` : "The Indexer module has no domains configured." };

      const sinceStr = since.toISOString().split("T")[0];
      const stats = await prisma.indexerDailyStat.findMany({
        where: { domainId: { in: domains.map(d => d.id) }, date: { gte: sinceStr } },
        select: { domainId: true, botType: true, statusCode: true, count: true },
      });

      const byDomain = domains.map(d => {
        const mine = stats.filter(l => l.domainId === d.id);
        const count = (t: string) => mine.filter(l => l.botType === t).reduce((sum, s) => sum + s.count, 0);
        const bots = { google: count("google"), bing: count("bing"), yandex: count("yandex"), mailru: count("mailru"), ai: count("ai"), other: count("other") };
        const totalBots = Object.values(bots).reduce((a, b) => a + b, 0);
        return {
          domain: d.domain,
          status: d.status,
          template: d.template,
          moneyUrl: d.moneyUrl,
          allowedBots: d.allowedBots,
          pages: d.pagesCount,
          subdomains: d.subdomainsCount,
          botHits: bots,
          totalBotHits: totalBots,
          // A high 304 share means bots are re-validating cheaply rather than refetching.
          notModified304: mine.filter(l => l.statusCode === 304).reduce((sum, s) => sum + s.count, 0),
          humanRedirects: count("redirect"),
          googleSharePercent: totalBots ? Math.round((bots.google / totalBots) * 100) : 0,
        };
      });

      const sum = (f: (d: typeof byDomain[number]) => number) => byDomain.reduce((s, d) => s + f(d), 0);
      return {
        windowDays: Math.round((Date.now() - since.getTime()) / 86_400_000),
        totals: {
          domains: byDomain.length,
          active: byDomain.filter(d => d.status === "active").length,
          botHits: sum(d => d.totalBotHits),
          humanRedirects: sum(d => d.humanRedirects),
          notModified304: sum(d => d.notModified304),
        },
        domains: byDomain,
        neverCrawled: byDomain.filter(d => d.botHits.google === 0).map(d => d.domain),
      };
    },
  },

  {
    name: "get_digests",
    cost: "local",
    description:
      "Previously generated portfolio digests (the Telegram/Slack reports): rendered Markdown per run, with the tag filter and window each covered. Useful for \"what did we report last week\" and for continuity — so a new report picks up where the last one left off instead of restating it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Optional: one digest id, to get its full Markdown" },
        limit: { type: "number", description: "Max digests to list (default 10, max 50)" },
      },
    },
    handler: async (userId, args) => {
      const id = String(args.id ?? "").trim();
      try {
        if (id) {
          const rows: any[] = await rawQuery(
            `SELECT id, tag, days, content, sentTo, createdAt FROM "Digest" WHERE id = ? AND userId = ?`, id, userId);
          if (!rows.length) throw new Error(`Digest not found: ${id}`);
          return rows[0];
        }
        const rows: any[] = await rawQuery(
          `SELECT id, tag, days, sentTo, createdAt, LENGTH(content) as size FROM "Digest"
           WHERE userId = ? ORDER BY createdAt DESC LIMIT ${lim(args.limit, 10, 50)}`, userId);
        return {
          count: rows.length,
          digests: rows.map(r => ({ id: r.id, tag: r.tag || "(all sites)", days: r.days, deliveredTo: r.sentTo ?? "on-screen only", createdAt: r.createdAt, chars: Number(r.size ?? 0) })),
          note: rows.length ? "Pass an id to read the full digest Markdown." : "No digests generated yet.",
        };
      } catch (e: any) {
        if (String(e?.message ?? "").startsWith("Digest not found")) throw e;
        return { count: 0, digests: [], note: "Digest table not available on this instance (run: npx prisma db push)." };
      }
    },
  },

  {
    name: "get_alerts",
    cost: "local",
    description:
      "Alerts that have actually fired (alert-cron, hourly): rank drops, week-over-week click drops, SSL expiry and low audit scores, newest first. Each is deduplicated per occurrence, so this is a clean incident list rather than a repeating notification stream. Start a triage here — it is the app's own view of what already went wrong.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "Optional: restrict to one site (domain or id)" },
        type: { type: "string", description: "Optional: rank_drop | traffic_drop | ssl_expiry | audit_score" },
        days: { type: "number", description: "Lookback window in days (default 30, max 365)" },
        limit: { type: "number", description: "Max alerts (default 50, max 200)" },
      },
    },
    handler: async (userId, args) => {
      const since = sinceDate(args.days, 30, 365);
      const siteFilter = String(args.site ?? "").trim();
      const siteId = siteFilter ? (await resolveSite(userId, siteFilter)).id : "";
      const type = String(args.type ?? "").trim();
      try {
        const where = [`userId = ?`, `createdAt >= ?`];
        const params: any[] = [userId, since];
        if (siteId) { where.push(`siteId = ?`); params.push(siteId); }
        if (type) { where.push(`type = ?`); params.push(type); }
        const rows: any[] = await rawQuery(
          `SELECT type, siteId, title, message, sent, createdAt FROM "AlertEvent"
           WHERE ${where.join(" AND ")} ORDER BY createdAt DESC LIMIT ${lim(args.limit, 50, 200)}`, ...params);
        const sites = await prisma.site.findMany({ where: { userId }, select: { id: true, url: true } });
        const nameOf = new Map(sites.map(s => [s.id, s.url]));
        const byType: Record<string, number> = {};
        for (const r of rows) byType[r.type] = (byType[r.type] ?? 0) + 1;
        return {
          windowDays: Math.round((Date.now() - since.getTime()) / 86_400_000),
          count: rows.length,
          byType,
          alerts: rows.map(r => ({ type: r.type, site: r.siteId ? nameOf.get(r.siteId) ?? r.siteId : null, title: r.title, message: r.message, delivered: !!r.sent, at: r.createdAt })),
        };
      } catch {
        return { count: 0, alerts: [], note: "AlertEvent table not available on this instance (run: npx prisma db push)." };
      }
    },
  },
];

// Exported for get_capabilities, which reports which optional modules actually hold data.
export async function dataModuleCounts(userId: string): Promise<Json> {
  const safeCount = async (sql: string, ...params: any[]) => {
    try {
      const rows: any[] = await rawQuery(sql, ...params);
      return Number(rows?.[0]?.c ?? 0);
    } catch { return 0; }
  };
  const [geoAudits, generations, digests, alerts, indexerDomains, clarity, groups] = await Promise.all([
    safeCount(`SELECT COUNT(*) as c FROM "GeoAudit" WHERE userId = ?`, userId),
    safeCount(`SELECT COUNT(*) as c FROM "SeoHistory" WHERE userId = ?`, userId),
    safeCount(`SELECT COUNT(*) as c FROM "Digest" WHERE userId = ?`, userId),
    safeCount(`SELECT COUNT(*) as c FROM "AlertEvent" WHERE userId = ?`, userId),
    prisma.indexerDomain.count({ where: { userId } }).catch(() => 0),
    prisma.claritySnapshot.count({ where: { site: { userId } } }).catch(() => 0),
    prisma.contentGroup.count({ where: { site: { userId } } }).catch(() => 0),
  ]);
  const settings = await getUserSettings(userId);
  return {
    geoAudits, generations, digests, alerts, indexerDomains,
    claritySnapshots: clarity,
    contentGroups: groups,
    ga4LinkedSites: await prisma.site.count({ where: { userId, ga4PropertyId: { not: null } } }).catch(() => 0),
    engineCredentials: {
      bing: !!(settings.seoKey_bing || settings.seoKey_bing_accounts_list),
      yandex: !!(settings.seoKey_yandex || settings.seoKey_yandex_accounts_list),
    },
    aiKeyConfigured: !!(settings[`aiKey_${settings.seoProvider || settings.aiProvider || "anthropic"}`] || settings.aiApiKey),
  };
}

// Re-exported so tools.ts can normalize a domain the same way when building briefs.
export { normDomain };
