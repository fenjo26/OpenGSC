// MCP tools for browser SERP captures (wave-ext E5) — pages saved from the extension's overlay.
// Local reads of SerpCapture only: a capture is personalised (the user's own IP) and never part
// of diffs/storms, which the tool descriptions state up front. E0 registers the tool; E5 wires
// the handler to listCaptures/captureView.

import { type Json, type McpTool } from "./shared";

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
    handler: async (_userId: string, _args: Json) => {
      throw new Error("not_implemented");
    },
  },
];
