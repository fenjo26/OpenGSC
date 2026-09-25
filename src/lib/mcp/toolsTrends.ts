// MCP tools for the trend radar (N5, CONTRACT §5). Read-only views over the local store, same
// policy as get_brand_mentions: the daily watcher and the operator's "Refresh" own the GSC
// calls and the Google suggest requests — an agent looping a run tool would read like a bot
// to Google and burn the user's Search Console quota, so get_trends only reports what is
// already stored.

import { resolveSite, siteArg, lim, type Json, type McpTool } from "./shared";
import { listTrends } from "@/lib/trends/store";
import { TREND_SOURCES, type TrendSource } from "@/lib/trends/types";

const SOURCE_ENUM = [...TREND_SOURCES];

export const TRENDS_TOOLS: McpTool[] = [
  {
    name: "get_trends",
    cost: "local",
    readOnly: true,
    description:
      "Trend radar for one site: queries rising in its Search Console (7 data days vs the previous 28), " +
      "queries new to it (≥10 impressions, absent for 60 days), and new Google-suggest discoveries for the " +
      "operator's seeds. Rows are collected by the daily watcher or the Demand page's Refresh — LOCAL/READ-ONLY, " +
      "this call fetches nothing. Each row's score is source-specific hotness (higher = hotter); impressions are " +
      "null for suggest rows because autocomplete has no volume.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        source: { type: "string", enum: SOURCE_ENUM, description: "Filter by source (default all three)" },
        limit: { type: "number", description: "Max rows (default 50, max 200)" },
      },
      required: ["site"],
    },
    handler: async (userId, args: Json) => {
      const site = await resolveSite(userId, args.site);
      const sourceRaw = String(args.source ?? "");
      const source = (SOURCE_ENUM as readonly string[]).includes(sourceRaw) ? (sourceRaw as TrendSource) : undefined;
      const result = await listTrends(userId, site.id, {
        ...(source ? { source } : {}),
        limit: lim(args.limit, 50, 200),
      });
      if ("notMigrated" in result) {
        return { notMigrated: true, hint: "Run `npx prisma db push` to create the TrendSeed/TrendItem tables." };
      }
      // The seeds ride along: an agent advising "what to write next" needs to know what the
      // operator is already watching, and suggestUnavailableToday explains an empty column.
      return {
        site: site.url,
        lastRunAt: result.lastRunAt,
        suggestUnavailableToday: result.suggestUnavailableToday,
        seeds: result.seeds.map(s => s.seed),
        items: result.items,
      };
    },
  },
];
