// T2 (docs/tasks/wave-oct/T2-uptime.md) owns this file and replaces the throwing bodies.
// The signatures below are the wave contract (CONTRACT.md §3) — every caller in the wave
// compiles against them from the first commit.

import type { UptimeCheckResult } from "./types";

export function parseAcceptStatus(spec: string): (code: number) => boolean {
  throw new Error("wave: parseAcceptStatus not implemented (T2)");
}

export function classifyCheck(input: { httpStatus: number | null; latencyMs: number | null; error: unknown; bodyHasKeyword: boolean | null }, monitor: { acceptStatus: string; slowMs: number }): UptimeCheckResult {
  throw new Error("wave: classifyCheck not implemented (T2)");
}

export async function runUptimeCheck(monitor: { url: string; timeoutMs: number; acceptStatus: string; keyword: string; slowMs: number }): Promise<UptimeCheckResult> {
  throw new Error("wave: runUptimeCheck not implemented (T2)");
}
