// SERP Monitor — storm alerts. Stub: T6 owns the implementation (see docs/tasks/serp-monitor/).
import type { RunSummary } from "./types";

/** Called by finalizeRun once per done run. Never throws: logs and returns. */
export async function serpmonRunAlerts(userId: string, project: { id: string; name: string; alertStorm: boolean }, run: RunSummary): Promise<void> {
  throw new Error("serpmon: serpmonRunAlerts not implemented (T6)");
}

export async function sendSerpmonTestAlert(userId: string, projectId: string): Promise<{ ok: boolean; error?: string }> {
  throw new Error("serpmon: sendSerpmonTestAlert not implemented (T6)");
}

/** Pure: the message text. */
export function stormAlertText(lang: string, input: { project: string; run: RunSummary; topKeywords: string[]; topHosts: { host: string; enters: number; exits: number }[] }): string {
  throw new Error("serpmon: stormAlertText not implemented (T6)");
}
