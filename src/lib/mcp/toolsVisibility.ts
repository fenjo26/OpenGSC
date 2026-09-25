// MCP tools for AI share of voice (T7, CONTRACT.md §5).

import { resolveSite, siteArg, type McpTool } from "./shared";
import { sovForSite } from "@/lib/visibility/store";

export const VISIBILITY_TOOLS: McpTool[] = [
  {
    name: "get_ai_share_of_voice",
    cost: "local",
    readOnly: true,
    description:
      "AI share of voice vs the site's named competitors (brand mentions and citation share, per engine, weekly trend) plus the domains AI engines cite for its tracked questions. Aggregated from stored AEO answers — LOCAL/READ-ONLY: no AI call runs, adding a competitor never costs anything.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        days: { type: "number", description: "Window: 7, 30 (default) or 90 days" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const days = [7, 30, 90].includes(Number(args.days)) ? Number(args.days) : 30;
      const r = await sovForSite(userId, site.id, days);
      if (!r) throw new Error("Site not found");
      return { report: r.report, cited: r.cited };
    },
  },
];
