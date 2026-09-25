// T4 (docs/tasks/wave-oct/T4-index-autocheck.md) owns this file and replaces the throwing bodies.
// The signatures below are the wave contract (CONTRACT.md §3) — every caller in the wave
// compiles against them from the first commit.

export async function quotaToday(property: string): Promise<{ day: string; used: number; auto: number; exhausted: boolean }> {
  throw new Error("wave: quotaToday not implemented (T4)");
}

export async function recordInspections(property: string, n: number, opts: { auto: boolean; errors?: number; exhausted?: boolean }): Promise<void> {
  throw new Error("wave: recordInspections not implemented (T4)");
}

export async function remainingToday(property: string, autoBudget: number): Promise<number> {
  throw new Error("wave: remainingToday not implemented (T4)");
}
