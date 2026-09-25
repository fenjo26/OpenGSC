// N5 (docs/tasks/wave-nov/N5-trend-radar.md) owns src/lib/trends/** — the public face of the
// trend radar. Layout:
//   logic.ts    — pure arithmetic: windows with the GSC lag, growth/score, suggest parsing,
//                 request budget, notification lines (tested by logic.test.ts)
//   sources.ts  — Google suggest over safeFetch, the ≥1 s pause, "unavailable today" state
//   store.ts    — TrendSeed/TrendItem queries, the three-source run, the deduped notification
//   scheduler.ts— the daily loop started from instrumentation.ts
// Types live in types.ts; this file just re-exports the surface routes/MCP/UI import.

export { trendsSchemaMissing, listSeeds, addSeed, removeSeed, listTrends, runTrends, setDismissed } from "./store";
export { suggestUnavailableToday } from "./sources";
export { startTrendsScheduler, kickTrendsScheduler } from "./scheduler";
export { TREND_SOURCES } from "./types";
export type { TrendRow, TrendSeedRow, TrendSource, TrendSourceResult, TrendRunResult } from "./types";
export type { TrendListResult } from "./store";
