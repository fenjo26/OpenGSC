// Google's published ranking updates, fetched once per process and shared.
//
// Two places need this list: the site chart, which draws a marker per update, and the Annotations
// tab, which scores traffic before and after each one. Keeping the fetch here rather than in
// either route means one cache and one definition of what counts as an update.
//
// The feed is undocumented. It is what status.search.google.com renders, and its shape has held,
// but undocumented means it can change without warning — so every failure path falls back to the
// list compiled in `algoUpdates.ts` rather than returning an error. A chart missing this year's
// updates is a smaller problem than a chart that refuses to draw.

import { ALGO_UPDATES, mapIncidentsToUpdates, type AlgoUpdate } from "@/lib/algoUpdates";

const FEED = "https://status.search.google.com/incidents.json";

/**
 * Updates are announced monthly at most, so an hour is already far fresher than the data being
 * annotated: Search Console itself lags two to three days.
 */
const TTL_MS = 60 * 60 * 1000;

export type AlgoUpdateSource = "google" | "builtin";

let cache: { at: number; updates: AlgoUpdate[]; source: AlgoUpdateSource } | null = null;

export async function getAlgoUpdates(): Promise<{ updates: AlgoUpdate[]; source: AlgoUpdateSource; cached: boolean }> {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return { updates: cache.updates, source: cache.source, cached: true };
  }

  try {
    const res = await fetch(FEED, {
      headers: { Accept: "application/json", "User-Agent": "OpenGSC" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);

    const raw = await res.json();
    if (!Array.isArray(raw)) throw new Error("unexpected payload");

    const fetched = mapIncidentsToUpdates(raw);
    // Empty means the feed parsed but nothing matched, which reads as a shape change. Treat it as
    // a failure rather than quietly replacing a good list with nothing.
    if (!fetched.length) throw new Error("no ranking updates in feed");

    // Merged, not replaced: the feed reaches back about a year while the built-in list goes to
    // 2023, and a 16-month Search Console window can span both.
    const seen = new Set(fetched.map(u => `${u.date}|${u.type}`));
    const merged = [...fetched, ...ALGO_UPDATES.filter(u => !seen.has(`${u.date}|${u.type}`))]
      .sort((a, b) => a.date.localeCompare(b.date));

    cache = { at: Date.now(), updates: merged, source: "google" };
    return { updates: merged, source: "google", cached: false };
  } catch {
    // Failures are cached too, so an unreachable feed does not cost ten seconds on every render.
    cache = { at: Date.now(), updates: ALGO_UPDATES, source: "builtin" };
    return { updates: ALGO_UPDATES, source: "builtin", cached: false };
  }
}
