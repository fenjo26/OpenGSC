// MCP tool registry — the data surface exposed to AI agents via /api/mcp.
//
// Three groups make up the registry, split by file for readability but flattened into a
// single MCP_TOOLS array at the bottom of this file:
//
//   • this file      — the GSC core (performance, striking distance, cannibalization, …)
//   • toolsData.ts   — every other read surface (decay, CTR, GEO, indexer, digests, …)
//   • toolsOptimize  — the page-optimization contour
//
// Cost model, and it is the thing to keep straight when adding a tool. Almost everything
// is a plain Prisma read over data the app has already synced, scoped to the token's
// user: free and instant. A few tools reach further and each says so in its description
// and carries a `cost` field:
//
//   quota — query_gsc_live, inspect_url, get_analytics call Google on the user's own
//           OAuth. Free, but they consume Google's per-day quota.
//   net   — fetch_page_content, get_optimization_brief fetch a third-party page.
//   paid  — start_rewrite_job, start_generation_job spend the user's own AI credits.
//           Both are asynchronous: they return a job id, never the finished text.
//
// The paid group is new, and it is the one exception to what this file used to promise.
// It exists because the web UI can do things an agent cannot reproduce (the outline
// pipeline's fact grounding, Casino RAG, the user's editorial policy), and refusing to
// expose them made the MCP a strictly worse OpenGSC. The exposure is deliberately
// awkward: paid tools refuse to run without `confirm: true`, and their descriptions
// point at the free path first. See toolsOptimize.ts for the reasoning in full.

import { prisma } from "@/lib/prisma";
import { google } from "googleapis";
// Same version the UI shows in Settings → System, rather than a second copy that has to be
// remembered on release day — it was already a release behind (1.1.0 against 1.2.0) by the time
// anyone noticed. Imported rather than read at runtime: the bundler inlines the string, so the
// route gains no filesystem access and nothing to trace.
import pkg from "../../../package.json";
import { getUserGoogleAccounts, makeOAuth2, queryGsc, isoDaysAgo } from "@/lib/gscQuery";
import {
  type McpTool, type ToolCost,
  sinceDate, lim, pct, r1, resolveSite, siteArg,
} from "./shared";
import { DATA_TOOLS, dataModuleCounts } from "./toolsData";
import { OPTIMIZE_TOOLS } from "./toolsOptimize";
import { METRICS_TOOLS } from "./toolsMetrics";
import { DEMAND_TOOLS } from "./toolsDemand";
import { OUTREACH_TOOLS } from "./toolsOutreach";
import { SOURCE_AUDIT_TOOLS } from "./toolsSourceAudit";
import { rawQuery } from "@/lib/db/raw";
import { buildRelatedIntentGroups, siteBrandTerms } from "@/lib/cannibalization/relatedIntent";

export type { McpTool, ToolCost };

// ─── tools ──────────────────────────────────────────────────────────────────────

const CORE_TOOLS: McpTool[] = [
  {
    name: "list_sites",
    cost: "local",
    description:
      "List every site connected to this OpenGSC instance (all Google accounts), with tags and last-sync info. Call this first to discover what data is available and to get exact site identifiers for the other tools.",
    inputSchema: { type: "object", properties: {} },
    handler: async (userId) => {
      const sites = await prisma.site.findMany({
        where: { userId },
        select: { id: true, url: true, siteId: true, tags: true, lastSitemapSync: true, createdAt: true },
        orderBy: { url: "asc" },
      });
      return {
        count: sites.length,
        sites: sites.map(s => ({ id: s.id, url: s.url, gscProperty: s.siteId, tags: s.tags ?? null })),
      };
    },
  },

  {
    name: "get_search_performance",
    cost: "local",
    description:
      "Google Search Console performance for one site from the local metrics store: totals (clicks, impressions, CTR, avg position) plus the top rows grouped by query or page over a date window. Use dimension=query for keyword analysis, dimension=page to find top/weak pages. Pass `page` to see which queries drive traffic to ONE specific page.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        days: { type: "number", description: "Lookback window in days (default 28, max 480)" },
        dimension: { type: "string", enum: ["query", "page"], description: "Group rows by search query (default) or by page URL" },
        page: { type: "string", description: "Optional: restrict to one page — full URL or path substring (e.g. /pricing). Combine with dimension=query to see that page's queries." },
        limit: { type: "number", description: "Max rows to return (default 50, max 500)" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const since = sinceDate(args.days, 28);
      const dim = args.dimension === "page" ? "url" : "query";
      const take = lim(args.limit, 50, 500);
      const pageFilter = String(args.page ?? "").trim();
      const where: any = { siteId: site.id, date: { gte: since } };
      if (pageFilter) where.url = { contains: pageFilter };

      const totals = await prisma.dailyMetric.aggregate({
        where,
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
      });
      const rows = await prisma.dailyMetric.groupBy({
        by: [dim] as any,
        where: { ...where, [dim]: { not: "" } } as any,
        _sum: { clicks: true, impressions: true },
        _avg: { ctr: true, position: true },
        orderBy: { _sum: { clicks: "desc" } },
        take,
      });
      const clicks = totals._sum.clicks ?? 0;
      const impressions = totals._sum.impressions ?? 0;
      return {
        site: site.url,
        days: Math.round((Date.now() - since.getTime()) / 86_400_000),
        totals: { clicks, impressions, ctrPercent: impressions ? pct(clicks / impressions) : 0, avgPosition: r1(totals._avg.position ?? 0) },
        rows: (rows as any[]).map(r => ({
          [dim === "url" ? "page" : "query"]: r[dim],
          clicks: r._sum.clicks ?? 0,
          impressions: r._sum.impressions ?? 0,
          ctrPercent: pct(r._avg.ctr ?? 0),
          avgPosition: r1(r._avg.position ?? 0),
        })),
      };
    },
  },

  {
    name: "get_striking_distance",
    cost: "local",
    description:
      "Striking-distance keywords for a site: queries ranking just off page 1 (default positions 4–20) with real impression volume — the fastest ranking wins. Each row includes the ranking page, so recommendations can target a concrete URL.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        days: { type: "number", description: "Lookback window in days (default 90)" },
        positionFrom: { type: "number", description: "Lower bound of the position band (default 4)" },
        positionTo: { type: "number", description: "Upper bound of the position band (default 20)" },
        minImpressions: { type: "number", description: "Minimum summed impressions to include a query (default 10)" },
        limit: { type: "number", description: "Max rows (default 50, max 300)" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const since = sinceDate(args.days, 90);
      const posFrom = Math.max(1, Number(args.positionFrom ?? 4));
      const posTo = Math.min(100, Number(args.positionTo ?? 20));
      const minImpr = Math.max(0, Number(args.minImpressions ?? 10));

      const rows = await prisma.dailyMetric.groupBy({
        by: ["query", "url"],
        where: { siteId: site.id, date: { gte: since }, position: { gte: posFrom, lte: posTo }, query: { not: "" }, url: { not: "" } },
        _sum: { clicks: true, impressions: true },
        _avg: { ctr: true, position: true },
        having: { impressions: { _sum: { gte: minImpr } } },
        orderBy: { _sum: { impressions: "desc" } },
        take: lim(args.limit, 50, 300),
      });
      return {
        site: site.url,
        positionBand: [posFrom, posTo],
        keywords: rows.map(r => ({
          query: r.query,
          page: r.url,
          impressions: r._sum.impressions ?? 0,
          clicks: r._sum.clicks ?? 0,
          ctrPercent: pct(r._avg.ctr ?? 0),
          avgPosition: r1(r._avg.position ?? 0),
        })),
      };
    },
  },

  {
    name: "get_cannibalization",
    cost: "local",
    description:
      "Cannibalization for one site. mode=exact (default, backward-compatible) returns queries where two or more URLs compete. mode=related deterministically finds different query wordings with similar intent and conflicting ranking URLs, including confidence, page roles, flip-flops and review-only recommendations. Related mode is local: no LLM, live SERP or paid call, and it never changes pages/canonicals/redirects.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        mode: { type: "string", enum: ["exact", "related"], description: "exact (default) or related intent conflicts" },
        days: { type: "number", description: "Lookback window in days (default 90)" },
        minImpressions: { type: "number", description: "Minimum summed impressions per query (default 30)" },
        limit: { type: "number", description: "Max queries (default 30, max 100)" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const since = sinceDate(args.days, 90);
      const minImpr = Math.max(0, Number(args.minImpressions ?? 30));
      const take = lim(args.limit, 30, 100);

      if (args.mode === "related") {
        const rows = await prisma.dailyMetric.findMany({
          where: { siteId: site.id, date: { gte: since }, query: { not: "" }, url: { not: "" } },
          select: { query: true, url: true, date: true, clicks: true, impressions: true, ctr: true, position: true },
          orderBy: { impressions: "desc" },
          take: 30_000,
        });
        const relatedConflicts = buildRelatedIntentGroups(rows, {
          siteId: site.id,
          siteName: site.url.replace("sc-domain:", "").replace(/^https?:\/\//, "").replace(/\/$/, ""),
          brandTerms: siteBrandTerms(site.siteId),
          minImpressions: minImpr,
          limit: take,
        });
        return {
          site: site.url,
          mode: "related",
          relatedConflicts,
          methodology: { deterministic: true, paidCalls: 0, candidateIndex: ["query_tokens", "ranking_urls"], autoActions: false },
          truncated: rows.length === 30_000,
        };
      }

      const pairs = await prisma.dailyMetric.groupBy({
        by: ["query", "url"],
        where: { siteId: site.id, date: { gte: since }, query: { not: "" }, url: { not: "" } },
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
      });
      const byQuery = new Map<string, { url: string; clicks: number; impressions: number; position: number }[]>();
      for (const p of pairs) {
        const list = byQuery.get(p.query) ?? [];
        list.push({ url: p.url, clicks: p._sum.clicks ?? 0, impressions: p._sum.impressions ?? 0, position: r1(p._avg.position ?? 0) });
        byQuery.set(p.query, list);
      }
      const conflicts = [...byQuery.entries()]
        .map(([query, urls]) => ({ query, urls: urls.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions), totalImpressions: urls.reduce((s, u) => s + u.impressions, 0) }))
        .filter(c => c.urls.length >= 2 && c.totalImpressions >= minImpr)
        .sort((a, b) => b.totalImpressions - a.totalImpressions)
        .slice(0, take);
      return { site: site.url, conflicts };
    },
  },

  {
    name: "get_rank_tracker",
    cost: "local",
    description:
      "Tracked keyword rankings (Rank Tracker): every tracked keyword for a site with its latest SERP position check and the previous one for direction, plus country/device. Position 0/null means not found in the checked depth.",
    inputSchema: { type: "object", properties: { site: siteArg }, required: ["site"] },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const keywords = await prisma.trackedKeyword.findMany({ where: { siteId: site.id }, orderBy: { keyword: "asc" } });
      return {
        site: site.url,
        count: keywords.length,
        keywords: keywords.map(k => ({
          keyword: k.keyword,
          country: k.country,
          device: k.device,
          latestPosition: k.lastPosition,
          previousPosition: k.prevPosition,
          bestPosition: k.bestPosition,
          rankingUrl: k.lastUrl,
          lastCheckedAt: k.lastCheckedAt,
        })),
      };
    },
  },

  {
    name: "get_aeo_visibility",
    cost: "local",
    description:
      "AI answer-engine visibility (AEO Tracker): tracked real-user questions and whether this site gets cited/mentioned when they are asked to ChatGPT, Perplexity, Claude, and Grok — latest result per engine per question. Use to assess AI-search presence and find questions where the site is invisible.",
    inputSchema: { type: "object", properties: { site: siteArg }, required: ["site"] },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const questions = await prisma.trackedQuestion.findMany({ where: { siteId: site.id }, orderBy: { createdAt: "asc" } });
      return {
        site: site.url,
        questions: questions.map(q => {
          let engines: unknown = null;
          try { engines = q.lastResults ? JSON.parse(q.lastResults) : null; } catch { engines = q.lastResults; }
          return { question: q.question, lastCheckedAt: q.lastCheckedAt, engines };
        }),
      };
    },
  },

  {
    name: "get_backlinks",
    cost: "local",
    description:
      "The site's curated backlink inventory (Backlinks Checker): each tracked backlink with liveness (is the link still present) and indexed status, plus summary counts. This is the user's own link list — for competitor backlinks use get_link_mentions.",
    inputSchema: {
      type: "object",
      properties: { site: siteArg, limit: { type: "number", description: "Max rows (default 100, max 500)" } },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const links = await prisma.backlink.findMany({ where: { siteId: site.id }, orderBy: { addedAt: "desc" }, take: lim(args.limit, 100, 500) });
      return {
        site: site.url,
        summary: {
          total: links.length,
          alive: links.filter(l => l.isAlive === true).length,
          dead: links.filter(l => l.isAlive === false).length,
          indexed: links.filter(l => l.xrStatus === "indexed").length,
        },
        backlinks: links.map(l => ({ url: l.url, title: l.title, alive: l.isAlive, indexedStatus: l.xrStatus, aliveCheckedAt: l.aliveChecked, addedAt: l.addedAt })),
      };
    },
  },

  {
    name: "get_link_mentions",
    cost: "local",
    description:
      "Link Monitor data: fresh quality backlinks recently earned by the WATCHED COMPETITOR BRANDS (pulled from Ahrefs; in-content, DR-filtered), plus multi-linker domains — sites that link to 2+ watched brands and are therefore prime outreach targets. Use for link prospecting and digital-PR ideas.",
    inputSchema: {
      type: "object",
      properties: {
        brand: { type: "string", description: "Optional: filter to one watched brand domain" },
        limit: { type: "number", description: "Max mention rows (default 100, max 500)" },
      },
    },
    handler: async (userId, args) => {
      const brand = String(args.brand ?? "").trim().toLowerCase();
      try {
        const mentions: any[] = await rawQuery(
          `SELECT brand, urlFrom, domainFrom, title, anchor, drFrom, firstSeen, dofollow FROM "LinkMention"
           WHERE userId = ? ${brand ? "AND brand = ?" : ""} ORDER BY firstSeen DESC LIMIT ${lim(args.limit, 100, 500)}`,
          ...(brand ? [userId, brand] : [userId]));
        const topDomains: any[] = await rawQuery(
          `SELECT domainFrom, COUNT(DISTINCT brand) as brandsLinked, COUNT(*) as links, MAX(drFrom) as maxDr
           FROM "LinkMention" WHERE userId = ? GROUP BY domainFrom HAVING COUNT(DISTINCT brand) >= 2
           ORDER BY brandsLinked DESC, links DESC LIMIT 50`, userId);
        const brands: any[] = await rawQuery(`SELECT domain FROM "LinkWatchBrand" WHERE userId = ?`, userId);
        return {
          watchedBrands: brands.map(b => b.domain),
          multiLinkerDomains: topDomains.map(d => ({ domain: d.domainFrom, brandsLinked: Number(d.brandsLinked), links: Number(d.links), maxDr: Number(d.maxDr) })),
          mentions: mentions.map(m => ({ brand: m.brand, from: m.urlFrom, domain: m.domainFrom, title: m.title, anchor: m.anchor, dr: Number(m.drFrom), firstSeen: m.firstSeen, dofollow: !!m.dofollow })),
        };
      } catch {
        return { watchedBrands: [], multiLinkerDomains: [], mentions: [], note: "Link Monitor has no data yet — the user can set it up under SEO Tools → Link Monitor." };
      }
    },
  },

  {
    name: "get_site_health",
    cost: "local",
    description:
      "Site health snapshot: SSL certificate status/expiry, Google Safe Browsing verdict, VirusTotal reputation, and Core Web Vitals (PageSpeed, mobile) — as last checked by the app.",
    inputSchema: { type: "object", properties: { site: siteArg }, required: ["site"] },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const health = await prisma.siteHealth.findUnique({ where: { siteId: site.id } });
      if (!health) return { site: site.url, note: "No health check has been run for this site yet." };
      const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return s; } };
      return {
        site: site.url,
        checkedAt: health.checkedAt,
        ssl: parse(health.sslData),
        safeBrowsing: parse(health.safeBrowsing),
        coreWebVitals: parse(health.vitals),
        virusTotal: parse(health.virusTotal),
      };
    },
  },

  {
    name: "get_indexing_status",
    cost: "local",
    description:
      "Indexing overview for a site: sitemap URL counts grouped by known Google index status, and the most recent URL Inspection results. Large 'unknown/not inspected' counts mean inspection coverage is thin, not that pages are deindexed.",
    inputSchema: {
      type: "object",
      properties: { site: siteArg, limit: { type: "number", description: "Max recent inspections to include (default 25, max 100)" } },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const byStatus = await prisma.sitemapUrl.groupBy({
        by: ["googleStatus"], where: { siteId: site.id }, _count: { _all: true },
      });
      const recent = await prisma.pageInspection.findMany({
        where: { siteId: site.id },
        orderBy: { lastInspect: "desc" },
        take: lim(args.limit, 25, 100),
      });
      return {
        site: site.url,
        sitemapUrlCounts: byStatus.map(s => ({ status: s.googleStatus ?? "not inspected", count: s._count._all })),
        recentInspections: recent.map(r => ({ url: r.url, status: r.status, lastCrawl: r.lastCrawl, inspectedAt: r.lastInspect })),
      };
    },
  },
  {
    name: "get_site_audit",
    cost: "local",
    description:
      "Latest technical Site Audit from OpenGSC's built-in crawler: health score and issue counts across HTTP/redirects, metadata, canonicals/robots, HTML structure, JSON-LD/social metadata, links, mixed content, security headers and response time, plus affected URLs for one issue. This is the runtime Site Audit only; it does not combine AI Visibility or SEO Tools → GEO data. If no audit exists, tell the user to run one in the site's Audit tab.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        issue: { type: "string", description: "Optional issue code to list affected pages for (e.g. broken_links, title_missing, thin_content)" },
        limit: { type: "number", description: "Max affected pages to return (default 30, max 200)" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const audit = await prisma.siteAudit.findFirst({
        where: { siteId: site.id, status: "completed" },
        orderBy: { startedAt: "desc" },
      });
      if (!audit) return { site: site.url, note: "No completed audit yet — the user can run one in the site's Audit tab (built-in crawler, free)." };
      const summary = audit.summary ? JSON.parse(audit.summary) : null;
      const issue = String(args.issue ?? "").trim();
      let affectedPages: unknown[] = [];
      if (issue) {
        const pages = await prisma.siteAuditPage.findMany({
          where: { auditId: audit.id, issues: { contains: `"${issue}"` } },
          take: lim(args.limit, 30, 200),
        });
        affectedPages = pages.map(p => ({
          url: p.url, httpStatus: p.httpStatus, title: p.title, wordCount: p.wordCount, loadMs: p.loadMs,
          issues: p.issues ? JSON.parse(p.issues) : [],
          brokenLinks: p.brokenLinks ? JSON.parse(p.brokenLinks) : [],
        }));
      }
      return {
        site: site.url,
        auditId: audit.id,
        auditedAt: audit.finishedAt,
        pagesCrawled: audit.pagesCrawled,
        summary,
        verification: audit.verification ? JSON.parse(audit.verification) : null,
        baselineAuditId: audit.baselineAuditId,
        ...(issue ? { issue, affectedPages } : {}),
      };
    },
  },
  {
    name: "compare_periods",
    cost: "local",
    description:
      "Period-over-period comparison from the local metrics store: current window vs the equally-sized previous window, grouped by query or page. Returns overall deltas plus the biggest winners, losers, new entries, and lost entries — answers \"which queries improved/declined vs last month?\" without any external API call.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        days: { type: "number", description: "Window length in days; compares the last N days vs the N days before that (default 28, max 240)" },
        dimension: { type: "string", enum: ["query", "page"], description: "Compare by search query (default) or by page URL" },
        limit: { type: "number", description: "Max rows per list — winners/losers/new/lost (default 15, max 50)" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const days = Math.min(240, Math.max(1, parseInt(String(args.days ?? 28), 10) || 28));
      const dim = args.dimension === "page" ? "url" : "query";
      const take = lim(args.limit, 15, 50);
      const now = new Date();
      const curStart = new Date(now); curStart.setDate(curStart.getDate() - days);
      const prevStart = new Date(now); prevStart.setDate(prevStart.getDate() - days * 2);

      const agg = (gte: Date, lt: Date) => prisma.dailyMetric.groupBy({
        by: [dim] as any,
        where: { siteId: site.id, date: { gte, lt }, [dim]: { not: "" } } as any,
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
      });
      const [cur, prev] = await Promise.all([agg(curStart, now), agg(prevStart, curStart)]);

      type Row = { key: string; clicks: number; impressions: number; position: number };
      const toMap = (rows: any[]): Map<string, Row> => new Map(rows.map(r => [r[dim], {
        key: r[dim], clicks: r._sum.clicks ?? 0, impressions: r._sum.impressions ?? 0, position: r1(r._avg.position ?? 0),
      }]));
      const curMap = toMap(cur as any[]), prevMap = toMap(prev as any[]);

      const joined: { key: string; clicksDelta: number; cur?: Row; prev?: Row }[] = [];
      for (const [key, c] of curMap) joined.push({ key, cur: c, prev: prevMap.get(key), clicksDelta: c.clicks - (prevMap.get(key)?.clicks ?? 0) });
      for (const [key, p] of prevMap) if (!curMap.has(key)) joined.push({ key, prev: p, clicksDelta: -p.clicks });

      const fmt = (j: typeof joined[number]) => ({
        [dim === "url" ? "page" : "query"]: j.key,
        clicks: { current: j.cur?.clicks ?? 0, previous: j.prev?.clicks ?? 0, delta: j.clicksDelta },
        impressions: { current: j.cur?.impressions ?? 0, previous: j.prev?.impressions ?? 0 },
        avgPosition: { current: j.cur?.position ?? null, previous: j.prev?.position ?? null },
      });

      const sum = (m: Map<string, Row>, f: keyof Row) => [...m.values()].reduce((s, r) => s + (r[f] as number), 0);
      return {
        site: site.url,
        window: { days, currentFrom: curStart.toISOString().slice(0, 10), previousFrom: prevStart.toISOString().slice(0, 10) },
        totals: {
          clicks: { current: sum(curMap, "clicks"), previous: sum(prevMap, "clicks") },
          impressions: { current: sum(curMap, "impressions"), previous: sum(prevMap, "impressions") },
        },
        winners: joined.filter(j => j.cur && j.prev && j.clicksDelta > 0).sort((a, b) => b.clicksDelta - a.clicksDelta).slice(0, take).map(fmt),
        losers: joined.filter(j => j.cur && j.prev && j.clicksDelta < 0).sort((a, b) => a.clicksDelta - b.clicksDelta).slice(0, take).map(fmt),
        new: joined.filter(j => j.cur && !j.prev).sort((a, b) => b.clicksDelta - a.clicksDelta).slice(0, take).map(fmt),
        lost: joined.filter(j => !j.cur && j.prev).sort((a, b) => a.clicksDelta - b.clicksDelta).slice(0, take).map(fmt),
      };
    },
  },

  {
    name: "query_gsc_live",
    cost: "quota",
    description:
      "LIVE Google Search Console query (calls Google's Search Analytics API through the user's own OAuth token — free, but uses Google's daily quota; prefer get_search_performance for query/page data that's already synced). Use this when you need dimensions the local store doesn't have: country, device, date, or their combinations.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        days: { type: "number", description: "Lookback window in days (default 28, max 480)" },
        dimensions: {
          type: "array",
          items: { type: "string", enum: ["query", "page", "country", "device", "date"] },
          description: "GSC dimensions to group by, e.g. [\"country\"] or [\"query\",\"device\"] (default [\"country\"])",
        },
        limit: { type: "number", description: "Max rows (default 50, max 250)" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const days = Math.min(480, Math.max(1, parseInt(String(args.days ?? 28), 10) || 28));
      const dims = (Array.isArray(args.dimensions) && args.dimensions.length ? args.dimensions : ["country"])
        .map(String).filter(d => ["query", "page", "country", "device", "date"].includes(d)).slice(0, 3);
      const accounts = await getUserGoogleAccounts(userId);
      if (!accounts.length) throw new Error("No Google account connected to this instance.");
      const rows = await queryGsc(accounts, site.siteId, {
        startDate: isoDaysAgo(days), endDate: isoDaysAgo(0),
        dimensions: dims, rowLimit: lim(args.limit, 50, 250),
      });
      return {
        site: site.url,
        days,
        dimensions: dims,
        rows: (rows as any[]).map(r => ({
          keys: r.keys, clicks: r.clicks ?? 0, impressions: r.impressions ?? 0,
          ctrPercent: pct(r.ctr ?? 0), avgPosition: r1(r.position ?? 0),
        })),
      };
    },
  },

  {
    name: "inspect_url",
    cost: "quota",
    description:
      "LIVE Google URL Inspection for up to 10 URLs (calls Google's URL Inspection API through the user's own OAuth token — free, but Google caps inspections per day; results are also cached into the app's Indexing tab). Returns index verdict, coverage state, last crawl, Google-selected canonical, and robots state per URL.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        urls: { type: "array", items: { type: "string" }, description: "1–10 absolute URLs on this site to inspect" },
      },
      required: ["site", "urls"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const urls = (Array.isArray(args.urls) ? args.urls : []).map(String).filter(u => u.startsWith("http")).slice(0, 10);
      if (!urls.length) throw new Error("Pass 1–10 absolute URLs in `urls`.");
      const accounts = await getUserGoogleAccounts(userId);
      if (!accounts.length) throw new Error("No Google account connected to this instance.");

      const results: unknown[] = [];
      for (const url of urls) {
        let done = false;
        for (const account of accounts) {
          try {
            const sc = google.searchconsole({ version: "v1", auth: makeOAuth2(account) });
            const res = await sc.urlInspection.index.inspect({
              requestBody: { inspectionUrl: url, siteUrl: site.siteId },
            });
            const r = res.data.inspectionResult?.indexStatusResult;
            const status = r?.coverageState ?? r?.verdict ?? "UNKNOWN";
            results.push({
              url,
              verdict: r?.verdict ?? null,
              coverageState: r?.coverageState ?? null,
              lastCrawl: r?.lastCrawlTime ?? null,
              googleCanonical: r?.googleCanonical ?? null,
              userCanonical: r?.userCanonical ?? null,
              robotsState: r?.robotsTxtState ?? null,
              indexingState: r?.indexingState ?? null,
            });
            // Keep the app's Indexing tab in sync with what the agent just fetched.
            await prisma.pageInspection.upsert({
              where: { siteId_url: { siteId: site.id, url } },
              create: { siteId: site.id, url, status, lastCrawl: r?.lastCrawlTime ? new Date(r.lastCrawlTime) : null },
              update: { status, lastCrawl: r?.lastCrawlTime ? new Date(r.lastCrawlTime) : null, lastInspect: new Date() },
            }).catch(() => {});
            done = true;
            break;
          } catch { /* try next linked account */ }
        }
        if (!done) results.push({ url, error: "inspection_failed (no linked account has access to this property, or quota exhausted)" });
      }
      return { site: site.url, inspected: results };
    },
  },

  {
    name: "get_capabilities",
    cost: "local",
    description:
      "Instance overview — call this first if unsure what's available: server version, connected sites count, how fresh the synced GSC data is, which optional modules (rank tracker, AEO, Link Monitor, audits, GEO, indexer, GA4, Clarity, Bing/Yandex) actually contain data, and every tool grouped by what it costs to call. Saves you from calling tools that will come back empty, and from calling a paid one by accident.",
    inputSchema: { type: "object", properties: {} },
    handler: async (userId) => {
      const [sites, metricCount, latestMetric, keywords, questions, audits] = await Promise.all([
        prisma.site.count({ where: { userId } }),
        prisma.dailyMetric.count({ where: { site: { userId } } }),
        prisma.dailyMetric.findFirst({ where: { site: { userId } }, orderBy: { date: "desc" }, select: { date: true } }),
        prisma.trackedKeyword.count({ where: { site: { userId } } }),
        prisma.trackedQuestion.count({ where: { site: { userId } } }),
        prisma.siteAudit.count({ where: { site: { userId }, status: "completed" } }),
      ]);
      let linkMentions = 0;
      try {
        const rows: any[] = await rawQuery(`SELECT COUNT(*) as c FROM "LinkMention" WHERE userId = ?`, userId);
        linkMentions = Number(rows?.[0]?.c ?? 0);
      } catch { /* not migrated */ }
      const extra = await dataModuleCounts(userId);
      // How much third-party metric data is actually loaded. Reported because the metrics
      // tools are read-only: an agent that sees 0 here knows the cache is empty and that no
      // tool it can call will fill it, rather than reading an empty answer as a real one.
      const metricCounts = async (table: string, where = "") => {
        try {
          const rows: any[] = await rawQuery(`SELECT COUNT(*) as c FROM "${table}" ${where}`);
          return Number(rows?.[0]?.c ?? 0);
        } catch { return 0; }
      };
      const [cachedKeywords, cachedDomains, refDomainRows, competitorKeywords] = await Promise.all([
        metricCounts("KeywordMetricCache"),
        metricCounts("DomainMetricCache"),
        metricCounts("RefDomainRow"),
        metricCounts("CompetitorKeyword"),
      ]);
      const named = (c: ToolCost) => MCP_TOOLS.filter(t => (t.cost ?? "local") === c).map(t => t.name);
      return {
        server: "opengsc",
        version: pkg.version,
        toolCount: MCP_TOOLS.length,
        tools: {
          local: named("local"),
          quota: named("quota"),
          net: named("net"),
          paid: named("paid"),
        },
        data: {
          sites,
          gscMetricRows: metricCount,
          latestMetricDate: latestMetric?.date ?? null,
          trackedKeywords: keywords,
          aeoQuestions: questions,
          completedAudits: audits,
          linkMonitorMentions: linkMentions,
          cachedKeywordMetrics: cachedKeywords,
          cachedDomainMetrics: cachedDomains,
          backlinkProfileRows: refDomainRows,
          competitorKeywords,
          ...(extra as object),
        },
        notes:
          "local = reads this instance's database; free and instant. " +
          "quota = calls a Google API on the owner's OAuth; free but quota-limited. " +
          "net = fetches a third-party page. " +
          "paid = spends the OWNER'S OWN AI credits and refuses to run without confirm: true — ask the user first, and prefer get_optimization_brief, which gives you the same material for free. " +
          "The Ahrefs/Semrush metric tools (get_keyword_metrics, get_domain_metrics, get_backlink_profile, get_competitor_gap) are local reads of a cache the human fills by hand — they cannot fetch, so an empty result means 'not loaded yet', never 'zero'.",
      };
    },
  },
  {
    name: "execute_sql_query",
    cost: "local",
    description:
      "Run a custom read-only SELECT (or WITH…SELECT) query over the local database — for cohorts, cross-table joins, and aggregations the standard tools don't cover. Available tables: Site, DailyMetric, TrackedKeyword, RankCheck, TrackedQuestion, AeoCheck, Backlink, SitemapUrl, PageInspection, PageInspectionHistory, SiteHealth, SiteAudit, SiteAuditPage, LinkWatchBrand, LinkMention, DrCache, AlertEvent, Digest, ContentGroup, TopicCluster; sqlite_master (SQLite) or information_schema (MySQL) for schema discovery. Credential tables (User, Account, Session) are blocked, the connection is read-only, and results are capped at 500 rows.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "The SELECT SQL query to execute (single statement)" },
      },
      required: ["sql"],
    },
    handler: async (userId, args) => {
      const sql = String(args.sql ?? "").trim().replace(/;+\s*$/, "");
      if (!sql) throw new Error("Missing required argument: sql");
      if (!/^(select|with)\b/i.test(sql)) throw new Error("Only SELECT (or WITH…SELECT) queries are allowed.");

      // Keyword screening runs on the query with string literals blanked out, so a
      // legitimate `WHERE query LIKE '%delete user%'` is not a false positive.
      const stripped = sql.replace(/'(?:[^']|'')*'/g, "''");
      const banned = stripped.match(/\b(User|Account|Session|VerificationToken|attach|detach|pragma|vacuum|reindex|load_extension|insert|update|delete|drop|alter|create|replace)\b/i);
      if (banned) {
        throw new Error(`Blocked keyword/table: "${banned[0]}". Credential tables (User/Account/Session) and write operations are not accessible through this tool.`);
      }

      const url = process.env.DATABASE_URL || "";
      const isMysql = /^(mysql|mariadb):/i.test(url);
      let rows: any[];

      if (isMysql) {
        // On MySQL there is no local file to open read-only, so the SQLite path below does not
        // apply. The query runs through the same `rawQuery` the rest of the app uses, which means
        // portableSql rewrites `"identifier"` to backticks — so an agent writing the SQLite-style
        // `FROM "User"` it sees everywhere else in this tool's output still works, and a query
        // already using backticks is left untouched (portableSql only touches double quotes).
        // The keyword screen above is the only write-guard on this branch: a MySQL account separate
        // from the app's (e.g. a SELECT-only grant) would be a stronger one, but that is a
        // deployment choice, not something the code can enforce on a connection it did not open.
        rows = await rawQuery(sql);
      } else {
        // True read-only enforcement on SQLite: a separate connection opened with the
        // readonly flag — the engine itself refuses any write no matter how the query
        // text is disguised. prepare() also throws on multi-statement input, and
        // stmt.reader confirms the statement returns rows.
        //
        // Three `turbopackIgnore` markers, and the one that matters is on `process.cwd()`.
        //
        // Turbopack reports "Encountered unexpected file in NFT list" when it decides a route may
        // read arbitrary files at runtime, and then traces the entire project into the build. What
        // triggers that here is not the dynamic imports — it is `path.resolve(process.cwd(), …)`,
        // a filesystem path rooted at the project directory, which the bundler cannot narrow. The
        // warning names this case explicitly and gives the fix in its own text; marking only the
        // imports leaves the warning exactly as it was.
        //
        // The imports keep their markers because neither needs bundling anyway: `path` is built in,
        // and better-sqlite3 is a native addon that has to be resolved from node_modules at
        // runtime.
        const rawPath = url.replace(/^file:/, "").split("?")[0];
        const path = await import(/* turbopackIgnore: true */ "path");
        const dbPath = path.isAbsolute(rawPath)
          ? rawPath
          : path.resolve(/* turbopackIgnore: true */ process.cwd(), rawPath);
        // better-sqlite3 ships no bundled types (@types not installed).
        // @ts-ignore -- no declaration file for better-sqlite3
        const { default: Database } = (await import(/* turbopackIgnore: true */ "better-sqlite3")) as any;
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
          const stmt = db.prepare(sql);
          if (!stmt.reader) throw new Error("Query does not return rows — only SELECT queries are allowed.");
          rows = stmt.all() as any[];
        } finally {
          db.close();
        }
      }

      // Best-effort tenant scoping on top (an instance is normally single-operator,
      // and the credential tables are blocked above — this just keeps obvious
      // cross-user rows out when userId/siteId columns are present in the result).
      const userSites = await prisma.site.findMany({ where: { userId }, select: { id: true } });
      const allowedSiteIds = new Set(userSites.map(s => s.id));
      const filtered = rows.filter(row =>
        (row.userId === undefined || row.userId === userId) &&
        (row.siteId === undefined || allowedSiteIds.has(row.siteId)));

      return { rowCount: Math.min(filtered.length, 500), truncated: filtered.length > 500, rows: filtered.slice(0, 500) };
    },
  },
];

// The single registry the route handler sees. Order matters only for readability in
// tools/list — agents pick by name, and get_capabilities groups them by cost.
export const MCP_TOOLS: McpTool[] = [...CORE_TOOLS, ...DATA_TOOLS, ...METRICS_TOOLS, ...DEMAND_TOOLS, ...OPTIMIZE_TOOLS, ...OUTREACH_TOOLS, ...SOURCE_AUDIT_TOOLS];

// A duplicate name would silently shadow a tool in findTool, and the failure would look
// like "that tool ignores half its arguments" rather than "there are two of them".
// Cheap to assert once at module load, on a list this file no longer owns end to end.
const duplicates = MCP_TOOLS.map(t => t.name).filter((n, i, all) => all.indexOf(n) !== i);
if (duplicates.length) throw new Error(`Duplicate MCP tool name(s): ${[...new Set(duplicates)].join(", ")}`);

export const findTool = (name: string): McpTool | undefined => MCP_TOOLS.find(t => t.name === name);
