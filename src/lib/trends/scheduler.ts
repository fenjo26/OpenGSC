// N5 (docs/tasks/wave-nov/N5-trend-radar.md) owns this file. startTrendsScheduler is
// deliberately EMPTY in this stub: instrumentation.ts calls it at server start, so a throw
// would take the whole instance down before N5 lands. The signature is the wave contract
// (CONTRACT.md §3); the real scheduler runs the three sources once a day per site.

export function startTrendsScheduler(): void {}
