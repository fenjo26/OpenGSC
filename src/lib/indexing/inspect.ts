// T4 (docs/tasks/wave-oct/T4-index-autocheck.md) owns this file and replaces the throwing bodies.
// The signatures below are the wave contract (CONTRACT.md §3) — every caller in the wave
// compiles against them from the first commit.

import type { InspectOutcome } from "./types";

export async function inspectUrls(userId: string, siteDbId: string, urls: string[], opts: { auto: boolean }): Promise<InspectOutcome[]> {
  throw new Error("wave: inspectUrls not implemented (T4)");
}
