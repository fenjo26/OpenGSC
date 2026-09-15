// SERP Monitor — host enrichment: registration age (RDAP/WHOIS through the drops registry
// stack), DR (the free Ahrefs endpoint) and referring-domain counts (the paid metrics stats
// call behind the owner's SEO-metrics key). All are bounded: at most `limit` hosts per call,
// and the age phase stops at `deadline` (epoch ms) — the enrich routes run ONE step per HTTP
// request and report `remaining` so the client can loop without holding the request open.
//
// Never throws outward: every failure lands in the `errors` counter, and unchecked hosts simply
// stay pending for the next slice.

import { prisma } from "@/lib/prisma";
import { getOwnerSettings } from "@/lib/engineKeysServer";
import { checkAvailabilityBatch } from "@/lib/drops/availability";
import { profileForDomain, registryAnswerable, apexOf } from "@/lib/drops/registries";
import type { AvailabilityResult } from "@/lib/drops/types";
import { drForDomains, resolveDrKey } from "@/lib/drops/drFree";
import {
  AHREFS_UNIT_FLOOR, MAJESTIC_STATS_UNITS, SEMRUSH_BACKLINKS_OVERVIEW_UNITS,
  fetchBacklinkStats, parseMetricsProvider, type MetricsProvider,
} from "@/lib/seo/metrics";
import { recordUsage, releaseUnusedUnits, withinCap } from "@/lib/seo/metricsStore";
import { isSchemaMissing, hostMatchesEntries } from "./domains";
import { DEFAULT_PLATFORM_HOSTS } from "./types";

const DAY_MS = 86_400_000;
/** A failed age answer is retried after a week. */
const AGE_RETRY_MS = 7 * DAY_MS;
/** A DR value older than a month is refreshed. */
const DR_TTL_MS = 30 * DAY_MS;
/** A referring-domain count older than a month is refreshed — link profiles move slowly. */
export const REFDOMAINS_TTL_MS = 30 * DAY_MS;
/** Stop starting new provider calls this close to the step deadline; one call is already in flight then. */
const REFDOMAINS_CALL_MARGIN_MS = 10_000;
/** Defensive ceiling on the pending scan; a dictionary this large means something is wrong anyway. */
const PENDING_SCAN_CAP = 5000;

const ID_CHUNK = 300;
const HOST_SELECT = { id: true, host: true, registrable: true };

interface HostRow { id: number; host: string; registrable: string }
type Counters = { age: number; dr: number; errors: number };

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Hosts whose registrable has top-30 presence are enriched first — they are the ones worth reading. */
async function top30HostIds(): Promise<Set<number>> {
  const rows = await prisma.serpProjectHost.findMany({
    where: { top30: { gt: 0 } },
    select: { hostId: true },
    distinct: ["hostId"],
  });
  return new Set(rows.map(r => r.hostId));
}

// ─── Age ────────────────────────────────────────────────────────────────────────

async function writeAge(hostIds: number[], data: { registeredAt?: Date | null; ageError: string | null }): Promise<boolean> {
  try {
    for (const ids of chunks(hostIds, ID_CHUNK)) {
      await prisma.serpHost.updateMany({
        where: { id: { in: ids } },
        data: {
          ageCheckedAt: new Date(),
          ageError: data.ageError,
          ...(data.registeredAt !== undefined ? { registeredAt: data.registeredAt } : {}),
        },
      });
    }
    return true;
  } catch {
    return false;
  }
}

async function enrichAge(opts: { limit: number; deadline: number; hostIds?: number[] }, result: Counters): Promise<void> {
  const cap = Math.max(0, opts.limit);
  if (!cap) return;
  const now = new Date();
  const retryBefore = new Date(now.getTime() - AGE_RETRY_MS);
  const pending = {
    OR: [
      { ageCheckedAt: null },
      { ageError: { not: null }, ageCheckedAt: { lt: retryBefore } },
    ],
  };

  let candidates: HostRow[];
  try {
    if (opts.hostIds?.length) {
      candidates = [];
      for (const ids of chunks(opts.hostIds, ID_CHUNK)) {
        const part = await prisma.serpHost.findMany({
          where: { AND: [pending, { id: { in: ids } }] },
          select: HOST_SELECT,
        });
        candidates.push(...part);
        if (candidates.length >= cap) break;
      }
      candidates = candidates.slice(0, cap);
    } else {
      candidates = await prisma.serpHost.findMany({
        where: pending,
        select: HOST_SELECT,
        take: PENDING_SCAN_CAP,
      });
    }
  } catch (e) {
    if (!isSchemaMissing(e)) result.errors++;
    return;
  }
  if (!candidates.length) return;

  let priority = new Set<number>();
  try { priority = await top30HostIds(); } catch { /* ordering only */ }
  candidates.sort((a, b) => Number(priority.has(b.id)) - Number(priority.has(a.id)) || a.id - b.id);
  candidates = candidates.slice(0, cap);

  // One registry question per registrable name; every host behind it inherits the answer.
  // A host whose registrable is unknown or whose zone has nobody to ask gets a definitive
  // "no_registry" without touching the network.
  const noRegistry: number[] = [];
  const byRegistrable = new Map<string, number[]>();
  for (const h of candidates) {
    const reg = (h.registrable || apexOf(h.host) || "").trim().toLowerCase();
    if (!reg) { noRegistry.push(h.id); continue; }
    const profile = profileForDomain(reg);
    if (!profile || !registryAnswerable(profile)) { noRegistry.push(h.id); continue; }
    let list = byRegistrable.get(reg);
    if (!list) { list = []; byRegistrable.set(reg, list); }
    list.push(h.id);
  }
  if (noRegistry.length) {
    if (await writeAge(noRegistry, { ageError: "no_registry" })) result.age += noRegistry.length;
    else result.errors += noRegistry.length;
  }

  const budget = opts.deadline - Date.now();
  if (budget <= 0 || !byRegistrable.size) return;
  // No drops proxy pool here: that is a separate setting of that module, SERP Monitor goes direct.
  let answers: Map<string, AvailabilityResult>;
  try {
    answers = await checkAvailabilityBatch([...byRegistrable.keys()], { deadlineMs: budget });
  } catch {
    result.errors++; // the batch itself blew up: nothing written, every host stays pending
    return;
  }
  for (const [reg, hostIds] of byRegistrable) {
    const res = answers.get(reg);
    if (!res) continue; // not reached before the deadline — stays pending for the next slice
    let written: boolean;
    switch (res.status) {
      case "registered":
        if (res.createdAt) {
          written = await writeAge(hostIds, { registeredAt: res.createdAt, ageError: null });
        } else {
          written = await writeAge(hostIds, { ageError: "no_date" });
        }
        if (written) result.age += hostIds.length; else result.errors += hostIds.length;
        break;
      case "available":
        // A SERP host whose registrable reads free is junk data, but the answer is definitive.
        written = await writeAge(hostIds, { ageError: "not_registered" });
        if (written) result.age += hostIds.length; else result.errors += hostIds.length;
        break;
      default: // rate_limited | error — transient, retried after the backoff
        await writeAge(hostIds, { ageError: res.status });
        result.errors += hostIds.length;
        break;
    }
  }
}

// ─── DR ─────────────────────────────────────────────────────────────────────────

async function enrichDr(opts: { limit: number; userId: string; hostIds?: number[] }, result: Counters): Promise<void> {
  const cap = Math.max(0, opts.limit);
  if (!cap) return;
  try {
    const key = await resolveDrKey(opts.userId);
    if (!key) return; // nothing can be fetched and nothing ever will from this instance
  } catch {
    return;
  }

  const now = new Date();
  const staleBefore = new Date(now.getTime() - DR_TTL_MS);
  const pending = {
    OR: [
      { drCheckedAt: null },
      { drCheckedAt: { lt: staleBefore } },
    ],
  };

  // DR is only fetched for hosts that currently hold keywords in at least one project, and
  // never for platforms — nobody buys links on facebook.com.
  let hostIds: number[];
  try {
    if (opts.hostIds?.length) {
      hostIds = opts.hostIds;
    } else {
      const active = await prisma.serpProjectHost.findMany({
        where: { keywords: { gt: 0 } },
        select: { hostId: true },
        distinct: ["hostId"],
      });
      hostIds = active.map(r => r.hostId);
    }
  } catch (e) {
    if (!isSchemaMissing(e)) result.errors++;
    return;
  }

  const candidates: HostRow[] = [];
  try {
    for (const ids of chunks(hostIds, ID_CHUNK)) {
      const part = await prisma.serpHost.findMany({
        where: { AND: [pending, { id: { in: ids } }] },
        select: HOST_SELECT,
      });
      candidates.push(...part);
      if (candidates.length >= cap * 3) break; // headroom for the platform cut below
    }
  } catch (e) {
    if (!isSchemaMissing(e)) result.errors++;
    return;
  }

  const fresh = candidates.filter(h => !hostMatchesEntries(h.host, DEFAULT_PLATFORM_HOSTS));
  if (!fresh.length) return;
  let priority = new Set<number>();
  try { priority = await top30HostIds(); } catch { /* ordering only */ }
  fresh.sort((a, b) => Number(priority.has(b.id)) - Number(priority.has(a.id)) || a.id - b.id);

  const byRegistrable = new Map<string, number[]>();
  for (const h of fresh.slice(0, cap)) {
    const reg = (h.registrable || apexOf(h.host) || "").trim().toLowerCase();
    if (!reg) continue;
    let list = byRegistrable.get(reg);
    if (!list) { list = []; byRegistrable.set(reg, list); }
    list.push(h.id);
  }
  if (!byRegistrable.size) return;

  let ratings: Record<string, number> = {};
  try {
    const res = await drForDomains(opts.userId, [...byRegistrable.keys()]);
    if (!res.keyFound) return; // say nothing, write nothing — the route asks for the key instead
    ratings = res.ratings;
  } catch {
    result.errors++;
    return;
  }

  try {
    for (const [reg, ids] of byRegistrable) {
      const dr = ratings[reg];
      if (dr == null) continue; // beyond drForDomains' own per-call cap — stays pending
      for (const partIds of chunks(ids, ID_CHUNK)) {
        await prisma.serpHost.updateMany({
          where: { id: { in: partIds } },
          data: { dr, drCheckedAt: new Date() },
        });
      }
      result.dr += ids.length;
    }
  } catch {
    result.errors++;
  }
}

// ─── Referring domains ────────────────────────────────────────────────────────

/**
 * The price of one `fetchBacklinkStats` call, by provider — the same figures the backlinks
 * route reserves, restated here because `metricsPricing` has no stats-only estimator yet
 * (the profile estimators all fold the refdomains pages in on top of the stats call).
 * Ahrefs bills the floored 50 for the four-field stats answer, Semrush 40 flat for
 * `backlinks_overview`, Majestic one index-item unit for a batched GetIndexItemInfo of one.
 */
function refdomainStatsUnits(provider: MetricsProvider): number {
  if (provider === "majestic") return MAJESTIC_STATS_UNITS;
  if (provider === "semrush") return SEMRUSH_BACKLINKS_OVERVIEW_UNITS;
  return AHREFS_UNIT_FLOOR;
}

/**
 * Referring-domain counts for hosts never checked or older than 30 days, via the paid
 * backlinks-stats endpoint and the OWNER's SEO-metrics key (resolved server-side from
 * `User.seoSettings`, the same chain the warmup cron and the MCP refdomain tool walk — so the
 * walker works from any browser, not just the one that typed the key).
 *
 * One provider call per registrable name; every host behind it inherits the answer. Metered
 * exactly like /api/metrics/backlinks: reserve the call's fixed price against the monthly cap,
 * record before the request, release the reservation when the gateway refused to bill it.
 * `noKey` is returned without any network when no metrics key is configured — the caller must
 * say so out loud rather than show a silent zero.
 */
export async function enrichHostRefdomains(opts: { userId: string; hostIds?: number[]; limit?: number; deadline: number }):
  Promise<{ updated: number; remaining: number; noKey: boolean; errors: number }> {
  const out = { updated: 0, remaining: 0, noKey: false, errors: 0 };
  try {
    const cap = Math.max(0, opts.limit ?? 60);

    // The owner's credentials: active provider, mode slots (official / reseller / custom),
    // legacy global key last — verbatim the resolution `drops_enrich_refdomains` uses.
    const settings = await getOwnerSettings(opts.userId);
    const provider = parseMetricsProvider(settings.seoMetricsProvider);
    const mode = String(settings[`seoMetricsMode_${provider}`] ?? "");
    const slot = mode === "reseller" || mode === "custom" ? `seoKey_${provider}__${mode}` : `seoKey_${provider}`;
    const apiKey = String(settings[slot] ?? settings[`seoKey_${provider}`] ?? "").trim();
    if (!apiKey) { out.noKey = true; return out; } // nothing can be fetched and nothing ever will
    const baseUrl = String(settings[`seoMetricsBaseUrl_${provider}`] ?? "").trim() || undefined;
    const creds = { provider, apiKey, baseUrl };
    // cap 0 means "no cap configured" — withinCap passes it through as unlimited.
    const monthlyCap = Math.max(0, Number(settings.seoMetricsCap ?? 0));
    const unitsPerCall = refdomainStatsUnits(provider);

    const now = new Date();
    const staleBefore = new Date(now.getTime() - REFDOMAINS_TTL_MS);
    const pending = {
      OR: [
        { refdomainsCheckedAt: null },
        { refdomainsCheckedAt: { lt: staleBefore } },
      ],
    };

    // Candidates: the hosts the caller asked about, or every host that currently holds
    // keywords in at least one project — most keywords first, so a bounded step spends the
    // owner's units on the domains worth reading.
    let ids: number[];
    if (opts.hostIds?.length) {
      ids = opts.hostIds;
    } else {
      try {
        const active = await prisma.serpProjectHost.findMany({
          where: { keywords: { gt: 0 } },
          orderBy: { keywords: "desc" },
          distinct: ["hostId"],
          select: { hostId: true },
        });
        ids = active.map(r => r.hostId);
      } catch (e) {
        if (!isSchemaMissing(e)) out.errors++;
        return out;
      }
    }

    const candidates: HostRow[] = [];
    try {
      for (const part of chunks(ids, ID_CHUNK)) {
        const rows = await prisma.serpHost.findMany({
          where: { AND: [pending, { id: { in: part } }] },
          select: HOST_SELECT,
        });
        candidates.push(...rows);
        if (candidates.length >= cap * 3) break; // headroom for the platform cut below
      }
    } catch (e) {
      if (!isSchemaMissing(e)) out.errors++;
      return out;
    }

    // Never platforms — nobody buys links on facebook.com. Same cut the DR walker makes.
    const fresh = candidates.filter(h => !hostMatchesEntries(h.host, DEFAULT_PLATFORM_HOSTS));
    if (fresh.length) {
      let priority = new Set<number>();
      try { priority = await top30HostIds(); } catch { /* ordering only */ }
      fresh.sort((a, b) => Number(priority.has(b.id)) - Number(priority.has(a.id)) || a.id - b.id);
    }

    // One provider question per registrable; a host whose registrable is unknown can never be
    // asked, so it is written off here (checked, no value) instead of requeueing forever.
    const noRegistrable: number[] = [];
    const byRegistrable = new Map<string, number[]>();
    for (const h of fresh.slice(0, cap)) {
      const reg = (h.registrable || apexOf(h.host) || "").trim().toLowerCase();
      if (!reg) { noRegistrable.push(h.id); continue; }
      let list = byRegistrable.get(reg);
      if (!list) { list = []; byRegistrable.set(reg, list); }
      list.push(h.id);
    }
    if (noRegistrable.length) {
      try {
        await prisma.serpHost.updateMany({
          where: { id: { in: noRegistrable } },
          data: { refdomainsCheckedAt: now },
        });
      } catch { /* they stay pending; the loop's stalled guard still ends the walk */ }
      out.errors += noRegistrable.length;
    }

    for (const [reg, hostIds] of byRegistrable) {
      if (Date.now() > opts.deadline - REFDOMAINS_CALL_MARGIN_MS) break; // rest stays pending
      if (!(await withinCap(opts.userId, provider, unitsPerCall, monthlyCap))) {
        out.errors += hostIds.length;
        break; // the month's budget is out — stop rather than fail host by host
      }
      await recordUsage(opts.userId, provider, unitsPerCall);
      const res = await fetchBacklinkStats(creds, reg);
      // A refused or failed stats call is not billed by any of the three providers — the
      // reservation comes straight back off the meter.
      await releaseUnusedUnits(opts.userId, provider, unitsPerCall, res.ok ? unitsPerCall : 0);
      if (!res.ok) { out.errors += hostIds.length; continue; }
      try {
        const refdomains = res.totals.refDomainsTotal;
        for (const partIds of chunks(hostIds, ID_CHUNK)) {
          await prisma.serpHost.updateMany({
            where: { id: { in: partIds } },
            data: { refdomains: refdomains != null && Number.isFinite(refdomains) ? Math.round(refdomains) : null, refdomainsCheckedAt: new Date() },
          });
        }
        out.updated += hostIds.length;
      } catch {
        out.errors += hostIds.length;
      }
    }

    // Still-pending among the hosts this step was asked about — the client loops until it is 0
    // (or the count stops shrinking, which is how platform hosts and cap failures end it).
    try {
      let n = 0;
      for (const part of chunks(ids, ID_CHUNK)) {
        n += await prisma.serpHost.count({ where: { AND: [{ id: { in: part } }, pending] } });
      }
      out.remaining = n;
    } catch { /* treated as 0 — the stalled guard still ends the walk */ }
  } catch {
    // never throws outward: whatever landed is already in the counters
  }
  return out;
}

// ─── Entry points ───────────────────────────────────────────────────────────────

/** Age (RDAP/WHOIS) for hosts never checked or failed > 7 days ago, then DR (free endpoint) older than 30 days. Bounded by `limit` and `deadline`. */
export async function enrichPendingHosts(opts: { limit: number; deadline: number; userId?: string; hostIds?: number[]; what?: "age" | "dr" | "both" }):
  Promise<{ age: number; dr: number; errors: number }> {
  const result: Counters = { age: 0, dr: 0, errors: 0 };
  const what = opts.what ?? "both";
  const { userId } = opts;
  try {
    if (what === "age" || what === "both") await enrichAge(opts, result);
    if ((what === "dr" || what === "both") && userId) {
      await enrichDr({ limit: opts.limit, userId, hostIds: opts.hostIds }, result);
    }
  } catch {
    // never throws outward: whatever landed is already in the counters
  }
  return result;
}

/**
 * Host ids of one project that still await enrichment (age first, DR when asked, referring
 * domains when asked). The routes pass these back through `hostIds`, which keeps one manual
 * step scoped to the project the user is looking at instead of the global dictionary.
 */
export async function pendingHostIds(projectId: string, what: "age" | "dr" | "refdomains" | "both" = "both", cap = 500): Promise<number[]> {
  try {
    const rows = await prisma.serpProjectHost.findMany({ where: { projectId }, select: { hostId: true } });
    const ids = [...new Set(rows.map(r => r.hostId))];
    if (!ids.length) return [];
    const now = new Date();
    const retryBefore = new Date(now.getTime() - AGE_RETRY_MS);
    const staleBefore = new Date(now.getTime() - DR_TTL_MS);
    const staleRefBefore = new Date(now.getTime() - REFDOMAINS_TTL_MS);
    const wantAge = what === "age" || what === "both";
    const wantDr = what === "dr" || what === "both";
    const wantRefdomains = what === "refdomains";
    const out: number[] = [];
    for (const part of chunks(ids, ID_CHUNK)) {
      const hosts = await prisma.serpHost.findMany({
        where: { id: { in: part } },
        select: { id: true, ageCheckedAt: true, ageError: true, drCheckedAt: true, refdomainsCheckedAt: true },
      });
      for (const h of hosts) {
        const pendingAge = wantAge && (!h.ageCheckedAt || (h.ageError != null && h.ageCheckedAt < retryBefore));
        const pendingDr = wantDr && (!h.drCheckedAt || h.drCheckedAt < staleBefore);
        const pendingRefdomains = wantRefdomains && (!h.refdomainsCheckedAt || h.refdomainsCheckedAt < staleRefBefore);
        if (pendingAge || pendingDr || pendingRefdomains) out.push(h.id);
        if (out.length >= cap) return out;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Whether a DR key (free endpoint or Ahrefs) is configured for the workspace owner. */
export async function serpmonDrKeyFound(userId: string): Promise<boolean> {
  try {
    return Boolean(await resolveDrKey(userId));
  } catch {
    return false;
  }
}
