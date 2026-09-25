// T4 (docs/tasks/wave-oct/T4-index-autocheck.md) owns this file and replaces the throwing bodies.
// The signatures below are the wave contract (CONTRACT.md §3) — every caller in the wave
// compiles against them from the first commit.

import type { InspectCandidate, InspectOutcome, IndexInspectSettings } from "./types";

export function pacificDay(d: Date): string {
  throw new Error("wave: pacificDay not implemented (T4)");
}

export function pickInspectBatch(rows: { url: string; firstSeenAt: Date; googleChecked: Date | null; googleNextCheck: Date | null; googleStatus: string | null; changeStatus: string; inventoryStatus: string }[], now: Date, limit: number): InspectCandidate[] {
  throw new Error("wave: pickInspectBatch not implemented (T4)");
}

export function nextCheckAt(outcome: InspectOutcome, settings: IndexInspectSettings, now: Date): Date {
  throw new Error("wave: nextCheckAt not implemented (T4)");
}

export function isIndexedCoverage(coverageState: string | null, verdict: string | null): boolean | null {
  throw new Error("wave: isIndexedCoverage not implemented (T4)");
}
