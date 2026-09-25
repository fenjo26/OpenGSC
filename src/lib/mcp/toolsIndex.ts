// MCP tools for automatic index checks (T4). CONTRACT.md §5: get_index_coverage, cost "local".

import { type McpTool, resolveSite, siteArg } from "./shared";
import { indexAutoStatus } from "@/lib/indexing/status";

export const INDEX_TOOLS: McpTool[] = [
  {
    name: "get_index_coverage",
    cost: "local",
    description:
      "Automatic index-check status for one site: settings, today's Google URL Inspection quota usage (2,000/day per property, resets at midnight Pacific), priority queue counts (never checked / changed / not-indexed recheck / indexed recheck), 90-day index coverage by day, why-not-indexed reason breakdown, and pages with traffic that recently dropped out of the index. Local read of data the scheduler collects inside Google's free quota — to inspect URLs live, use inspect_url.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const status = await indexAutoStatus(userId, site.id);
      if (!status) throw new Error(`No index-check status for site: ${site.url}`);
      return {
        site: site.url,
        property: status.property,
        settings: status.settings,
        quota: status.quota,
        queue: status.queue,
        coverage: status.coverage,
        reasons: status.reasons,
        recentLosses: status.recentLosses,
        note:
          "URL Inspection reports what Google already knows; it does not request indexing. " +
          "For submission use IndexNow or the indexer integrations.",
      };
    },
  },
];
