// MCP tools for network footprints (N1, CONTRACT §4). Read-only, local: the report reads the
// instance's own audits and generation history — nothing leaves the server, nothing is spent.

import { lim, type McpTool } from "./shared";
import { footprintReport } from "@/lib/footprint/store";
import type { FootprintKind } from "@/lib/footprint/skeleton";

const KINDS = new Set<FootprintKind>(["title", "description", "h1"]);

export const FOOTPRINT_TOOLS: McpTool[] = [
  {
    name: "get_footprints",
    cost: "local",
    readOnly: true,
    description:
      "Network footprint report: title/description/H1 templates repeated across several sites of the " +
      "portfolio (the same construction with only the entity swapped — a linkable footprint for a site " +
      "network). LOCAL and free: reads the last completed audit of every live site plus 180 days of " +
      "outline/text generation history. Returns exact groups (skeleton, site count, page count, source, " +
      "one example per site) and a separate similar-templates section (Jaccard >= 0.85). A skeleton with " +
      "noEntity=true matched even WITHOUT the site name — the stronger footprint.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["title", "description", "h1"], description: "Which meta field to inspect (default title; h1 covers generated outlines/articles only — the audit stores h1Count, not the text)" },
        min_sites: { type: "number", description: "Distinct sites a template needs to qualify (default 2, min 2, max 50)" },
        include_ignored: { type: "boolean", description: "Also return skeletons the operator marked fine (default false)" },
      },
    },
    handler: async (userId, args) => {
      const kindRaw = String(args.kind ?? "title");
      const kind: FootprintKind = KINDS.has(kindRaw as FootprintKind) ? (kindRaw as FootprintKind) : "title";
      const report = await footprintReport(userId, {
        kind,
        minSites: lim(args.min_sites, 2, 50),
        includeIgnored: args.include_ignored === true,
      });
      if ("notMigrated" in report) {
        return { notMigrated: true, hint: "Run `npx prisma db push` to create the audit/history tables." };
      }
      return report;
    },
  },
];
