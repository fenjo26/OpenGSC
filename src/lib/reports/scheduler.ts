// N8 (docs/tasks/wave-nov/N8-client-reports.md) owns this file. startReportsScheduler is
// deliberately EMPTY in this stub: instrumentation.ts calls it at server start, so a throw
// would take the whole instance down before N8 lands. The signature is the wave contract
// (CONTRACT.md §3); the real scheduler ticks hourly and renders/sends due reports.

export function startReportsScheduler(): void {}
