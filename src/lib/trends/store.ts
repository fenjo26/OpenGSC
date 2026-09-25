// Trend radar (N5) — the module that owns queries. Routes, the scheduler and the MCP tool all
// read and write through here, so the invariants live once (same shape as mentions/store.ts):
//
//   - every function that takes a userId first verifies the site belongs to that user — a
//     foreign id is indistinguishable from a missing one;
//   - a missing TrendSeed/TrendItem table surfaces as { notMigrated: true }, never a 500;
//   - inserts read existing (source, query) keys first and split into insert/update —
//     createMany({ skipDuplicates }) does not exist on SQLite (README §5);
//   - per-day notification is deduped through AlertEvent's unique dedupeKey, like alert-cron.
//
// WHY gsc_rising/gsc_new READ SEARCH CONSOLE LIVE INSTEAD OF DailyMetric. The brief names
// DailyMetric, but the sync stores query rows as a single 90-day aggregate stamped with the
// sync date (gscSync.ts step 4) — there are no per-day query rows anywhere, so a 7-vs-28
// comparison from the local store is impossible by construction. /api/gsc/decay/position
// documents the same trap and the same way out: ask Search Console for the two windows
// directly. Three quota calls per site per day, and DailyMetric still anchors them — the
// windows END at the last date with data, read from the local rollup rows, so the 2–3 day
// GSC lag can never compare a full week against a partial one.

import { prisma } from "@/lib/prisma";
import { getUserGoogleAccounts, queryGsc } from "@/lib/gscQuery";
import { notifyUser } from "@/lib/notify";
import { NOTIFY_L, normalizeLang } from "@/lib/notifyI18n";
import { getAlertSettings } from "@/lib/alertScheduler";
import { defaultLanguageFor } from "@/lib/seo/regions";
import {
  MAX_ITEMS_PER_SOURCE,
  MAX_SEEDS_PER_SITE,
  hideBefore,
  newRows,
  nextSuggestScore,
  notifyLines,
  risingRows,
  suggestPlan,
  trendWindows,
} from "./logic";
import {
  SuggestUnavailableError,
  fetchSuggest,
  markSuggestUnavailable,
  suggestUnavailableToday,
} from "./sources";
import { TREND_SOURCES, type TrendRow, type TrendRunResult, type TrendSeedRow, type TrendSource, type TrendSourceResult } from "./types";

/** P2021 or the SQLite "no such table" text — the pulled-but-not-pushed window (README §5). */
export function trendsSchemaMissing(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" ||
    /Trend(?:Seed|Item).*(?:does not exist|no such table)/i.test(String(value?.message ?? ""))
  );
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const siteLabel = (url: string) => url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/$/, "");
/** When the local store says nothing (never synced), fall back to the classic 3-day lag. */
const GSC_LAG_FALLBACK_DAYS = 3;
const INSERT_CHUNK = 50; // rows per createMany — 9 fields each, far under SQLite's 999 params

async function ownedSite(
  userId: string,
  siteDbId: string,
): Promise<{ id: string; url: string; siteId: string; market: string | null }> {
  const site = await prisma.site.findFirst({
    where: { id: siteDbId, userId },
    select: { id: true, url: true, siteId: true, market: true },
  });
  if (!site) throw new Error("site_not_found");
  return site;
}

/** The last date the site's web rollup has impressions for — windows end here (the GSC lag). */
async function lastGscDataDate(siteDbId: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const row = await prisma.dailyMetric.findFirst({
    where: { siteId: siteDbId, url: "", query: "", searchType: "web", impressions: { gt: 0 } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  if (!row) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - GSC_LAG_FALLBACK_DAYS);
    return d.toISOString().slice(0, 10);
  }
  const iso = row.date.toISOString().slice(0, 10);
  return iso > today ? today : iso; // a clock-skewed future row must not anchor the windows ahead
}

/** query→impressions map for one window, straight from Search Console (grouped by query). */
async function gscQueryMap(
  accounts: Awaited<ReturnType<typeof getUserGoogleAccounts>>,
  gscSiteUrl: string,
  startDate: string,
  endDate: string,
): Promise<Map<string, number>> {
  const rows = (await queryGsc(accounts, gscSiteUrl, {
    startDate, endDate, dimensions: ["query"], rowLimit: 5000,
  })) as { keys?: string[] | null; impressions?: number | null }[];
  const map = new Map<string, number>();
  for (const r of rows) {
    const q = (r.keys?.[0] ?? "").trim().toLowerCase().slice(0, 200);
    if (!q) continue;
    map.set(q, (map.get(q) ?? 0) + (r.impressions ?? 0));
  }
  return map;
}

// ── Seeds ─────────────────────────────────────────────────────────────────────

export async function listSeeds(userId: string, siteDbId: string): Promise<TrendSeedRow[]> {
  await ownedSite(userId, siteDbId);
  const rows = await prisma.trendSeed.findMany({
    where: { siteId: siteDbId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(r => ({ id: r.id, seed: r.seed, lang: r.lang, country: r.country }));
}

export async function addSeed(
  userId: string,
  siteDbId: string,
  rawSeed: string,
  lang = "",
  country = "",
): Promise<{ ok: true; seed: string } | { ok: false; error: string }> {
  await ownedSite(userId, siteDbId);
  const seed = String(rawSeed ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 100);
  if (Array.from(seed).length < 2) return { ok: false, error: "seed_too_short" };
  const count = await prisma.trendSeed.count({ where: { siteId: siteDbId } });
  if (count >= MAX_SEEDS_PER_SITE) return { ok: false, error: "too_many_seeds" };
  try {
    await prisma.trendSeed.create({
      data: {
        siteId: siteDbId, seed,
        lang: String(lang ?? "").toLowerCase().slice(0, 8),
        country: String(country ?? "").toLowerCase().slice(0, 2),
      },
    });
  } catch {
    // unique (siteId, seed) — adding an existing seed is a no-op, not an error
  }
  return { ok: true, seed };
}

export async function removeSeed(userId: string, siteDbId: string, rawSeed: string): Promise<number> {
  await ownedSite(userId, siteDbId);
  const seed = String(rawSeed ?? "").trim().toLowerCase();
  const r = await prisma.trendSeed.deleteMany({ where: { siteId: siteDbId, seed } });
  return r.count;
}

// ── The radar feed ────────────────────────────────────────────────────────────

export interface TrendListResult {
  items: TrendRow[];
  seeds: TrendSeedRow[];
  /** Max lastSeenAt — when the sources last said anything about this site. */
  lastRunAt: string | null;
  /** Google suggest already refused today: the UI shows "unavailable today", the run skips it. */
  suggestUnavailableToday: boolean;
}

export async function listTrends(
  userId: string,
  siteDbId: string,
  opts: { source?: string; limit?: number; includeDismissed?: boolean } = {},
): Promise<TrendListResult | { notMigrated: true }> {
  await ownedSite(userId, siteDbId);
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 100) || 100));
  const source = TREND_SOURCES.includes(opts.source as TrendSource) ? (opts.source as TrendSource) : undefined;
  const where = {
    siteId: siteDbId,
    ...(opts.includeDismissed ? {} : { dismissed: false }),
    // A query its source stopped mentioning two weeks ago is not a trend anymore — hidden,
    // not deleted, so the first-seen date survives if it ever comes back.
    lastSeenAt: { gte: hideBefore(new Date()) },
    ...(source ? { source } : {}),
  };
  try {
    const [rows, lastRun, seeds] = await Promise.all([
      prisma.trendItem.findMany({
        where,
        orderBy: [{ score: "desc" }, { lastSeenAt: "desc" }],
        take: limit,
      }),
      prisma.trendItem.findFirst({ where: { siteId: siteDbId }, orderBy: { lastSeenAt: "desc" }, select: { lastSeenAt: true } }),
      prisma.trendSeed.findMany({ where: { siteId: siteDbId }, orderBy: { createdAt: "asc" } }),
    ]);
    return {
      items: rows.map(toRow),
      seeds: seeds.map(r => ({ id: r.id, seed: r.seed, lang: r.lang, country: r.country })),
      lastRunAt: lastRun?.lastSeenAt.toISOString() ?? null,
      suggestUnavailableToday: suggestUnavailableToday(siteDbId),
    };
  } catch (error) {
    if (trendsSchemaMissing(error)) return { notMigrated: true };
    throw error;
  }
}

function toRow(r: {
  id: string; source: string; query: string; score: number; impressions: number | null;
  prevImpressions: number | null; seed: string | null; firstSeenAt: Date; lastSeenAt: Date;
}): TrendRow {
  return {
    id: r.id,
    source: r.source as TrendSource,
    query: r.query,
    score: Math.round(r.score * 100) / 100,
    impressions: r.impressions,
    prevImpressions: r.prevImpressions,
    seed: r.seed,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  };
}

/** Hide (or bring back) rows — the operator's call, never automatic. */
export async function setDismissed(
  userId: string,
  siteDbId: string,
  ids: string[],
  dismissed: boolean,
): Promise<number> {
  await ownedSite(userId, siteDbId);
  const list = ids.map(String).filter(Boolean).slice(0, 200);
  if (!list.length) return 0;
  const r = await prisma.trendItem.updateMany({ where: { id: { in: list }, siteId: siteDbId }, data: { dismissed } });
  return r.count;
}

// ── The run: three sources → TrendItem rows ───────────────────────────────────

interface PendingItem {
  source: TrendSource;
  query: string;
  score: number;
  impressions: number | null;
  prevImpressions: number | null;
  seed: string | null;
  growth: number | null; // notification line material; not stored
}

export async function runTrends(
  userId: string,
  siteDbId: string,
  opts: { deep?: boolean; sources?: string[] } = {},
): Promise<TrendRunResult> {
  const site = await ownedSite(userId, siteDbId);
  const now = new Date();
  const lastDataDate = await lastGscDataDate(site.id);
  const windows = trendWindows(lastDataDate);
  const wanted = new Set<TrendSource>(
    (opts.sources ?? TREND_SOURCES).filter((s): s is TrendSource => TREND_SOURCES.includes(s as TrendSource)),
  );
  const accounts = await getUserGoogleAccounts(userId);

  // A site's very first run backfills everything at once — notifying "14 new trends" about
  // queries that rose last month is noise, so the first run stays silent (mentions precedent).
  const firstRun = (await prisma.trendItem.count({ where: { siteId: site.id } })) === 0;

  const sources: Record<TrendSource, TrendSourceResult> = {
    gsc_rising: { rows: 0, status: "skipped" },
    gsc_new: { rows: 0, status: "skipped" },
    suggest: { rows: 0, status: "skipped" },
  };
  const pending: PendingItem[] = [];

  // The recent-window map is shared by both GSC sources — one call, not two.
  let recentMap: Map<string, number> | null = null;
  const recent = async () => {
    if (!recentMap) recentMap = await gscQueryMap(accounts, site.siteId, windows.recentStart, windows.recentEnd);
    return recentMap;
  };

  // ── gsc_rising: 7 data days vs the average 7-day window of the previous 28
  if (wanted.has("gsc_rising")) {
    if (!accounts.length) {
      sources.gsc_rising = { rows: 0, status: "skipped", detail: "no_google_account" };
    } else {
      const [recentQ, prevQ] = await Promise.all([
        recent(),
        gscQueryMap(accounts, site.siteId, windows.prevStart, windows.prevEnd),
      ]);
      for (const r of risingRows(recentQ, prevQ).slice(0, MAX_ITEMS_PER_SOURCE)) {
        pending.push({
          source: "gsc_rising",
          query: r.query,
          score: r.score,
          // Display baseline: the 28-day average scaled to one window. ≥ 1 so the UI's
          // now/before division never divides by a rounded-to-zero baseline.
          impressions: r.impressions,
          prevImpressions: Math.max(1, Math.round(r.baseline)),
          seed: null,
          growth: r.growth,
        });
      }
      sources.gsc_rising = { rows: 0, status: "ok" }; // counts filled after the write
    }
  }

  // ── gsc_new: ≥10 impressions now, absent for the whole 60 days before the recent window
  if (wanted.has("gsc_new")) {
    if (!accounts.length) {
      sources.gsc_new = { rows: 0, status: "skipped", detail: "no_google_account" };
    } else {
      const [recentQ, historyQ] = await Promise.all([
        recent(),
        gscQueryMap(accounts, site.siteId, windows.historyStart, windows.historyEnd),
      ]);
      for (const r of newRows(recentQ, historyQ).slice(0, MAX_ITEMS_PER_SOURCE)) {
        pending.push({
          source: "gsc_new",
          query: r.query,
          score: r.score,
          impressions: r.impressions,
          prevImpressions: 0, // measured zero: the 60-day window was fetched and it wasn't there
          seed: null,
          growth: null,
        });
      }
      sources.gsc_new = { rows: 0, status: "ok" };
    }
  }

  // ── suggest: Google autocomplete for the operator's seeds
  if (wanted.has("suggest")) {
    const seeds = await prisma.trendSeed.findMany({ where: { siteId: site.id }, orderBy: { createdAt: "asc" } });
    if (!seeds.length) {
      sources.suggest = { rows: 0, status: "skipped", detail: "no_seeds" };
    } else if (suggestUnavailableToday(site.id)) {
      sources.suggest = { rows: 0, status: "skipped_unavailable" };
    } else {
      const seedPhrases = new Set(seeds.map(s => s.seed));
      const langOf = (s: TrendSeedRow) => s.lang || defaultLanguageFor(site.market ?? "");
      const glOf = (s: TrendSeedRow) => s.country || site.market || "us";
      const plan = suggestPlan(seeds.map(s => s.seed), !!opts.deep);
      const found = new Map<string, string>(); // suggestion → the seed that produced it
      let unavailable = false;
      for (let i = 0; i < plan.length; i++) {
        const seedRow = seeds.find(s => s.seed === plan[i] || plan[i].startsWith(`${s.seed} `)) ?? seeds[0];
        try {
          const list = await fetchSuggest(plan[i], langOf(seedRow), glOf(seedRow));
          for (const q of list) {
            if (seedPhrases.has(q) || found.has(q)) continue; // the seed itself is not a discovery
            found.set(q, seedRow.seed);
          }
        } catch (e) {
          // One refused request turns the source off for today — no retry hammering. Whatever
          // earlier requests collected is real and kept.
          if (e instanceof SuggestUnavailableError) {
            markSuggestUnavailable(site.id);
            unavailable = true;
            break;
          }
          throw e;
        }
      }
      // Repeat sightings score up; dismissed suggestions stay hidden (the operator said so).
      const existing = new Map(
        (await prisma.trendItem.findMany({
          where: { siteId: site.id, source: "suggest" },
          select: { query: true, score: true, dismissed: true },
        })).map(r => [r.query, r]),
      );
      for (const [query, seed] of found) {
        const prev = existing.get(query);
        if (prev?.dismissed) continue;
        pending.push({
          source: "suggest",
          query,
          score: nextSuggestScore(!!prev, prev?.score ?? null),
          impressions: null,     // autocomplete has no volume — null, never 0
          prevImpressions: null,
          seed,
          growth: null,
        });
      }
      sources.suggest = unavailable
        ? { rows: 0, status: "skipped_unavailable" }
        : { rows: 0, status: "ok" };
    }
  }

  // ── write: read existing keys, split into insert/update (README §5), count the new ones
  let inserted = 0;
  let updated = 0;
  const newlyInserted: PendingItem[] = []; // the run's genuinely new rows — notification material
  for (const source of TREND_SOURCES) {
    const rows = pending.filter(p => p.source === source);
    if (!rows.length) continue;
    const existingKeys = new Set(
      (await prisma.trendItem.findMany({
        where: { siteId: site.id, source, query: { in: rows.map(r => r.query) } },
        select: { query: true },
      })).map(r => r.query),
    );
    const fresh = rows.filter(r => !existingKeys.has(r.query));
    const seen = rows.filter(r => existingKeys.has(r.query));
    newlyInserted.push(...fresh);
    for (let i = 0; i < fresh.length; i += INSERT_CHUNK) {
      await prisma.trendItem.createMany({
        data: fresh.slice(i, i + INSERT_CHUNK).map(r => ({
          siteId: site.id,
          source: r.source,
          query: r.query,
          score: r.score,
          impressions: r.impressions,
          prevImpressions: r.prevImpressions,
          seed: r.seed,
          firstSeenAt: now,
          lastSeenAt: now,
        })),
      });
    }
    for (const r of seen) {
      await prisma.trendItem.updateMany({
        where: { siteId: site.id, source: r.source, query: r.query },
        // dismissed is untouched on update: a hidden row stays hidden even while its source
        // still reports it.
        data: {
          score: r.score,
          impressions: r.impressions,
          prevImpressions: r.prevImpressions,
          ...(r.seed != null ? { seed: r.seed } : {}),
          lastSeenAt: now,
        },
      });
    }
    inserted += fresh.length;
    updated += seen.length;
    sources[source] = { rows: rows.length, status: sources[source].status };
  }

  // ── the once-a-day notification, deduped through AlertEvent
  if (!firstRun && newlyInserted.length) {
    try {
      await notifyAboutNewRows(userId, site, newlyInserted);
    } catch (e) {
      console.warn(`[trends] notify for site ${site.id} failed:`, e);
    }
  }

  return { ranAt: now.toISOString(), lastDataDate, inserted, updated, sources };
}

async function notifyAboutNewRows(
  userId: string,
  site: { id: string; url: string },
  fresh: PendingItem[],
): Promise<void> {
  const lines = notifyLines(fresh.map(r => ({
    query: r.query, source: r.source, score: r.score, growth: r.growth, impressions: r.impressions,
  })));
  if (!lines.length) return;

  const settings = await getAlertSettings(userId);
  const L = NOTIFY_L[normalizeLang(settings.lang)];
  const label = siteLabel(site.url);
  const title = L.trendsTitle(label);
  const message = L.trendsMsg(label, lines.join("\n"));

  // Unique dedupeKey — a second run the same day is a silent no-op (alert-cron pattern).
  const dedupeKey = `trends:${site.id}:${isoDay(new Date())}`;
  try {
    await prisma.alertEvent.create({
      data: { userId, type: "trend", siteId: site.id, title, message, dedupeKey },
    });
  } catch {
    return; // duplicate — already notified today
  }
  const ok = await notifyUser(userId, `${title}\n\n${message}`, { event: "trend", title });
  if (ok) await prisma.alertEvent.updateMany({ where: { userId, dedupeKey }, data: { sent: true } });
}
