import { prisma } from "@/lib/prisma";
import { sourceAuditDto } from "@/lib/sourceAudit/service";
import { lim, type McpTool } from "./shared";

/**
 * Read-only view over Content Operations → Source Audit. The audit itself is started from the UI,
 * on a repository and branch the operator connected on purpose; an agent should be able to read
 * the findings it is expected to fix, not to reach into GitHub on its own. Nothing here fetches a
 * repository, writes to one, or spends provider credits.
 */
export const SOURCE_AUDIT_TOOLS: McpTool[] = [
  {
    name: "get_source_audit",
    cost: "local",
    readOnly: true,
    description:
      "Read stored Source Audit runs: score, severity counters, per-finding rule id, file path, line, evidence and confidence, plus whether the snapshot was truncated. LOCAL/READ-ONLY: reads this instance's database only — it does not contact GitHub, start an audit, or modify code. Site Audit, AI Visibility and GEO are separate tools with their own data.",
    inputSchema: {
      type: "object",
      properties: {
        repositoryId: { type: "string", description: "Optional Content Operations repository id" },
        runId: { type: "string", description: "Optional specific run id; defaults to the most recent runs" },
        severity: { type: "string", enum: ["error", "warning", "info"], description: "Optional severity filter applied to findings" },
        limit: { type: "number", description: "Maximum runs returned (default 5, max 20)" },
      },
    },
    handler: async (userId, args) => {
      const runId = typeof args.runId === "string" ? args.runId : undefined;
      const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : undefined;
      const severity = typeof args.severity === "string" ? args.severity : undefined;
      const runs = await prisma.sourceAuditRun.findMany({
        where: { userId, ...(runId ? { id: runId } : {}), ...(repositoryId ? { repositoryId } : {}) },
        include: { repository: true },
        orderBy: { startedAt: "desc" },
        take: lim(args.limit, 5, 20),
      });
      return {
        runs: runs.map(run => {
          const dto = sourceAuditDto(run);
          return severity ? { ...dto, findings: dto.findings.filter((item: any) => item?.severity === severity) } : dto;
        }),
        note: "Findings are bounded and store no source code. Open the linked file on GitHub to apply a fix by hand.",
      };
    },
  },
];
