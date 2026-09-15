// SERP Monitor — scheduler. Stub: T3 owns the implementation (see docs/tasks/serp-monitor/).
// Deliberately empty no-ops, not throws: instrumentation.ts calls startSerpmonScheduler() at
// server start, so a throwing stub would take the whole process down until T3 lands.

export function startSerpmonScheduler(): void {
  // no-op until T3
}

/** Wake the loop now (after a manual start) instead of waiting for the next tick. */
export function kickSerpmonScheduler(): void {
  // no-op until T3
}
