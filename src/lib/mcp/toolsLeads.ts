// MCP tools for widget leads (N9): list_leads (local). Read-only — leads arrive through
// the public widget only; an agent reads the inbox but never writes to it.

import { listLeads } from "@/lib/leads/store";
import { LEAD_STATUSES } from "@/lib/leads/types";
import { lim, type McpTool } from "./shared";

export const LEADS_TOOLS: McpTool[] = [
  {
    name: "list_leads",
    cost: "local",
    readOnly: true,
    description:
      "List incoming leads from the embeddable audit widget: domain, contact e-mail, audit score, the top issues found, source page and pipeline status. LOCAL/READ-ONLY: touches nothing but this instance's database.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...LEAD_STATUSES], description: "Optional pipeline-stage filter: new | contacted | won | lost | client" },
        q: { type: "string", description: "Optional substring filter over domain, e-mail and name" },
        limit: { type: "number", description: "Maximum leads returned (default 50, max 200)" },
      },
    },
    handler: async (userId, args) => {
      const result = await listLeads(userId, {
        status: typeof args.status === "string" ? args.status : undefined,
        q: typeof args.q === "string" ? args.q : undefined,
        limit: lim(args.limit, 50, 200),
      });
      return {
        total: result.total,
        notMigrated: result.notMigrated === true || undefined,
        leads: result.leads.map(lead => ({
          id: lead.id,
          domain: lead.domain,
          email: lead.email,
          name: lead.name || undefined,
          score: lead.score,
          topIssues: lead.top,
          status: lead.status,
          source: lead.source,
          origin: lead.origin || undefined,
          createdAt: lead.createdAt,
          hasProposal: lead.proposal != null && lead.proposal !== "",
        })),
      };
    },
  },
];
