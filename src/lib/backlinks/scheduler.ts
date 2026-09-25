// N2 (docs/tasks/wave-nov/N2-backlink-toxicity.md) owns this file. startBacklinkToxScheduler
// is deliberately EMPTY in this stub: instrumentation.ts calls it at server start, so a throw
// would take the whole instance down before N2 lands. The signature is the wave contract
// (CONTRACT.md §3); the real scheduler ticks hourly and recalculates sites with new donors.

export function startBacklinkToxScheduler(): void {}
