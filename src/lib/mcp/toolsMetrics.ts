// MCP tools over the third-party metric cache (Ahrefs / Semrush).
//
// Every tool here is `local`, and that is not a technicality — it is the design. The cache is
// filled by two deliberate human acts: pressing a load button, or importing an export file.
// Neither is something an agent should be able to trigger, because both spend real money and
// the agent has no way to know whether the user considers this question worth paying for.
//
// So the MCP surface reads and never fetches. An empty result means "nobody has loaded this
// yet", and the descriptions say so explicitly, since an agent that reads "no data" as "no
// backlinks" would draw exactly the wrong conclusion and state it confidently.

import { prisma } from "@/lib/prisma";
import { McpTool, lim, resolveSite, siteArg, normDomain } from "./shared";
import { readKeywordCache, readDomainCache } from "@/lib/seo/metricsStore";
import { readRefDomains, readSnapshots } from "@/lib/seo/backlinkStore";
import { rawQuery } from "@/lib/db/raw";

const asStrings = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(x => String(x)).filter(Boolean);
  const s = String(v ?? "").trim();
  if (!s) return [];
  return s.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
};

export const METRICS_TOOLS: McpTool[] = [
  {
    name: "get_keyword_metrics",
    description:
      "Search volume, keyword difficulty and CPC for specific keywords, from the local metric cache. " +
      "The cache is filled by the 'load weights' button or by importing an Ahrefs/Semrush export — this tool never " +
      "calls a provider and never spends credits. A keyword missing from the response has not been loaded yet; " +
      "that is not evidence of zero search volume. Pair with get_striking_distance to rank opportunities by real demand.",
    cost: "local",
    inputSchema: {
      type: "object",
      properties: {
        keywords: { type: "array", items: { type: "string" }, description: "Keywords to look up (max 200)" },
        country: { type: "string", description: "Market the volumes belong to, 2-letter code. Default us" },
        provider: { type: "string", description: "ahrefs (default) or semrush" },
      },
      required: ["keywords"],
    },
    handler: async (_userId, args) => {
      const keywords = asStrings(args.keywords).slice(0, 200);
      if (!keywords.length) throw new Error("Missing required argument: keywords");
      const country = String(args.country ?? "us").toLowerCase();
      const provider = args.provider === "semrush" ? "semrush" : "ahrefs";

      const cache = await readKeywordCache(keywords, country, provider);
      const found = Object.values(cache).map(k => ({
        keyword: k.keyword, volume: k.volume, difficulty: k.difficulty, cpc: k.cpc,
        parentTopic: k.parentTopic, source: k.source, checkedAt: k.checkedAt,
      }));
      const missing = keywords
        .map(k => k.trim().toLowerCase())
        .filter(k => !cache[k]);

      return {
        country, provider,
        keywords: found,
        notLoaded: missing.slice(0, 100),
        note: missing.length
          ? `${missing.length} keyword(s) are not in the cache. Load them in Striking Distance or import an export; this tool cannot fetch them.`
          : undefined,
      };
    },
  },

  {
    name: "get_domain_metrics",
    description:
      "Referring domains, backlink count, estimated organic traffic and traffic value for one or more domains, " +
      "from the local cache. Read-only and free. Domain Rating is NOT here — it comes from a separate free " +
      "endpoint and is available for every site without any of this. Empty means not loaded, not zero.",
    cost: "local",
    inputSchema: {
      type: "object",
      properties: {
        domains: { type: "array", items: { type: "string" }, description: "Domains to look up (max 100)" },
        provider: { type: "string", description: "ahrefs (default) or semrush" },
      },
      required: ["domains"],
    },
    handler: async (_userId, args) => {
      const domains = asStrings(args.domains).map(normDomain).filter(d => d.includes(".")).slice(0, 100);
      if (!domains.length) throw new Error("Missing required argument: domains");
      const provider = args.provider === "semrush" ? "semrush" : "ahrefs";
      const cache = await readDomainCache(domains, provider);
      return {
        provider,
        domains: Object.values(cache),
        notLoaded: domains.filter(d => !cache[d]),
      };
    },
  },

  {
    name: "get_backlink_profile",
    description:
      "A site's referring domains — live and lost — plus the stored history of referring-domain and backlink counts. " +
      "Read-only from the local cache, filled by the Backlink profile panel or a referring-domains import. " +
      "Lost domains are derived by diffing pulls, so a site with one pull has no lost rows yet regardless of reality.",
    cost: "local",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        includeLost: { type: "boolean", description: "Include referring domains recorded as lost. Default true" },
        minDr: { type: "number", description: "Only return referring domains at or above this Domain Rating" },
        limit: { type: "number", description: "Max referring domains to return (default 100, max 500)" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const target = normDomain(site.url);
      const includeLost = args.includeLost !== false;
      const minDr = Number(args.minDr ?? 0);
      const limit = lim(args.limit, 100, 500);

      const all = await readRefDomains(target, { includeLost, limit: 500 });
      const rows = all.filter(r => (r.dr ?? 0) >= minDr).slice(0, limit);
      const history = await readSnapshots(target, 90);

      return {
        target,
        summary: {
          live: all.filter(r => !r.lost).length,
          lost: all.filter(r => r.lost).length,
          latest: history[history.length - 1] ?? null,
        },
        refDomains: rows,
        history,
        note: all.length ? undefined : "No backlink profile stored for this site yet — load it in the Backlinks tab or import a referring-domains export.",
      };
    },
  },

  {
    name: "get_competitor_gap",
    description:
      "Keywords competitors rank for, joined against this site's own Search Console data. Each row says whether " +
      "you already rank (and where), whether you get impressions but no ranking page, or whether you are absent " +
      "entirely — which is the difference between a rewrite, an intent fix, and net-new content. " +
      "Read-only: competitor keywords must first be pulled in the Competitors screen.",
    cost: "local",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        country: { type: "string", description: "Market, 2-letter code. Default us" },
        bucket: { type: "string", description: "Filter: close (we rank in top 30) | weak (impressions only) | missing (absent)" },
        limit: { type: "number", description: "Max rows (default 100, max 500)" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const country = String(args.country ?? "us").toLowerCase();
      const limit = lim(args.limit, 100, 500);

      let stored: any[] = [];
      try {
        stored = await rawQuery(
          `SELECT competitor, keyword, position, volume, difficulty, url
             FROM "CompetitorKeyword" WHERE siteId = ? AND country = ?
            ORDER BY volume DESC LIMIT 3000`,
          site.id, country,
        );
      } catch { stored = []; }
      if (!stored.length) {
        return { rows: [], note: "No competitor keywords stored for this site and market. Pull a competitor in the Competitors screen first." };
      }

      // Same join as the web view, and deliberately recomputed rather than cached: GSC moves
      // daily while the competitor list does not.
      const ours = new Map<string, { position: number; url: string; impressions: number }>();
      try {
        const since = new Date();
        since.setDate(since.getDate() - 90);
        const rows = await prisma.dailyMetric.groupBy({
          by: ["query", "url"],
          where: { siteId: site.id, date: { gte: since } },
          _sum: { impressions: true },
          _avg: { position: true },
        });
        for (const r of rows) {
          const q = String(r.query ?? "").trim().toLowerCase();
          if (!q) continue;
          const pos = Number(r._avg.position ?? 0);
          const prev = ours.get(q);
          if (!prev || pos < prev.position) {
            ours.set(q, { position: pos, url: String(r.url ?? ""), impressions: Number(r._sum.impressions ?? 0) });
          }
        }
      } catch { /* no GSC data — everything reads as "missing" */ }

      const rows = stored.map(r => {
        const mine = ours.get(String(r.keyword));
        const bucket = mine && mine.position <= 30 ? "close" : mine && mine.impressions > 0 ? "weak" : "missing";
        return {
          keyword: r.keyword,
          competitor: r.competitor,
          competitorPosition: r.position == null ? null : Number(r.position),
          volume: r.volume == null ? null : Number(r.volume),
          difficulty: r.difficulty == null ? null : Number(r.difficulty),
          competitorUrl: r.url ?? "",
          ourPosition: mine ? Math.round(mine.position * 10) / 10 : null,
          ourUrl: mine?.url ?? null,
          bucket,
        };
      });

      const wanted = String(args.bucket ?? "").toLowerCase();
      const filtered = ["close", "weak", "missing"].includes(wanted)
        ? rows.filter(r => r.bucket === wanted)
        : rows;

      return {
        target: normDomain(site.url), country,
        counts: {
          close: rows.filter(r => r.bucket === "close").length,
          weak: rows.filter(r => r.bucket === "weak").length,
          missing: rows.filter(r => r.bucket === "missing").length,
        },
        rows: filtered.slice(0, limit),
      };
    },
  },

  {
    name: "get_domain_traffic",
    description:
      "Estimated monthly visits, engagement (bounce rate, time on site, pages per visit), global and country rank, " +
      "the 3-month visit trend, traffic-source shares INCLUDING the GenAI channel, top countries and top keywords " +
      "for any domain — including competitors, since this does not need Search Console access. " +
      "Read-only from the local cache, filled when a human presses Traffic on a site page; this tool never calls " +
      "the provider and never spends credits. Empty means nobody has checked that domain yet, not that it has no traffic. " +
      "Pair the GenAI share with get_aeo_visibility: citations in AI answers only matter if they send sessions.",
    cost: "local",
    inputSchema: {
      type: "object",
      properties: {
        domains: { type: "array", items: { type: "string" }, description: "Domains to look up (max 50)" },
      },
      required: ["domains"],
    },
    handler: async (_userId, args) => {
      const domains = asStrings(args.domains).map(normDomain).filter(d => d.includes(".")).slice(0, 50);
      if (!domains.length) throw new Error("Missing required argument: domains");

      let rows: any[] = [];
      try {
        rows = await rawQuery(
          `SELECT domain, payload, checkedAt FROM "TrafficCache" WHERE domain IN (${domains.map(() => "?").join(",")})`,
          ...domains,
        );
      } catch { /* table missing until prisma db push — same as an empty cache */ }

      const found = rows.map(r => {
        try {
          // `checkedAt` rides alongside the payload rather than inside it: these are estimates
          // with a month's granularity, and an agent quoting them should be able to say how old
          // the reading is.
          return { ...JSON.parse(r.payload), checkedAt: r.checkedAt };
        } catch { return null; }
      }).filter(Boolean);

      const have = new Set(found.map((f: any) => f.domain));
      return {
        domains: found,
        notLoaded: domains.filter(d => !have.has(d)),
        note: "Traffic figures are third-party estimates, not measured analytics. Treat them as scale, not truth.",
      };
    },
  },

];
