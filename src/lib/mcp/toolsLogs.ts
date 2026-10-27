// MCP tool for imported server access logs (lib/logs). Read-only, local: the logs were already
// uploaded and summarised in the site's Audit tab; nothing here touches the network.

import { type McpTool, lim, resolveSite, siteArg } from "./shared";
import { dbAny } from "@/lib/prisma";

export const LOGS_TOOLS: McpTool[] = [
  {
    name: "get_server_logs",
    cost: "local",
    readOnly: true,
    description:
      "Server access-log analysis for one site, from logs the user imported in the Audit tab: which bots actually crawled the site (search engines, AI crawlers such as GPTBot/ClaudeBot/Perplexity, SEO tools), with Googlebot/Bingbot/YandexBot/Applebot verified by reverse DNS so fake crawlers are counted separately; Googlebot requests per day, status split, the most crawled paths and the errors Googlebot hit. Without `importId`, the newest import; `list: true` lists all imports. Only aggregates are stored — no raw lines, no visitor IPs. If none exists, tell the user to upload an nginx/Apache access log in the site's Audit tab.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        importId: { type: "string", description: "Optional: a specific import (from list: true)" },
        list: { type: "boolean", description: "List imports instead of returning one summary" },
        limit: { type: "number", description: "Max paths per list in the summary (default 20, max 50)" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      if (args.list) {
        const rows = await dbAny.serverLogImport.findMany({
          where: { siteId: site.id },
          orderBy: { createdAt: "desc" },
          take: 30,
          select: { id: true, createdAt: true, source: true, lines: true, periodFrom: true, periodTo: true, googleHits: true },
        }).catch(() => []);
        return { site: site.url, imports: rows };
      }
      const row = await dbAny.serverLogImport.findFirst({
        where: { siteId: site.id, ...(args.importId ? { id: String(args.importId) } : {}) },
        orderBy: { createdAt: "desc" },
      }).catch(() => null);
      if (!row) return { site: site.url, note: "No server log imported yet — the user can upload an nginx/Apache access log (plain or .gz) in the site's Audit tab." };
      const summary = JSON.parse(row.summary);
      const n = lim(args.limit, 20, 50);
      const google = summary.google ?? {};
      return {
        site: site.url,
        importId: row.id,
        source: row.source,
        importedAt: row.createdAt,
        period: { from: summary.from, to: summary.to, days: summary.days },
        lines: { total: summary.lines, parsed: summary.parsed, skipped: summary.skipped },
        humanHits: summary.humanHits,
        bots: summary.families,
        googlebot: {
          hits: google.hits,
          statuses: google.statuses,
          byDay: google.byDay,
          distinctPaths: google.distinctPaths,
          topPaths: (google.topPaths ?? []).slice(0, n),
          errorPaths: (google.errorPaths ?? []).slice(0, n),
        },
        fakeCrawlers: summary.fakeIps,
      };
    },
  },
];
