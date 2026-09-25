// Trend radar — the daily watcher (N5). Same shape as the serpmon/mentions schedulers: runs
// inside the Next server process from instrumentation, keeps a `running` flag against overlap,
// and disables itself when the Trend* tables are missing (pulled-but-not-pushed window).
//
// Tick = 1 h. Sites eligible (the brief): at least one TrendSeed OR GSC data in the local
// store, not archived, not hidden. A site counts as "already run today" when any of its
// TrendItems carries a lastSeenAt within 24 h — and, for sites whose run produced nothing at
// all (or failed), an in-memory lastAttempt map plays the same role, so an empty portfolio
// cannot turn the loop into three GSC calls an hour per site. Google suggest's own
// "unavailable today" state is checked inside runTrends, per source.
//
// Up to 3 sites per owner and 8 sites per tick: the daily cadence spreads a portfolio over a
// few hours instead of bursting every source at once. All external work runs inside
// withCallContext so it lands in the provider journal under the site owner.

import { prisma } from "@/lib/prisma";
import { withCallContext } from "@/lib/providerLog/context";
import { runTrends } from "./store";

const TICK_MS = 60 * 60_000;        // hourly
const FIRST_TICK_MS = 120_000;      // first pass shortly after boot, like the digest loop
const RUN_EVERY_MS = 24 * 60 * 60_000;
const MAX_SITES_PER_TICK = 8;
const MAX_SITES_PER_OWNER = 3;

let started = false;
let running = false;
let kickQueued = false;
/** Set when the Trend* tables are missing — the tick stops retrying until restart. */
let disabled = false;

/** siteId → ISO day of the last automatic attempt — an empty/failed run must not retry hourly. */
const lastAttempt = new Map<string, string>();

const isoDay = () => new Date().toISOString().slice(0, 10);

async function tick(): Promise<void> {
  if (running || disabled) return;
  running = true;
  try {
    // Sites worth watching: a seed means the operator asked for suggest, local web rollup rows
    // mean the site actually has Search Console history. Two indexed-shape queries.
    const [candidates, ranRecently] = await Promise.all([
      prisma.site.findMany({
        where: {
          archivedAt: null,
          hidden: false,
          OR: [
            { trendSeeds: { some: {} } },
            { metrics: { some: { url: "", query: "", searchType: "web" } } },
          ],
        },
        select: { id: true, userId: true },
        take: 500,
      }),
      prisma.trendItem.findMany({
        where: { lastSeenAt: { gte: new Date(Date.now() - RUN_EVERY_MS) } },
        select: { siteId: true },
        distinct: ["siteId"],
      }),
    ]);

    const today = isoDay();
    const ran = new Set(ranRecently.map(r => r.siteId));
    const due = candidates.filter(s => !ran.has(s.id) && lastAttempt.get(s.id) !== today);

    // Spread the load: cap per owner first, then per tick, oldest work first is not tracked —
    // the daily cadence makes order irrelevant, every due site runs within a few ticks.
    const perOwner = new Map<string, number>();
    const chosen: { id: string; userId: string }[] = [];
    for (const s of due) {
      if (chosen.length >= MAX_SITES_PER_TICK) break;
      const n = perOwner.get(s.userId) ?? 0;
      if (n >= MAX_SITES_PER_OWNER) continue;
      perOwner.set(s.userId, n + 1);
      chosen.push(s);
    }

    for (const s of chosen) {
      lastAttempt.set(s.id, today);
      try {
        await withCallContext({ userId: s.userId, feature: "trends-cron", captureBodies: false }, () =>
          runTrends(s.userId, s.id, {}),
        );
      } catch (e) {
        console.warn(`[trends-cron] run for site ${s.id} failed:`, e);
      }
    }
  } catch (e) {
    const value = e as { code?: string; message?: string };
    if (value?.code === "P2021" || /Trend(?:Seed|Item).*(?:does not exist|no such table)/i.test(String(value?.message ?? ""))) {
      disabled = true;
      console.warn("[trends-cron] Trend tables missing — scheduler disabled until restart");
      return;
    }
    console.warn("[trends-cron] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startTrendsScheduler(): void {
  if (started) return;
  started = true;
  console.log("[trends-cron] scheduler started");
  setTimeout(() => void tick(), FIRST_TICK_MS);
  setInterval(() => void tick(), TICK_MS);
}

/**
 * Wake the loop now — the run route calls this after a manual refresh, so a site the operator
 * just seeded gets its first automatic pass within seconds. Coalesced like the other loops.
 */
export function kickTrendsScheduler(): void {
  if (!started || running || disabled || kickQueued) return;
  kickQueued = true;
  setTimeout(() => {
    kickQueued = false;
    void tick();
  }, 0);
}
