// MCP tools for browser SERP captures (wave-ext E5) — pages saved from the extension's overlay.
// Local reads of SerpCapture only: a capture is personalised (the user's own IP) and never part
// of diffs/storms, which the tool description states up front.

import { type Json, type McpTool, lim } from "./shared";
import { listCaptures, captureView } from "@/lib/ext/serpCapture";

export const SERP_CAPTURE_TOOLS: McpTool[] = [
  {
    name: "serpmon_captures",
    cost: "local",
    idempotent: true,
    description:
      "List SERP pages saved from the browser extension (personalised, user's own IP — never part of diffs or storms). Filter by projectId or keyword; with captureId returns the rows and, with compare: \"nearest\", the host-level diff against the nearest automated snapshot of the same keyword.",
    inputSchema: { type: "object", properties: {
      projectId: { type: "string" }, keyword: { type: "string" }, captureId: { type: "string" },
      compare: { type: "string", description: "\"nearest\" or a snapshot id" },
      limit: { type: "number", description: "default 20, max 100" },
    } },
    handler: async (userId, args: Json) => {
      const captureId = String(args.captureId ?? "").trim();
      if (captureId) {
        const compare = String(args.compare ?? "").trim() || undefined;
        const view = await captureView(userId, captureId, (compare as "nearest" | string | undefined) ?? undefined);
        if (!view) throw new Error("capture not found");
        return { capture: view };
      }
      const captures = await listCaptures(userId, {
        projectId: String(args.projectId ?? "") || undefined,
        keyword: String(args.keyword ?? "") || undefined,
        limit: lim(args.limit, 20, 100),
      });
      return { count: captures.length, captures };
    },
  },
];
