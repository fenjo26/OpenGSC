// SERP Monitor — host enrichment: registration age (RDAP/WHOIS through the drops registry
// stack) and DR (the free Ahrefs endpoint). Both are bounded: at most `limit` hosts per call,
// and the age phase stops at `deadline` (epoch ms) — the enrich route runs ONE step per HTTP
// request and reports `remaining` so the client can loop without holding the request open.
//
// Never throws outward: every failure lands in the `errors` counter, and unchecked hosts simply
// stay pending for the next slice.

import { prisma } from "@/lib/prisma";
import { checkAvailabilityBatch } from "@/lib/drops/availability";
import { profileForDomain, registryAnswerable, apexOf } from "@/lib/drops/registries";
import type { AvailabilityResult } from "@/lib/drops/types";
import { drForDomains, resolveDrKey } from "@/lib/drops/drFree";
import { isSchemaMissing, hostMatchesEntries } from "./domains";
import { DEFAULT_PLATFORM_HOSTS } from "./types";

const DAY_MS = 86_400_000;
/** A failed age answer is retried after a week. */
const AGE_RETRY_MS = 7 * DAY_MS;
/** A DR value older than a month is refreshed. */
const DR_TTL_MS = 30 * DAY_MS;
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
 * Host ids of one project that still await enrichment (age first, DR when asked). The enrich
 * route passes these back through `hostIds`, which keeps one manual step scoped to the project
 * the user is looking at instead of the global dictionary.
 */
export async function pendingHostIds(projectId: string, what: "age" | "dr" | "both" = "both", cap = 500): Promise<number[]> {
  try {
    const rows = await prisma.serpProjectHost.findMany({ where: { projectId }, select: { hostId: true } });
    const ids = [...new Set(rows.map(r => r.hostId))];
    if (!ids.length) return [];
    const now = new Date();
    const retryBefore = new Date(now.getTime() - AGE_RETRY_MS);
    const staleBefore = new Date(now.getTime() - DR_TTL_MS);
    const wantAge = what === "age" || what === "both";
    const wantDr = what === "dr" || what === "both";
    const out: number[] = [];
    for (const part of chunks(ids, ID_CHUNK)) {
      const hosts = await prisma.serpHost.findMany({
        where: { id: { in: part } },
        select: { id: true, ageCheckedAt: true, ageError: true, drCheckedAt: true },
      });
      for (const h of hosts) {
        const pendingAge = wantAge && (!h.ageCheckedAt || (h.ageError != null && h.ageCheckedAt < retryBefore));
        const pendingDr = wantDr && (!h.drCheckedAt || h.drCheckedAt < staleBefore);
        if (pendingAge || pendingDr) out.push(h.id);
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
