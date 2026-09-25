// N4 (docs/tasks/wave-nov/N4-local-seo.md) owns this file. startLocalScheduler is deliberately
// EMPTY in this stub: instrumentation.ts calls it at server start, so a throw would take the
// whole instance down before N4 lands. The signature is the wave contract (CONTRACT.md §3);
// the real scheduler ticks every 10 minutes (GBP posts, reviews every 6 h, citations weekly).

export function startLocalScheduler(): void {}
