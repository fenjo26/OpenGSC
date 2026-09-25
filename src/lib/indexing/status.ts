// T4 (docs/tasks/wave-oct/T4-index-autocheck.md) owns this file and replaces the throwing bodies.
// The signatures below are the wave contract (CONTRACT.md §3) — every caller in the wave
// compiles against them from the first commit.

import type { IndexAutoStatus, IndexInspectSettings } from "./types";

export async function indexAutoStatus(userId: string, siteDbId: string): Promise<IndexAutoStatus | null> {
  throw new Error("wave: indexAutoStatus not implemented (T4)");
}

export async function saveIndexInspect(userId: string, siteDbId: string, s: IndexInspectSettings): Promise<void> {
  throw new Error("wave: saveIndexInspect not implemented (T4)");
}
