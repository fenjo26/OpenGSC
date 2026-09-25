// T2 (docs/tasks/wave-oct/T2-uptime.md) owns this file and replaces the throwing bodies.
// The signatures below are the wave contract (CONTRACT.md §3) — every caller in the wave
// compiles against them from the first commit.

import type { UptimeBadge, UptimeSummary, UptimeWorkspaceSettings } from "./types";

export async function uptimeBadges(userId: string): Promise<UptimeBadge[]> {
  throw new Error("wave: uptimeBadges not implemented (T2)");
}

export async function uptimeSummary(userId: string, siteId: string): Promise<UptimeSummary | null> {
  throw new Error("wave: uptimeSummary not implemented (T2)");
}

export async function upsertMonitor(userId: string, siteId: string, patch: Partial<UptimeSummary["monitor"]>): Promise<UptimeSummary> {
  throw new Error("wave: upsertMonitor not implemented (T2)");
}

export async function getUptimeSettings(userId: string): Promise<UptimeWorkspaceSettings> {
  throw new Error("wave: getUptimeSettings not implemented (T2)");
}

export async function saveUptimeSettings(userId: string, s: UptimeWorkspaceSettings): Promise<void> {
  throw new Error("wave: saveUptimeSettings not implemented (T2)");
}
