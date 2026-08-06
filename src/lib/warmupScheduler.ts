import { prisma } from "@/lib/prisma";
import { rawQuery, rawExec } from "@/lib/db/raw";
import { fetchKeywordMetrics, estimateKeywordUnits, type MetricsProvider } from "@/lib/seo/metrics";
import {
  readKeywordCache, writeKeywordCache, staleKeywords, recordUsage, releaseUnusedUnits,
  withinCap, normalizeKeyword,
} from "@/lib/seo/metricsStore";
import { marketFor } from "@/lib/seo/market";

// Keeps the keyword cache warm without anyone pressing anything.
//
// The cache has a 30-day TTL, so coverage decays on its own: a portfolio warmed today is back to
// showing em dashes in a month. The manual button is the right default — it spends money, and
// money should be spent on purpose — but re-pressing it every month for 200 sites is the kind of
// chore that quietly stops happening, and then the tool is back to guessing.
//
// Three rules keep this from becoming a surprise on the invoice:
//
//   1. **Off unless switched on.** No user gets this by accident; it is opted into in Settings.
//   2. **Its own cap, separate from the manual one.** An automatic spender that shares the
//      interactive budget can starve the button a human is standing in front of.
//   3. **Only what is missing.** Anything already cached and fresh costs nothing, so a portfolio
//      that is already warm produces no request at all.

const TICK_MS = 6 * 60 * 60 * 1000;      // every 6 hours; the work itself is monthly
const MIN_GAP_MS = 25 * 24 * 60 * 60 * 1000; // ~25 days: just inside the 30-day TTL
const MAX_KEYWORDS_PER_RUN = 3000;

let started = false;
let running = false;

export interface WarmupSchedule {
  enabled: boolean;
  /** Units this schedule may spend per month, independent of the interactive cap. */
  cap: number;
  withDifficulty: boolean;
  lastRunAt: string | null;
}

export const DEFAULT_WARMUP_SCHEDULE: WarmupSchedule = {
  enabled: false,
  cap: 50_000,
  withDifficulty: false,
  lastRunAt: null,
};

/**
 * Settings live in `User.seoSettings` alongside the API keys, read with raw SQL.
 *
 * Same convention as digest and sync settings: an instance that has not migrated gets the
 * defaults rather than an exception, so a missing column reads as "the feature is off".
 */
async function readSettings(userId: string): Promise<{
  schedule: WarmupSchedule;
  provider: MetricsProvider;
  apiKey: string;
  baseUrl?: string;
}> {
  const blank = { schedule: DEFAULT_WARMUP_SCHEDULE, provider: "ahrefs" as MetricsProvider, apiKey: "" };
  try {
    const rows: any[] = await rawQuery(`SELECT seoSettings FROM "User" WHERE id = ?`, userId);
    const raw = rows?.[0]?.seoSettings;
    if (!raw) return blank;
    const s = JSON.parse(raw) as Record<string, any>;

    const provider: MetricsProvider = s.seoMetricsProvider === "semrush" ? "semrush" : "ahrefs";
    const mode = String(s[`seoMetricsMode_${provider}`] ?? "");
    const slot = mode === "reseller" || mode === "custom"
      ? `seoKey_${provider}__${mode}`
      : `seoKey_${provider}`;

    return {
      schedule: { ...DEFAULT_WARMUP_SCHEDULE, ...(s.seoWarmupSchedule ?? {}) },
      provider,
      apiKey: String(s[slot] ?? s[`seoKey_${provider}`] ?? "").trim(),
      baseUrl: String(s[`seoMetricsBaseUrl_${provider}`] ?? "").trim() || undefined,
    };
  } catch { return blank; }
}

async function saveLastRun(userId: string, at: string): Promise<void> {
  try {
    const rows: any[] = await rawQuery(`SELECT seoSettings FROM "User" WHERE id = ?`, userId);
    const s = JSON.parse(rows?.[0]?.seoSettings ?? "{}");
    s.seoWarmupSchedule = { ...DEFAULT_WARMUP_SCHEDULE, ...(s.seoWarmupSchedule ?? {}), lastRunAt: at };
    // `rawExec`, not `rawQuery`: the latter is for SELECTs and returns rows. Writing through it
    // works on SQLite by accident and is the wrong call on MySQL, where the driver distinguishes
    // a query from a statement — the schedule would then never record that it had run and would
    // re-spend on every tick.
    await rawExec(`UPDATE "User" SET seoSettings = ? WHERE id = ?`, JSON.stringify(s), userId);
  } catch { /* best effort, same as everything else that writes here */ }
}

async function warmOneUser(userId: string): Promise<void> {
  const { schedule, provider, apiKey, baseUrl } = await readSettings(userId);
  if (!schedule.enabled || !apiKey) return;

  const since = schedule.lastRunAt ? Date.now() - new Date(schedule.lastRunAt).getTime() : Infinity;
  if (since < MIN_GAP_MS) return;

  const sites = await prisma.site.findMany({
    where: { userId, archivedAt: null },
    select: { id: true, url: true, siteId: true, market: true },
  });

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);

  // Grouped by market, because the cache is keyed by it and the same phrase in two countries is
  // two different purchases. A site with no resolvable market is skipped, never folded into `us`.
  const byCountry = new Map<string, Set<string>>();
  let budget = MAX_KEYWORDS_PER_RUN;

  for (const site of sites) {
    if (budget <= 0) break;
    const country = marketFor(site);
    if (!country) continue;

    const rows = await prisma.dailyMetric.groupBy({
      by: ["query"],
      where: { siteId: site.id, date: { gte: cutoff }, position: { gte: 4, lte: 20 } },
      _sum: { impressions: true },
      having: { impressions: { _sum: { gte: 10 } } },
      orderBy: { _sum: { impressions: "desc" } },
      take: Math.min(budget, 500),
    });

    const set = byCountry.get(country) ?? new Set<string>();
    for (const r of rows as unknown as { query: string }[]) {
      const kw = normalizeKeyword(String(r.query ?? ""));
      if (!kw || kw.includes(",")) continue;
      if (!set.has(kw)) { set.add(kw); budget--; }
      if (budget <= 0) break;
    }
    byCountry.set(country, set);
  }

  let fetched = 0;
  for (const [country, set] of byCountry) {
    const keywords = [...set];
    if (!keywords.length) continue;

    const cache = await readKeywordCache(keywords, country, provider);
    const stale = staleKeywords(keywords, cache, { needDifficulty: schedule.withDifficulty });
    if (!stale.length) continue;

    const units = estimateKeywordUnits(stale.length, schedule.withDifficulty);
    // The schedule's own cap, checked against total monthly spend. Deliberately conservative:
    // stopping early leaves the manual button able to finish the job, while overshooting leaves
    // a human unable to buy anything for the rest of the month.
    if (!(await withinCap(userId, provider, units, schedule.cap))) break;

    await recordUsage(userId, provider, units);
    const res = await fetchKeywordMetrics({ provider, apiKey, baseUrl }, stale, {
      country, withDifficulty: schedule.withDifficulty,
    });
    if (res.error) {
      await releaseUnusedUnits(userId, provider, units, 0);
      console.warn(`[warmup-cron] ${country}: ${res.error}`);
      continue;
    }
    await releaseUnusedUnits(userId, provider, units, estimateKeywordUnits(Math.max(1, res.items.length), schedule.withDifficulty));
    await writeKeywordCache(res.items, country, provider, "api");
    fetched += res.items.length;
  }

  await saveLastRun(userId, new Date().toISOString());
  if (fetched) console.log(`[warmup-cron] user ${userId}: ${fetched} keywords refreshed`);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const users = await prisma.user.findMany({ select: { id: true } });
    for (const u of users) {
      try { await warmOneUser(u.id); }
      catch (e) { console.warn(`[warmup-cron] user ${u.id} failed:`, e); }
    }
  } catch (e) {
    console.warn("[warmup-cron] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startWarmupScheduler() {
  if (started) return;
  started = true;
  // First tick deferred: the server has better things to do in its first minutes than spend money.
  setTimeout(() => { tick().catch(() => {}); }, 5 * 60 * 1000);
  setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  console.log("[warmup-cron] scheduler started");
}
