// T2 (docs/tasks/wave-oct/T2-uptime.md) owns this file and replaces the throwing bodies.
// The signatures below are the wave contract (CONTRACT.md §3) — every caller in the wave
// compiles against them from the first commit.

import type { UptimeCheckResult, UptimeStatus } from "./types";

export interface MonitorState { status: UptimeStatus; consecutiveFails: number; openIncidentId: string | null }

export type Transition = "none" | "confirm_pending" | "went_down" | "recovered" | "degraded" | "undegraded";

export function nextState(prev: MonitorState, result: UptimeCheckResult, failThreshold: number): { state: MonitorState; transition: Transition } {
  throw new Error("wave: nextState not implemented (T2)");
}

export function isCheckerOffline(results: { ok: boolean }[]): boolean {
  throw new Error("wave: isCheckerOffline not implemented (T2)");
}
