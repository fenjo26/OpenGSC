// MCP tools for client reports (N8): list_reports, local — the read surface an agent
// needs to answer "what reports exist and when did we last send them". Creating, editing
// and sending stay in the UI on purpose: a report is the workspace's voice to a paying
// client, not something an agent should fire from a prompt.

import { type McpTool } from "./shared";
import { listReports, reportsSchemaMissing } from "@/lib/reports/store";

export const REPORTS_TOOLS: McpTool[] = [
  {
    name: "list_reports",
    cost: "local",
    readOnly: true,
    description:
      "Client reports (white-label snapshots): every report of the workspace with site, template, sections, period, schedule (off | weekly | monthly, send day), recipients, client-link state, last/next send, and the last sent snapshots (period, date, whether a PDF exists, sent-to, error state). Local database state only — no report is rendered or sent by this call.",
    inputSchema: {
      type: "object",
      properties: {
        includeRuns: { type: "boolean", description: "kept for forward compatibility; the latest 10 snapshots are always included" },
      },
    },
    handler: async userId => {
      try {
        const reports = await listReports(userId);
        return {
          reports: reports.map(r => ({
            id: r.id,
            site: r.siteDomain,
            title: r.title,
            template: r.template,
            sections: r.sections,
            periodDays: r.periodDays,
            schedule: r.schedule,
            sendDay: r.sendDay,
            recipients: r.recipients,
            clientLink: Boolean(r.shareToken),
            lastSentAt: r.lastSentAt,
            nextSendAt: r.nextSendAt,
            runs: r.runs.slice(0, 10).map(run => ({
              id: run.id,
              periodFrom: run.periodFrom,
              periodTo: run.periodTo,
              createdAt: run.createdAt,
              hasPdf: run.hasPdf,
              sentTo: run.sentTo,
              error: run.error,
            })),
          })),
        };
      } catch (e) {
        if (reportsSchemaMissing(e)) return { notMigrated: true };
        throw e;
      }
    },
  },
];
