// SERP Monitor — run collector. Stub: T3 owns the implementation (see docs/tasks/serp-monitor/).
import type { RunSummary } from "./types";

export async function startRun(userId: string, projectId: string, trigger: "schedule" | "manual", opts?: { force?: boolean }):
  Promise<{ runId: string } | { error: "not_found" | "already_running" | "cooldown" | "no_creds" | "no_keywords" }> {
  throw new Error("serpmon: startRun not implemented (T3)");
}

/** Advance one running run until `deadline` (epoch ms). Resumable: keywords that already have a snapshot for this run are skipped. */
export async function advanceRun(runId: string, deadline: number): Promise<{ done: boolean; processed: number }> {
  throw new Error("serpmon: advanceRun not implemented (T3)");
}

export async function finalizeRun(runId: string): Promise<RunSummary> {
  throw new Error("serpmon: finalizeRun not implemented (T3)");
}
