// T2 (docs/tasks/wave-oct/T2-uptime.md) owns this file. startUptimeScheduler / kickUptimeScheduler
// are deliberately EMPTY in this stub: instrumentation.ts calls them at server start, so a throw
// would take the whole instance down before T2 lands. The signatures are the wave contract
// (CONTRACT.md §3).

import type { UptimeCheckResult } from "./types";

export function startUptimeScheduler(): void {}

export function kickUptimeScheduler(): void {}

export async function checkMonitorNow(userId: string, siteId: string): Promise<UptimeCheckResult> {
  throw new Error("wave: checkMonitorNow not implemented (T2)");
}
