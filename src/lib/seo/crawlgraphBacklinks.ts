// Crawlgraph backlinks — the server-side orchestration the extras route and the profile pull
// share (issue #40). Everything that spends goes through the same three steps as every other
// metrics screen: price → check the user's own monthly cap → reserve, then reconcile to the
// calls actually made. The meter is calls (`UNIT_PRICE_USD.crawlgraph` ≈ $0.019 each).
//
// What lives here:
//   • credentials from the owner's mirrored settings (background work has no browser);
//   • the summary extras (release label, truncation, the target's own authority) kept beside
//     the profile — the quarterly freshness the UI must show;
//   • the changes panel (one call: added/removed/authority movement between two quarterly
//     snapshots, with the API's own "absence ≠ removed" caveat carried through verbatim);
//   • the gap-job lifecycle (one paid submission, free polling; a failed job is not refunded,
//     so nothing here ever resubmits on its own).
//
// Deliberately absent, unlike the DataForSEO module: a per-link export (the API is
// domain-level — no anchors, no source pages, no dofollow) and an auto-refresh scheduler
// (quarterly data gains nothing from a weekly tick).

import { rawQuery } from "@/lib/db/raw";
import {
  CRAWLGRAPH_CHANGES_UNITS, CRAWLGRAPH_GAP_UNITS, crawlgraphChanges, crawlgraphGapPoll,
  crawlgraphGapSubmit, type MetricsCreds,
} from "@/lib/seo/metrics";
import type { CgChanges, CgGapJob, CgSummary } from "@/lib/seo/crawlgraphParse";
import { readDomainCache, recordUsage, releaseUnusedUnits, withinCap, writeDomainCache, type CachedDomain } from "@/lib/seo/metricsStore";
import { normDomain } from "@/lib/seo/backlinkStore";

/** Settings the background paths need, read from the owner's `seoSettings` mirror. */
export async function crawlgraphSettings(userId: string): Promise<{ creds: MetricsCreds | null; cap: number }> {
  try {
    const rows = await rawQuery<Array<{ seoSettings?: string | null }>>(`SELECT seoSettings FROM "User" WHERE id = ?`, userId);
    const s = JSON.parse(rows?.[0]?.seoSettings ?? "{}") as Record<string, unknown>;
    const key = String(s.seoKey_crawlgraph ?? "").trim();
    return {
      creds: key ? { provider: "crawlgraph", apiKey: key } : null,
      cap: Number(s.seoMetricsCap_crawlgraph ?? 0) || 0,
    };
  } catch {
    return { creds: null, cap: 0 };
  }
}

/** Body credential first (the browser's localStorage), else the owner's mirror. */
export async function resolveCrawlgraphCreds(userId: string, body: { apiKey?: unknown }): Promise<MetricsCreds | null> {
  const apiKey = String(body?.apiKey ?? "").trim();
  if (apiKey) return { provider: "crawlgraph", apiKey };
  return (await crawlgraphSettings(userId)).creds;
}

// ─── Summary extras, stored beside the profile ─────────────────────────────────

/** Cache rows: the summary under `crawlgraph`, the changes panel and the gap job under own keys
 *  (the DomainMetricCache provider column doubles as a cache key — the dataforseo_newlost move). */
const CHANGES_KEY = "crawlgraph_changes";
const GAP_KEY = "crawlgraph_gap";

export interface CgExtras {
  releaseId: string | null;
  releaseLabel: string | null;
  totalLinkingDomains: number | null;
  returned: number | null;
  truncated: boolean;
  authority: number | null;
  checkedAt: string | null;
  changes: (Pick<CgChanges, "comparisonAvailable" | "fromRelease" | "toRelease" | "counts" | "added" | "removed" | "authorityMoved" | "truncated" | "message" | "snapshotCaveat"> & { checkedAt: string }) | null;
  gap: { jobId: string; status: string; competitors: string[]; checkedAt: string; job?: CgGapJob } | null;
}

/** The summary half of a stats `raw` (a JsonRecord at the call sites) — see crawlgraphBacklinkStats. */
interface CgStatsEnvelope extends Partial<CgSummary> {
  source?: unknown;
  units?: unknown;
}

export async function writeCgSummary(target: string, raw: Record<string, unknown>): Promise<void> {
  const e = raw as CgStatsEnvelope;
  if (!raw || e.source !== "crawlgraph") return;
  await writeDomainCache([{
    domain: normDomain(target),
    dr: e.authority ?? null,
    refDomains: e.totalLinkingDomains ?? null,
    backlinks: null,
    payload: {
      source: "crawlgraph", authorityScale: "percentile", authority: e.authority ?? null, rank: e.rank ?? null,
      releaseId: e.releaseId ?? "", releaseLabel: e.releaseLabel ?? "",
      totalLinkingDomains: e.totalLinkingDomains ?? null, returned: e.returned ?? null,
      truncated: e.truncated === true,
    },
  }], "crawlgraph", "api");
}

const parsePayload = (p: unknown) => {
  if (!p) return null;
  try { return typeof p === "string" ? JSON.parse(p) : p; } catch { return null; }
};

type CachedDomainRow = CachedDomain & { payload?: unknown };

export async function readCgExtras(target: string): Promise<CgExtras> {
  const t = normDomain(target);
  const [summary, changes, gap] = await Promise.all([
    readDomainCache([t], "crawlgraph"),
    readDomainCache([t], CHANGES_KEY),
    readDomainCache([t], GAP_KEY),
  ]);
  const s = summary[t] as CachedDomainRow | undefined;
  const sp = parsePayload(s?.payload);
  const cp = parsePayload((changes[t] as CachedDomainRow | undefined)?.payload);
  const gp = parsePayload((gap[t] as CachedDomainRow | undefined)?.payload);
  const gc = changes[t] as CachedDomainRow | undefined;
  const gg = gap[t] as CachedDomainRow | undefined;
  return {
    releaseId: sp?.releaseId ?? null,
    releaseLabel: sp?.releaseLabel ?? null,
    totalLinkingDomains: sp?.totalLinkingDomains ?? null,
    returned: sp?.returned ?? null,
    truncated: sp?.truncated === true,
    authority: sp?.authority ?? s?.dr ?? null,
    checkedAt: s?.checkedAt ?? null,
    changes: cp?.changes ? { ...cp.changes, checkedAt: String(gc?.checkedAt ?? "") } : null,
    gap: gp?.jobId ? { ...gp, checkedAt: String(gg?.checkedAt ?? "") } : null,
  };
}

type Spend<T> = { ok: true; data: T; spentUnits: number } | { ok: false; error: string; spentUnits: number; wouldSpend?: number };

/** Reserve → call → reconcile, for the one-call extras (changes, gap submit). */
async function spendOnce<T>(
  userId: string, cap: number, reserve: number,
  fn: () => Promise<{ units: number; error?: string; data: T }>,
): Promise<Spend<T>> {
  if (!(await withinCap(userId, "crawlgraph", reserve, cap))) {
    return { ok: false, error: "cap_exceeded", spentUnits: 0, wouldSpend: reserve };
  }
  await recordUsage(userId, "crawlgraph", reserve);
  const r = await fn();
  if (r.units > reserve) await recordUsage(userId, "crawlgraph", r.units - reserve);
  else await releaseUnusedUnits(userId, "crawlgraph", reserve, r.units);
  if (r.error) return { ok: false, error: r.error, spentUnits: r.units };
  return { ok: true, data: r.data, spentUnits: r.units };
}

/**
 * The changes panel: one call comparing the newest queryable pair of quarterly snapshots (or an
 * explicit from/to). The answer is cached whole so reopening the tab is free — including the
 * `comparison_available: false` variant, which the API bills all the same.
 */
export async function loadCrawlgraphChanges(
  userId: string, target: string, creds: MetricsCreds, cap: number, q: { from?: string; to?: string } = {},
): Promise<Spend<CgChanges>> {
  return spendOnce(userId, cap, CRAWLGRAPH_CHANGES_UNITS, async () => {
    const r = await crawlgraphChanges(creds, target, q);
    if (!r.ok) return { units: r.units, error: r.error, data: null as unknown as CgChanges };
    await writeDomainCache([{ domain: normDomain(target), payload: { changes: r.changes } }], CHANGES_KEY, "api");
    return { units: r.units, data: r.changes };
  });
}

/**
 * Submit one gap job (one paid call) and remember it for the free polls. The cached row is the
 * poll handle: the UI polls with the job id, and a "failed" job stays failed — the vendor does
 * not refund failed submissions, so this module never resubmits without a fresh button press.
 */
export async function submitCrawlgraphGap(
  userId: string, target: string, creds: MetricsCreds, cap: number, competitors: string[],
): Promise<Spend<{ jobId: string }>> {
  return spendOnce(userId, cap, CRAWLGRAPH_GAP_UNITS, async () => {
    const r = await crawlgraphGapSubmit(creds, target, competitors);
    if (!r.ok) return { units: r.units, error: r.error, data: { jobId: "" } };
    await writeDomainCache([{
      domain: normDomain(target),
      payload: { jobId: r.submit.jobId, status: r.submit.status, competitors },
    }], GAP_KEY, "api");
    return { units: r.units, data: { jobId: r.submit.jobId } };
  });
}

/**
 * Poll the remembered job — free, so the UI can loop on it. Every poll overwrites the cached
 * row, so a completed (or failed) answer survives the tab being closed. Unknown/finished job →
 * `no_job` and the cache keeps whatever it last saw.
 */
export async function pollCrawlgraphGap(
  target: string, creds: MetricsCreds,
): Promise<{ ok: true; job: CgGapJob } | { ok: false; error: string }> {
  const t = normDomain(target);
  const cached = await readDomainCache([t], GAP_KEY);
  const gp = parsePayload((cached[t] as CachedDomainRow | undefined)?.payload);
  const jobId = String(gp?.jobId ?? "");
  if (!jobId) return { ok: false, error: "no_job" };
  const r = await crawlgraphGapPoll(creds, jobId);
  if (!r.ok) return r;
  await writeDomainCache([{
    domain: t,
    payload: { jobId, status: r.job.status, competitors: Array.isArray(gp?.competitors) ? gp.competitors : [], job: r.job },
  }], GAP_KEY, "api");
  return r;
}
