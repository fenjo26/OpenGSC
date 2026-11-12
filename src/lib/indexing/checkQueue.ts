// Index-check queue — durable run + items, one in-process slot per run.
//
// Same architecture as the generation batch queue (lib/seo/genQueue/queue.ts, which itself
// copies the audit queue): the state lives in the database (a SerpCheckItem with status
// "queued" IS the order, so a restart loses at most the one call in flight), this module only
// claims items, runs them against the provider (checkProvider.ts), trips the circuit breaker
// and exposes pause/resume/cancel.
//
// Deliberately simpler than genQueue: no priorities, no phases, no retries — every attempt
// costs money, so a failed call is recorded as an `error` verdict and the operator decides
// whether to run again. One active run per user keeps the paid stream single and predictable.
//
// Ledger discipline: units are recorded per item BEFORE the provider call (the provider may
// bill even a captcha), derived from the run's estimate. No reserve/refund — on a
// thousand-item run the per-item truth is simpler and can never strand a reservation.

import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { withinCap, recordUsage } from "@/lib/seo/metricsStore";
import { usdToUnits } from "@/lib/plagiarism/price";
import { normalizeUrlForCompare, persistSerpIndexResults, type SerpIndexOutcome } from "@/lib/indexing/serpIndex";
import {
  XMLRIVER, checkUrlSerp, checkUrlXmlRiver, estimateIndexCheck, getIndexCheckCreds,
  XR_PAUSE_MS, SERP_PAUSE_MS,
} from "@/lib/indexing/checkProvider";

/** Sanity ceiling for one run, aligned with the indexer queue's sitemap guard. */
export const MAX_RUN_ITEMS = 20_000;

export type RunSource =
  | { kind: "sites"; siteIds: string[]; filter: "all" | "pending" | "google_not_indexed" }
  | { kind: "urls"; urls: string[] }
  | { kind: "donors" };

export interface CreateRunResult {
  ok: boolean;
  error?: string;
  /** Set when error = provider creds missing ("no_serp_key" | "no_xr_key"). */
  detail?: string;
  runId?: string;
  collected?: number;
  estimate?: { provider: string; queries: number; costUsd: number | null; free: boolean; unknownPrice: boolean };
}

// runId -> itemId currently holding the run's single slot in this process.
const inFlightByRun = new Map<string, string>();
let pumping = false;
let pumpTimer: NodeJS.Timeout | null = null;

// Test isolation (checkQueue.test.ts): a unit test's createRun must not fire a real paid
// provider call 250 ms after the assertion. The queue's drain path is exercised end-to-end on
// a dev server (aparser = free) instead — same division as genQueue, which has no DB tests
// for the same reason.
const queueDisabled = () => process.env.OPENGSC_CHECK_QUEUE_OFF === "1";

export function kickCheckQueue(delayMs = 250): void {
  if (pumpTimer || queueDisabled()) return;
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    pumpCheckQueue().catch(err => console.error("[check-queue] pump failed:", err));
  }, delayMs);
}

// ── URL collection ────────────────────────────────────────────────────────────

function hostOf(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Collect the run's URL list from the chosen source. Deduped by comparison form (the caller's
 * first spelling wins), each URL stamped with the owning site when it belongs to one — foreign
 * URLs (donors, drops, pasted lists) carry null and are never persisted to the sitemap
 * inventory.
 */
async function collectUrls(userId: string, source: RunSource): Promise<{ url: string; siteId: string | null }[]> {
  const sites = await prisma.site.findMany({ where: { userId }, select: { id: true, url: true } });
  const siteByHost = new Map<string, string>();
  for (const s of sites) {
    const h = hostOf(String(s.url));
    if (h) siteByHost.set(h, s.id);
  }
  const siteIdFor = (url: string): string | null => {
    const h = hostOf(url);
    if (!h) return null;
    if (siteByHost.has(h)) return siteByHost.get(h)!;
    for (const [host, id] of siteByHost) if (h.endsWith("." + host)) return id; // subdomain of an owned site
    return null;
  };

  let raw: string[] = [];
  let forceForeign = false;

  if (source.kind === "urls") {
    raw = source.urls.map(u => String(u ?? "").trim()).filter(Boolean);
  } else if (source.kind === "donors") {
    // Purchased donor pages across the workspace — foreign URLs by definition, whatever site
    // row they hang off. Their index verdict lives in the run + SiteBacklink stays untouched.
    forceForeign = true;
    const donors = await prisma.siteBacklink.findMany({
      where: { purchaseProvider: { not: "" }, site: { userId } },
      select: { urlFrom: true },
      orderBy: { addedAt: "asc" },
      take: MAX_RUN_ITEMS,
    }).catch(() => []);
    raw = donors.map(d => d.urlFrom).filter(Boolean);
  } else {
    // Own sites: verify ownership, then pull the sitemap inventory under the chosen filter.
    const owned = new Set(sites.map(s => s.id));
    const ids = source.siteIds.filter(id => owned.has(id));
    if (!ids.length) return [];
    const where: Prisma.SitemapUrlWhereInput = {
      siteId: { in: ids },
      inventoryStatus: "active",
    };
    if (source.filter === "pending") {
      // Never checked by anyone — the honest unknown set.
      where.googleChecked = null;
      where.serpIndexStatus = null;
    } else if (source.filter === "google_not_indexed") {
      // Google looked and the verdict does not say indexed ("Crawled - currently not
      // indexed", "Soft 404", …) — the double-check-me set. Same convention as the
      // sitemap/urls status filter.
      where.googleChecked = { not: null };
      where.NOT = { googleStatus: { contains: "indexed" } };
    }
    const rows = await prisma.sitemapUrl.findMany({
      where,
      select: { url: true, siteId: true },
      orderBy: { firstSeenAt: "asc" },
      take: MAX_RUN_ITEMS,
    }).catch(() => []);
    const seen = new Set<string>();
    const out: { url: string; siteId: string | null }[] = [];
    for (const r of rows) {
      const norm = normalizeUrlForCompare(r.url);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push({ url: r.url, siteId: r.siteId });
    }
    return out;
  }

  const seen = new Set<string>();
  const out: { url: string; siteId: string | null }[] = [];
  for (const u of raw) {
    const norm = normalizeUrlForCompare(u);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ url: u.trim(), siteId: forceForeign ? null : siteIdFor(u) });
  }
  return out.slice(0, MAX_RUN_ITEMS);
}

// ── create ────────────────────────────────────────────────────────────────────

/**
 * Estimate branch: collect the URL list and price it — and NOT ONE provider call. `confirm`
 * false is the route's first click; the caller shows the count and the budget before spending.
 */
export async function estimateRun(userId: string, providerWanted: string, source: RunSource): Promise<CreateRunResult> {
  const urls = await collectUrls(userId, source);
  if (!urls.length) return { ok: false, error: "no_urls" };
  const est = await estimateIndexCheck(userId, providerWanted, urls.length);
  if (est.error) return { ok: false, error: est.error };
  return {
    ok: true,
    collected: urls.length,
    estimate: { provider: est.provider, queries: est.queries, costUsd: est.costUsd, free: est.free, unknownPrice: est.unknownPrice },
  };
}

/** One active run per user: a paid stream must be single. A zombie "active" run with no live
 *  items is closed here rather than blocking new runs forever. */
async function closeZombieRuns(userId: string): Promise<void> {
  const actives = await prisma.serpCheckRun.findMany({
    where: { userId, status: "active" },
    select: { id: true },
  }).catch(() => []);
  for (const run of actives) {
    const live = await prisma.serpCheckItem.count({
      where: { runId: run.id, status: { in: ["queued", "running"] } },
    }).catch(() => 0);
    if (live === 0) {
      await prisma.serpCheckRun.updateMany({
        where: { id: run.id, status: "active" },
        data: { status: "done", finishedAt: new Date() },
      }).catch(() => {});
    }
  }
}

/**
 * Create the run: collect, price, check the cap, persist run + items, kick the pump. The
 * estimate rides along on the result so the UI shows the same numbers it confirmed.
 */
export async function createRun(
  userId: string,
  providerWanted: string,
  source: RunSource,
  opts: { name?: string; cap?: unknown; pauseAfterErrors?: number } = {},
): Promise<CreateRunResult> {
  await closeZombieRuns(userId);
  const liveActive = await prisma.serpCheckRun.findFirst({
    where: { userId, status: "active" },
    select: { id: true },
  }).catch(() => null);
  if (liveActive) return { ok: false, error: "run_active", runId: liveActive.id };

  const urls = await collectUrls(userId, source);
  if (!urls.length) return { ok: false, error: "no_urls" };

  const est = await estimateIndexCheck(userId, providerWanted, urls.length);
  if (est.error) return { ok: false, error: est.error };

  // Cap check (monthly, same as the sync panel) — only meaningful when the price is known.
  const totalUnits = est.costUsd != null ? usdToUnits(est.costUsd) : 0;
  const cap = Number(opts.cap ?? 0) || 0;
  if (totalUnits > 0 && !(await withinCap(userId, est.provider, totalUnits, cap))) {
    return { ok: false, error: "cap_exceeded", detail: `would spend ~$${est.costUsd}` };
  }

  const run = await prisma.serpCheckRun.create({
    data: {
      userId,
      name: String(opts.name ?? "").slice(0, 120),
      provider: est.provider,
      source: source.kind,
      status: "active",
      estCostUsd: est.costUsd,
      pauseAfterErrors: Math.max(0, Math.min(100, Number(opts.pauseAfterErrors ?? 10) || 0)),
    },
  });

  // createMany in chunks (genQueue's create does 500). No skipDuplicates: this Prisma
  // version types it unsupported for SQLite — the comparison-form dedupe above already
  // guarantees uniqueness against the (runId, url) key.
  for (let i = 0; i < urls.length; i += 500) {
    const chunk = urls.slice(i, i + 500).map(u => ({ runId: run.id, url: u.url, siteId: u.siteId }));
    await prisma.serpCheckItem.createMany({ data: chunk }).catch(() => {});
  }

  kickCheckQueue();
  return {
    ok: true,
    runId: run.id,
    collected: urls.length,
    estimate: { provider: est.provider, queries: est.queries, costUsd: est.costUsd, free: est.free, unknownPrice: est.unknownPrice },
  };
}

// ── queue mechanics ───────────────────────────────────────────────────────────

async function pumpCheckQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const candidates = await prisma.serpCheckItem.findMany({
      where: { status: "queued", run: { status: "active" } },
      orderBy: { createdAt: "asc" },
      take: 50,
      select: { id: true, runId: true },
    }).catch(() => []);
    if (!candidates.length) return;

    for (const row of candidates) {
      if (inFlightByRun.has(row.runId)) continue; // one slot per run — sequential paid calls

      // Atomic claim: only one pump moves the row out of "queued".
      const claimed = await prisma.serpCheckItem.updateMany({
        where: { id: row.id, status: "queued" },
        data: { status: "running", checkedAt: null, updatedAt: new Date() },
      }).catch(() => ({ count: 0 }));
      if (!claimed.count) continue;

      inFlightByRun.set(row.runId, row.id);
      runCheckItem(row.id).catch(err => console.error("[check-queue] run failed:", err));
    }
  } finally {
    pumping = false;
  }
}

/**
 * Claim → one provider call → settle. The provider engine comes from the run row, resolved
 * fresh per item (keys are one small query; a key deleted mid-run must stop the run, not
 * corrupt it). The politeness gap sits AFTER the call: the next claim happens in settle's
 * kick, so the paid calls of a run are always at least PAUSE_MS apart.
 */
async function runCheckItem(itemId: string): Promise<void> {
  let heartbeat: NodeJS.Timeout | null = null;
  try {
    const item = await prisma.serpCheckItem.findUnique({
      where: { id: itemId },
      include: { run: { include: { _count: { select: { items: true } } } } },
    }).catch(() => null);
    if (!item || item.status !== "running") return;
    const run = item.run;

    // XR calls can hang to their 10s timeout; a beat every 30s keeps orphan recovery honest
    // about what is actually in flight versus abandoned.
    heartbeat = setInterval(() => {
      prisma.serpCheckItem.update({ where: { id: itemId }, data: { updatedAt: new Date() } }).catch(() => {});
    }, 30_000);
    heartbeat.unref?.();

    const creds = await getIndexCheckCreds(run.userId, run.provider);
    if (!creds) {
      await settleItem(itemId, { status: "error", matchedUrl: null, detail: "creds_lost (provider key removed mid-run?)" }, run);
      return;
    }

    // Record before the call — the provider may bill even a failed request (same discipline
    // as the sync panel's reserve-ahead, scaled per item).
    const provider = creds.engine === "xmlriver" ? XMLRIVER : creds.serp.provider;
    const units = perCheckUnitsFor(run);
    if (units > 0) await recordUsage(run.userId, provider, units).catch(() => {});

    const outcome = creds.engine === "xmlriver"
      ? await checkUrlXmlRiver(creds.xr, item.url)
      : await checkUrlSerp(creds.serp, item.url);

    await new Promise(r => setTimeout(r, creds.engine === "xmlriver" ? XR_PAUSE_MS : SERP_PAUSE_MS));
    await settleItem(itemId, outcome, run);
  } catch (e) {
    console.error("[check-queue] item failed:", e);
    const item = await prisma.serpCheckItem.findUnique({ where: { id: itemId }, include: { run: true } }).catch(() => null);
    if (item?.run) {
      await settleItem(itemId, { status: "error", matchedUrl: null, detail: String((e as Error)?.message ?? e).slice(0, 200) }, item.run).catch(() => {});
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

/** Units per check derived from the run's estimate (est = total × per-check). */
function perCheckUnitsFor(run: { estCostUsd: number | null; _count?: { items: number } }): number {
  if (run.estCostUsd == null || run.estCostUsd <= 0) return 0;
  const total = run._count?.items ?? 0;
  if (total <= 0) return 0;
  return usdToUnits(run.estCostUsd / total);
}

/** Verdict → item row, → sitemap inventory when the URL belongs to a site, breaker, close, kick. */
async function settleItem(
  itemId: string,
  outcome: { status: "indexed" | "not_indexed" | "error"; matchedUrl: string | null; detail: string | null },
  run: { id: string; userId: string; provider: string },
): Promise<void> {
  // Release the slot first: whatever the DB says, this process is done with the item.
  if (inFlightByRun.get(run.id) === itemId) inFlightByRun.delete(run.id);

  await prisma.serpCheckItem.update({
    where: { id: itemId },
    data: {
      status: outcome.status === "error" ? "error" : "completed",
      verdict: outcome.status,
      matchedUrl: outcome.matchedUrl,
      detail: outcome.detail,
      checkedAt: new Date(),
      updatedAt: new Date(),
    },
  }).catch(() => {});

  // Own-site URLs persist into the same columns the sync panel reads — one table, one truth,
  // provider stamped. Foreign URLs return persisted=false and that is fine.
  try {
    const item = await prisma.serpCheckItem.findUnique({ where: { id: itemId }, select: { url: true, siteId: true } });
    if (item?.siteId) {
      const asOutcome: SerpIndexOutcome = {
        url: item.url, status: outcome.status, matchedUrl: outcome.matchedUrl,
        detail: outcome.detail, provider: run.provider, persisted: false,
      };
      await persistSerpIndexResults(run.userId, [asOutcome], run.provider);
    }
  } catch { /* pre-migration or foreign URL — the verdict stays on the item */ }

  const tripped = await bumpCircuitBreaker(run.id, outcome.status === "error").catch(() => false);
  if (tripped) await notifyRunAutoPaused(run.id, outcome.detail ?? "").catch(() => {});

  await closeRunIfDone(run.id).catch(() => {});
  kickCheckQueue();
}

// consecutiveErrors: reset on any answered item, bumped on each error. At pauseAfterErrors the
// run pauses itself — a captcha storm must not quietly burn the whole budget. Returns true
// when the breaker tripped JUST NOW (the caller fires one alert).
async function bumpCircuitBreaker(runId: string, failed: boolean): Promise<boolean> {
  const run = await prisma.serpCheckRun.findUnique({
    where: { id: runId }, select: { consecutiveErrors: true, pauseAfterErrors: true, status: true },
  }).catch(() => null);
  if (!run) return false;
  if (failed) {
    const next = (run.consecutiveErrors ?? 0) + 1;
    if (run.pauseAfterErrors > 0 && next >= run.pauseAfterErrors && run.status === "active") {
      await prisma.serpCheckRun.update({
        where: { id: runId },
        data: { consecutiveErrors: next, status: "paused", statusReason: "auto_paused_errors" },
      });
      return true;
    }
    await prisma.serpCheckRun.update({ where: { id: runId }, data: { consecutiveErrors: next } });
    return false;
  }
  if (run.consecutiveErrors !== 0) {
    await prisma.serpCheckRun.update({ where: { id: runId }, data: { consecutiveErrors: 0 } });
  }
  return false;
}

// The stop-crank alert — same shape as genQueue's notifyBatchAutoPaused. Never throws: a dead
// channel must not fail the settle path that called it.
async function notifyRunAutoPaused(runId: string, lastError: string): Promise<void> {
  const run = await prisma.serpCheckRun.findUnique({
    where: { id: runId }, select: { userId: true, name: true, pauseAfterErrors: true },
  }).catch(() => null);
  if (!run) return;
  const { notifyUser } = await import("@/lib/notify");
  const text = `⚠️ Index-check run paused\n\n"${run.name || runId}" hit ${run.pauseAfterErrors} consecutive provider errors and paused itself.\nLast error: ${String(lastError).slice(0, 300)}\n\nCheck Index Check (provider down? key exhausted?) and resume when fixed.`;
  try {
    await prisma.alertEvent.create({
      data: {
        userId: run.userId, type: "check_run_paused",
        title: "⚠️ Index-check run paused",
        message: text, dedupeKey: `check_run_paused:${runId}:${new Date().toISOString().slice(0, 10)}`,
      },
    });
  } catch { /* duplicate or table missing — delivery below still runs */ }
  await notifyUser(run.userId, text);
}

// All items terminal → the run is done. Paused runs whose tail drained close the same way;
// cancelled runs only get their finishedAt stamped (their status stays the operator's choice).
async function closeRunIfDone(runId: string): Promise<void> {
  const remaining = await prisma.serpCheckItem.count({
    where: { runId, status: { in: ["queued", "running"] } },
  }).catch(() => 1);
  if (remaining > 0) return;
  await prisma.serpCheckRun.updateMany({
    where: { id: runId, status: { in: ["active", "paused"] } },
    data: { status: "done", finishedAt: new Date() },
  }).catch(() => {});
  await prisma.serpCheckRun.updateMany({
    where: { id: runId, status: "cancelled", finishedAt: null },
    data: { finishedAt: new Date() },
  }).catch(() => {});
}

// ── actions ───────────────────────────────────────────────────────────────────

export async function pauseRun(userId: string, runId: string): Promise<boolean> {
  const res = await prisma.serpCheckRun.updateMany({
    where: { id: runId, userId, status: "active" },
    data: { status: "paused", statusReason: "paused_by_user" },
  }).catch(() => ({ count: 0 }));
  return res.count > 0;
}

/** Refused while another run of the same user is active — one paid stream at a time. */
export async function resumeRun(userId: string, runId: string): Promise<{ ok: boolean; error?: string }> {
  const other = await prisma.serpCheckRun.findFirst({
    where: { userId, status: "active", id: { not: runId } },
    select: { id: true },
  }).catch(() => null);
  if (other) return { ok: false, error: "run_active" };
  const res = await prisma.serpCheckRun.updateMany({
    where: { id: runId, userId, status: "paused" },
    data: { status: "active", statusReason: "", consecutiveErrors: 0 },
  }).catch(() => ({ count: 0 }));
  if (res.count > 0) kickCheckQueue();
  return { ok: res.count > 0 ? true : false, error: res.count > 0 ? undefined : "not_paused" };
}

/** Queued items are skipped instantly; the one call in flight finishes — killing it wastes
 *  money already committed to the provider. */
export async function cancelRun(userId: string, runId: string): Promise<boolean> {
  const res = await prisma.serpCheckRun.updateMany({
    where: { id: runId, userId, status: { in: ["active", "paused"] } },
    data: { status: "cancelled", statusReason: "cancelled_by_user" },
  }).catch(() => ({ count: 0 }));
  if (!res.count) return false;
  await prisma.serpCheckItem.updateMany({
    where: { runId, status: "queued" },
    data: { status: "skipped", detail: "cancelled", updatedAt: new Date() },
  }).catch(() => {});
  await closeRunIfDone(runId).catch(() => {});
  return true;
}

// ── progress & history ────────────────────────────────────────────────────────

export interface RunStatus {
  run: {
    id: string; name: string; provider: string; source: string; status: string; statusReason: string;
    consecutiveErrors: number; pauseAfterErrors: number; estCostUsd: number | null;
    createdAt: string; finishedAt: string | null;
  };
  counts: Record<string, number>;      // item status → count
  verdicts: Record<string, number>;    // verdict → count (indexed/not_indexed/error)
  bySite: { siteId: string | null; siteDomain: string; total: number; notIndexed: number }[];
  active: boolean;
}

export async function getRunStatus(userId: string, runId: string): Promise<RunStatus | null> {
  const run = await prisma.serpCheckRun.findFirst({
    where: { id: runId, userId },
  }).catch(() => null);
  if (!run) return null;

  const [byStatus, byVerdict, bySiteRaw, sites] = await Promise.all([
    prisma.serpCheckItem.groupBy({ by: ["status"], where: { runId }, _count: { _all: true } }).catch(() => []),
    prisma.serpCheckItem.groupBy({ by: ["verdict"], where: { runId }, _count: { _all: true } }).catch(() => []),
    prisma.serpCheckItem.groupBy({ by: ["siteId", "verdict"], where: { runId }, _count: { _all: true } }).catch(() => []),
    prisma.site.findMany({ where: { userId }, select: { id: true, url: true } }).catch(() => [] as { id: string; url: string }[]),
  ]);

  const counts: Record<string, number> = {};
  for (const r of byStatus as { status: string; _count: { _all: number } }[]) counts[r.status] = r._count._all;
  const verdicts: Record<string, number> = {};
  for (const r of byVerdict as { verdict: string | null; _count: { _all: number } }[]) if (r.verdict) verdicts[r.verdict] = r._count._all;

  const siteDomain = new Map(sites.map(s => [s.id, hostOf(String(s.url)) || String(s.url)]));
  const siteAgg = new Map<string, { siteId: string | null; siteDomain: string; total: number; notIndexed: number }>();
  for (const r of bySiteRaw as { siteId: string | null; verdict: string | null; _count: { _all: number } }[]) {
    const key = r.siteId ?? "";
    const agg = siteAgg.get(key) ?? {
      siteId: r.siteId,
      siteDomain: r.siteId ? (siteDomain.get(r.siteId) ?? r.siteId) : "—",
      total: 0,
      notIndexed: 0,
    };
    agg.total += r._count._all;
    if (r.verdict === "not_indexed") agg.notIndexed += r._count._all;
    siteAgg.set(key, agg);
  }

  return {
    run: {
      id: run.id, name: run.name, provider: run.provider, source: run.source,
      status: run.status, statusReason: run.statusReason,
      consecutiveErrors: run.consecutiveErrors, pauseAfterErrors: run.pauseAfterErrors,
      estCostUsd: run.estCostUsd,
      createdAt: run.createdAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null,
    },
    counts,
    verdicts,
    bySite: [...siteAgg.values()].sort((a, b) => b.total - a.total),
    active: run.status === "active",
  };
}

export interface RunItemRow {
  url: string;
  status: string;
  verdict: string | null;
  matchedUrl: string | null;
  detail: string | null;
  checkedAt: string | null;
}

/** Paged item list for the run detail — verdict filter optional, insertion order kept. */
export async function getRunItems(
  userId: string,
  runId: string,
  opts: { verdict?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: RunItemRow[]; total: number; nextOffset: number | null } | null> {
  const run = await prisma.serpCheckRun.findFirst({ where: { id: runId, userId }, select: { id: true } }).catch(() => null);
  if (!run) return null;
  const limit = Math.max(10, Math.min(500, Number(opts.limit ?? 100) || 100));
  const offset = Math.max(0, Number(opts.offset ?? 0) || 0);
  const where = { runId, ...(opts.verdict && opts.verdict !== "all" ? { verdict: opts.verdict } : {}) };
  const [total, rows] = await Promise.all([
    prisma.serpCheckItem.count({ where }).catch(() => 0),
    prisma.serpCheckItem.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: limit + 1,
      skip: offset,
      select: { url: true, status: true, verdict: true, matchedUrl: true, detail: true, checkedAt: true },
    }).catch(() => []),
  ]);
  return {
    rows: rows.map(r => ({
      url: r.url, status: r.status, verdict: r.verdict,
      matchedUrl: r.matchedUrl, detail: r.detail,
      checkedAt: r.checkedAt?.toISOString() ?? null,
    })),
    total,
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}

/** The copy/export list: every not_indexed verdict of the run, deduped, no errors, no unchecked
 *  (the label promises exactly this — ui-labels-must-match-action-scope). Optional siteId cut. */
export async function getNotFoundUrls(userId: string, runId: string, siteId?: string): Promise<string[] | null> {
  const run = await prisma.serpCheckRun.findFirst({ where: { id: runId, userId }, select: { id: true } }).catch(() => null);
  if (!run) return null;
  const rows = await prisma.serpCheckItem.findMany({
    where: { runId, verdict: "not_indexed", ...(siteId ? { siteId } : {}) },
    select: { url: true },
    orderBy: { createdAt: "asc" },
  }).catch(() => []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r.url);
  }
  return out;
}

/** Runs list for the page's history block, newest first. */
export async function listRuns(userId: string, limit = 30): Promise<RunStatus[]> {
  const runs = await prisma.serpCheckRun.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(100, limit)),
    select: { id: true },
  }).catch(() => []);
  const out: RunStatus[] = [];
  for (const r of runs) {
    const s = await getRunStatus(userId, r.id);
    if (s) out.push(s);
  }
  return out;
}

// ── orphan recovery ───────────────────────────────────────────────────────────

/**
 * Items stuck in "running" whose row went silent (the process died mid-call). A provider call
 * lives at most ~10s, so 5 minutes of silence means nobody is coming back: the item is settled
 * as an error verdict, which is also what the breaker sees — a restart loop must not turn into
 * a silent skip-fest. Called by the scheduler's tick.
 */
export async function recoverOrphanedItems(): Promise<void> {
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const orphans = await prisma.serpCheckItem.findMany({
    where: { status: "running", updatedAt: { lt: staleBefore } },
    select: { id: true, runId: true },
    take: 50,
  }).catch(() => []);
  for (const o of orphans) {
    const run = await prisma.serpCheckRun.findUnique({ where: { id: o.runId }, select: { id: true, userId: true, provider: true } }).catch(() => null);
    if (!run) continue;
    if (inFlightByRun.get(o.runId) === o.id) continue; // actually ours, just slow
    await prisma.serpCheckItem.update({
      where: { id: o.id },
      data: {
        status: "error", verdict: "error", detail: "orphaned (server restarted mid-check)",
        checkedAt: new Date(), updatedAt: new Date(),
      },
    }).catch(() => {});
    const tripped = await bumpCircuitBreaker(o.runId, true).catch(() => false);
    if (tripped) await notifyRunAutoPaused(o.runId, "orphaned (server restarted mid-check)").catch(() => {});
    await closeRunIfDone(o.runId).catch(() => {});
  }
  // Runs left active with nothing to do (crash between last settle and close) close here.
  await closeZombieRunsAll().catch(() => {});
  kickCheckQueue();
}

async function closeZombieRunsAll(): Promise<void> {
  const actives = await prisma.serpCheckRun.findMany({ where: { status: "active" }, select: { id: true } }).catch(() => []);
  for (const run of actives) await closeRunIfDone(run.id).catch(() => {});
}
