// T4 (docs/tasks/wave-oct/T4-index-autocheck.md) owns this file. startIndexScheduler /
// kickIndexScheduler are deliberately EMPTY in this stub: instrumentation.ts calls them at
// server start, so a throw would take the whole instance down before T4 lands. The signatures
// are the wave contract (CONTRACT.md §3).

export function startIndexScheduler(): void {}

export function kickIndexScheduler(): void {}
