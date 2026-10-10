// DataForSEO backlinks — the server-side orchestration shared by the routes and the scheduler
// (issue #26). Everything that spends goes through the same three steps as the other metrics
// screens: price → check the user's own monthly cap → reserve, then reconcile to the `cost`
// DataForSEO itself reported. The meter is micro-dollars (`UNIT_PRICE_USD.dataforseo`).
//
// What lives here:
//   • credentials from the owner's mirrored settings (background work has no browser);
//   • the summary extras (rank, spam score, broken links) kept beside the profile;
//   • the 12-month history import and the weekly new/lost panel — one request each;
//   • the per-link export start (pricing read + confirm gate + detached runner);
//   • the profile refresh the weekly scheduler runs.

import { rawQuery } from "@/lib/db/raw";
import {
  DATAFORSEO_HISTORY_UNITS, DATAFORSEO_NEWLOST_UNITS, DATAFORSEO_PAGE_SIZE, DATAFORSEO_REQUEST_UNITS,
  DATAFORSEO_ROW_UNITS, estimateCostUsd, estimateDataforseoProfileUnits, estimateDataforseoRowsUnits,
  fetchBacklinkProfile, fetchBacklinkStats, fetchDataforseoBacklinksPage, fetchDataforseoHistory,
  fetchDataforseoNewLost, REFDOMAIN_PAGE_SIZE, type MetricsCreds,
} from "@/lib/seo/metrics";
import type { DfsNewLostPoint } from "@/lib/seo/dataforseoBacklinksParse";
import { readDomainCache, recordUsage, releaseUnusedUnits, withinCap, writeDomainCache } from "@/lib/seo/metricsStore";
import { normDomain, readSnapshots, syncRefDomains, writeSnapshot } from "@/lib/seo/backlinkStore";
import { createApiSync, runDataforseoBacklinkExport, runningApiSync } from "@/lib/seo/siteBacklinkStore";

export type DfsAutoMode = "off" | "weekly" | "weekly_links";

export function parseDfsAutoMode(v: unknown): DfsAutoMode {
  return v === "weekly" || v === "weekly_links" ? v : "off";
}

/** Settings the background paths need, read from the owner's `seoSettings` mirror. */
export async function dataforseoSettings(userId: string): Promise<{ creds: MetricsCreds | null; cap: number; auto: DfsAutoMode }> {
  try {
    const rows: any[] = await rawQuery(`SELECT seoSettings FROM "User" WHERE id = ?`, userId);
    const s = JSON.parse(rows?.[0]?.seoSettings ?? "{}") as Record<string, unknown>;
    const key = String(s.seoKey_dataforseo ?? s.dataforseoKey ?? "").trim();
    return {
      creds: key ? { provider: "dataforseo", apiKey: key } : null,
      cap: Number(s.seoMetricsCap_dataforseo ?? 0) || 0,
      auto: parseDfsAutoMode(s.seoMetricsAuto_dataforseo),
    };
  } catch {
    return { creds: null, cap: 0, auto: "off" };
  }
}

/** Body credential first (the browser's localStorage), else the owner's mirror. */
export async function resolveDataforseoCreds(userId: string, body: { apiKey?: unknown }): Promise<MetricsCreds | null> {
  const apiKey = String(body?.apiKey ?? "").trim();
  if (apiKey) return { provider: "dataforseo", apiKey };
  return (await dataforseoSettings(userId)).creds;
}

// ─── Summary extras, stored beside the profile ─────────────────────────────────

/** Cache rows: the summary under `dataforseo`, the weekly new/lost under its own key. */
const NEWLOST_KEY = "dataforseo_newlost";

export interface DfsExtras {
  rank: number | null;
  spamScore: number | null;
  brokenBacklinks: number | null;
  refMainDomains: number | null;
  checkedAt: string | null;
  newLost: { points: DfsNewLostPoint[]; checkedAt: string } | null;
  /** How many monthly history points this instance holds for the target. */
  historyPoints: number;
}

export async function writeDfsSummary(target: string, raw: any): Promise<void> {
  if (!raw || raw.source !== "dataforseo") return;
  await writeDomainCache([{
    domain: normDomain(target),
    dr: raw.rank ?? null,
    refDomains: raw.refDomains ?? null,
    backlinks: raw.backlinks ?? null,
    payload: {
      source: "dataforseo", rankScale: 100, rank: raw.rank ?? null, spamScore: raw.spamScore ?? null,
      brokenBacklinks: raw.brokenBacklinks ?? null, refMainDomains: raw.refMainDomains ?? null,
    },
  }], "dataforseo", "api");
}

const parsePayload = (p: unknown) => {
  if (!p) return null;
  try { return typeof p === "string" ? JSON.parse(p) : p; } catch { return null; }
};

export async function readDfsExtras(target: string): Promise<DfsExtras> {
  const t = normDomain(target);
  const [summary, newLost] = await Promise.all([
    readDomainCache([t], "dataforseo"),
    readDomainCache([t], NEWLOST_KEY),
  ]);
  const s = summary[t] as any;
  const sp = parsePayload(s?.payload);
  const nl = newLost[t] as any;
  const np = parsePayload(nl?.payload);
  let historyPoints = 0;
  try {
    const rows: any[] = await rawQuery(
      `SELECT COUNT(*) AS n FROM "BacklinkSnapshot" WHERE target = ? AND provider = 'dataforseo' AND source = 'history'`, t,
    );
    historyPoints = Number(rows?.[0]?.n ?? 0) || 0;
  } catch { /* table missing until db push */ }
  return {
    rank: sp?.rank ?? s?.dr ?? null,
    spamScore: sp?.spamScore ?? null,
    brokenBacklinks: sp?.brokenBacklinks ?? null,
    refMainDomains: sp?.refMainDomains ?? null,
    checkedAt: s?.checkedAt ?? null,
    newLost: Array.isArray(np?.points) ? { points: np.points, checkedAt: String(nl?.checkedAt ?? "") } : null,
    historyPoints,
  };
}

type Spend<T> = { ok: true; data: T; spentUnits: number } | { ok: false; error: string; spentUnits: number; wouldSpend?: number };

/** Reserve → call → reconcile, for the one-request extras (history, new/lost). */
async function spendOnce<T>(
  userId: string, cap: number, reserve: number,
  fn: () => Promise<{ units: number; error?: string; data: T }>,
): Promise<Spend<T>> {
  if (!(await withinCap(userId, "dataforseo", reserve, cap))) {
    return { ok: false, error: "cap_exceeded", spentUnits: 0, wouldSpend: reserve };
  }
  await recordUsage(userId, "dataforseo", reserve);
  const r = await fn();
  if (r.units > reserve) await recordUsage(userId, "dataforseo", r.units - reserve);
  else await releaseUnusedUnits(userId, "dataforseo", reserve, r.units);
  if (r.error) return { ok: false, error: r.error, spentUnits: r.units };
  return { ok: true, data: r.data, spentUnits: r.units };
}

/**
 * Twelve months of monthly totals into `BacklinkSnapshot` (provider `dataforseo`, source
 * `history`), so the trend has a past on day one instead of starting at the first pull. A day
 * this instance already measured itself is never overwritten by a backfilled figure.
 */
export async function importDataforseoHistory(
  userId: string, target: string, creds: MetricsCreds, cap: number,
): Promise<Spend<{ written: number; months: number }>> {
  return spendOnce(userId, cap, DATAFORSEO_HISTORY_UNITS, async () => {
    const r = await fetchDataforseoHistory(creds, target);
    if (r.error) return { units: r.units, error: r.error, data: { written: 0, months: 0 } };
    const have = new Set((await readSnapshots(target, 365, "dataforseo")).map(s => s.date));
    let written = 0;
    for (const p of r.points) {
      if (have.has(p.date)) continue;
      await writeSnapshot(target, { refDomains: p.refDomains, backlinks: p.backlinks, dofollowPct: null }, {
        provider: "dataforseo", source: "history", date: p.date,
      });
      written++;
    }
    return { units: r.units, data: { written, months: r.points.length } };
  });
}

/** Weekly new/lost for the last 12 weeks, cached so reopening the tab costs nothing. */
export async function loadDataforseoNewLost(
  userId: string, target: string, creds: MetricsCreds, cap: number,
): Promise<Spend<DfsNewLostPoint[]>> {
  return spendOnce(userId, cap, DATAFORSEO_NEWLOST_UNITS, async () => {
    const r = await fetchDataforseoNewLost(creds, target);
    if (r.error) return { units: r.units, error: r.error, data: [] };
    await writeDomainCache([{ domain: normDomain(target), payload: { source: "dataforseo", points: r.points } }], NEWLOST_KEY, "api");
    return { units: r.units, data: r.points };
  });
}

// ─── Profile refresh (the scheduler's half of /api/metrics/backlinks) ──────────

export async function refreshDataforseoProfile(
  userId: string, target: string, creds: MetricsCreds, cap: number,
): Promise<{ ok: boolean; error?: string; complete?: boolean; spentUnits: number }> {
  const stats = await fetchBacklinkStats(creds, target);
  if (!stats.ok) return { ok: false, error: stats.error, spentUnits: 0 };
  const units = estimateDataforseoProfileUnits(stats.totals.refDomainsTotal ?? REFDOMAIN_PAGE_SIZE);
  if (!(await withinCap(userId, "dataforseo", units, cap))) {
    // The summary was already billed; it stays on the meter even though the pull stops here.
    await recordUsage(userId, "dataforseo", Number(stats.raw?.units ?? 0));
    return { ok: false, error: "cap_exceeded", spentUnits: Number(stats.raw?.units ?? 0) };
  }
  await recordUsage(userId, "dataforseo", units);
  const res = await fetchBacklinkProfile(creds, target, { stats: stats.raw });
  const spent = res.unitsSpent ?? 0;
  if (spent > units) await recordUsage(userId, "dataforseo", spent - units);
  else await releaseUnusedUnits(userId, "dataforseo", units, spent);
  if (!res.items.length) return { ok: false, error: res.error ?? "empty", spentUnits: spent };

  const profile = res.items[0];
  const complete = res.sawEnd === true;
  await syncRefDomains(target, profile.refDomains, { provider: "dataforseo", source: "api", complete });
  await writeSnapshot(target, {
    refDomains: profile.refDomainsTotal, backlinks: profile.backlinksTotal, dofollowPct: profile.dofollowPct,
  }, { provider: "dataforseo", source: "api" });
  await writeDfsSummary(target, stats.raw);
  return { ok: true, complete, error: res.error, spentUnits: spent };
}

// ─── Per-link export start ─────────────────────────────────────────────────────

export interface DfsExportEstimate { rows: number; pages: number; units: number; usd: number; provider: "dataforseo" }

/** The pricing read: one `limit: 1` page whose `total_count` is the export's size. */
const PRICE_UNITS = DATAFORSEO_REQUEST_UNITS + DATAFORSEO_ROW_UNITS;

/**
 * Price, and with `confirm` start, the per-link export. Same contract as the Ahrefs and Keys.so
 * paths in /api/backlinks/sync: the pricing read is billed and recorded either way, nothing else
 * is spent until the caller has seen the estimate and sent it back as confirm; one run per site.
 * `run` is the detached runner's promise — the route ignores it, the scheduler awaits it.
 */
export async function startDataforseoExport(o: {
  userId: string; siteId: string; target: string; creds: MetricsCreds; cap: number; confirm: boolean;
}): Promise<{ status: number; body: Record<string, unknown>; run?: Promise<void> }> {
  if (!(await withinCap(o.userId, "dataforseo", PRICE_UNITS, o.cap))) {
    return { status: 429, body: { error: "cap_exceeded", wouldSpend: PRICE_UNITS } };
  }
  const price = await fetchDataforseoBacklinksPage(o.creds, o.target, { priceOnly: true });
  await recordUsage(o.userId, "dataforseo", price.units);
  if (price.error || price.totalCount == null) {
    return { status: 502, body: { error: price.error ?? "stats_failed" } };
  }
  const live = price.totalCount;
  const units = estimateDataforseoRowsUnits(live);
  const estimate: DfsExportEstimate = {
    rows: live,
    pages: Math.max(1, Math.ceil(live / DATAFORSEO_PAGE_SIZE)),
    units,
    usd: estimateCostUsd(units, "dataforseo"),
    provider: "dataforseo",
  };
  if (!o.confirm) return { status: 200, body: { confirmRequired: true, estimate } };

  const running = await runningApiSync(o.siteId);
  if (running) return { status: 409, body: { error: "already_running", id: running.id } };
  if (!(await withinCap(o.userId, "dataforseo", units, o.cap))) {
    return { status: 429, body: { error: "cap_exceeded", wouldSpend: units } };
  }
  await recordUsage(o.userId, "dataforseo", units);
  const sync = await createApiSync(o.siteId, "dataforseo_token");
  const run = runDataforseoBacklinkExport({
    syncId: sync.id, siteId: o.siteId, userId: o.userId, target: o.target, creds: o.creds,
    live, reservedUnits: units,
  }).catch(err => console.error(`[backlinks-sync:dataforseo] ${sync.id} failed:`, err));
  return { status: 200, body: { id: sync.id, estimate }, run };
}
