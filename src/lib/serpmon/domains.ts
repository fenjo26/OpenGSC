// SERP Monitor — domain catalogue: the per-project SerpProjectHost rollup, the tag rules,
// the listing behind the "Домены" tab, and the pure helpers the API and the CSV export share.
//
// The tab answers four questions from the "fresh registrants in the top" post: who of the young
// domains already ranks, who holds the most keywords, who grows, and who bounces in and out.

import { prisma } from "@/lib/prisma";
import {
  BOUNCE_RUNS, DEFAULT_PLATFORM_HOSTS, NEW_HOST_DAYS, YOUNG_HOST_MONTHS,
  type DomainQuery, type DomainRow, type DomainTag,
} from "./types";

const DAY_MS = 86_400_000;
/** Batches stay ≤ 400 bound parameters: 20 upserts of ~11 fields each sit well inside. */
const UPSERT_CHUNK = 20;
/** Dictionary ids (SerpUrl / SerpHost) are read with plain `IN` queries — same bound. */
const ID_CHUNK = 300;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// ─── Pure helpers ───────────────────────────────────────────────────────────────

/** true when host equals an entry or ends with "." + entry: m.facebook.com is facebook.com, netflix.com is not x.com. */
export function hostMatchesEntries(host: string, entries: readonly string[]): boolean {
  const h = host.trim().toLowerCase();
  return entries.some(e => {
    const entry = e.trim().toLowerCase();
    return h === entry || h.endsWith(`.${entry}`);
  });
}

/** Split a textarea value (newlines or commas): trimmed, lower-cased, www. stripped, deduped. */
function parseHostList(raw: string): string[] {
  return [...new Set(
    raw.split(/[\n,]/)
      .map(s => s.trim().toLowerCase().replace(/^www\./, ""))
      .filter(Boolean),
  )];
}

/**
 * Full months between a registration date and now: 2026-03-15 → 2026-09-15 is exactly 6,
 * → 2026-09-14 is still 5. A date in the future (bad WHOIS data) is 0, not negative.
 */
export function calcAgeMonths(registeredAt: Date | string, now: Date): number | null {
  const from = typeof registeredAt === "string" ? new Date(registeredAt) : registeredAt;
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) return null;
  let months = (now.getFullYear() - from.getFullYear()) * 12 + (now.getMonth() - from.getMonth());
  if (now.getDate() < from.getDate()) months -= 1;
  return Math.max(0, months);
}

export interface BounceChange {
  keywordId: string;
  kind: string;            // enter | exit | up | down
  /** Run ordinal inside the compared window; both endpoints of a pair sit in it, so distances are the real ones. */
  runIndex: number;
}

/**
 * enter→exit pairs of ONE host on the same keyword, at most BOUNCE_RUNS runs apart.
 * `changes` must be chronological. A later enter replaces an unmatched one — the diff engine
 * only emits `enter` for a host that is absent, so the normal flow is strict alternation.
 */
export function countBounces(changes: readonly BounceChange[]): number {
  const open = new Map<string, number>(); // keywordId -> runIndex of the unmatched enter
  let pairs = 0;
  for (const c of changes) {
    if (c.kind === "enter") {
      open.set(c.keywordId, c.runIndex);
    } else if (c.kind === "exit") {
      const start = open.get(c.keywordId);
      if (start === undefined) continue;
      open.delete(c.keywordId);
      if (c.runIndex - start <= BOUNCE_RUNS) pairs++;
    }
  }
  return pairs;
}

/** RFC 4180 field: quoted and escaped only when the value contains a comma, quote or newline. */
export function csvField(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV line, comma-separated, CRLF-terminated per RFC 4180. */
export function csvLine(fields: readonly unknown[]): string {
  return `${fields.map(csvField).join(",")}\r\n`;
}

/** project name → URL/path slug: "Казино BR 🇧🇷" → "kazino-br", "" → "project". */
export function slugifyName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return slug || "project";
}

// ─── Tags ───────────────────────────────────────────────────────────────────────

export function domainTags(row: Omit<DomainRow, "tags">, ctx: {
  now: Date; firstRunAt: Date | null; ownDomains: readonly string[]; isPlatform: (h: string) => boolean; maxAgeMonths: number;
}): DomainTag[] {
  const tags: DomainTag[] = [];
  const firstSeen = new Date(row.firstSeenAt);
  // "new" needs a life before the project's first done run: on the first run every host is
  // seen for the first time, and none of them is news.
  if (
    ctx.firstRunAt && !Number.isNaN(firstSeen.getTime()) &&
    firstSeen > ctx.firstRunAt &&
    ctx.now.getTime() - firstSeen.getTime() <= NEW_HOST_DAYS * DAY_MS
  ) tags.push("new");
  if (row.ageMonths !== null && row.ageMonths < ctx.maxAgeMonths) tags.push("young");
  const delta = row.keywords - row.prevKeywords;
  if (delta >= 2) tags.push("rising");
  if (delta <= -2) tags.push("falling");
  if (row.bounces > 0) tags.push("bounced");
  if (ctx.isPlatform(row.host)) tags.push("platform");
  if (hostMatchesEntries(row.host, ctx.ownDomains)) tags.push("own");
  return tags;
}

// ─── Schema-not-migrated ────────────────────────────────────────────────────────

/**
 * Same shape as drops' schemaMissing, for the Serp* tables. Routes turn it into
 * `200 { notMigrated: true }`; rebuildProjectHosts swallows it (the collector that calls
 * it has already given up on this tick).
 */
export function isSchemaMissing(e: unknown): boolean {
  const value = e as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" ||
    /Serp\w*(?:does not exist|no such table)/i.test(String(value?.message ?? ""))
  );
}

// ─── rebuildProjectHosts ────────────────────────────────────────────────────────

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface HostAccum {
  /** keywordId → best position of this host in that keyword's latest snapshot */
  kwBest: Map<string, number>;
  first: Date;
  last: Date;
}

/**
 * Roll the latest ok|partial snapshot of every active keyword (`SerpKeyword.lastSnapshotId`)
 * into `SerpProjectHost`. Called from finalizeRun after every run.
 *
 * Hosts that left every latest snapshot are zeroed, not deleted — "who left" is history worth
 * keeping, and their `prevKeywords` keeps the falling preset working.
 */
export async function rebuildProjectHosts(projectId: string, runId: string): Promise<void> {
  try {
    const keywords = await prisma.serpKeyword.findMany({
      where: { projectId, active: true, lastSnapshotId: { not: null } },
      select: { id: true, lastSnapshotId: true },
    });
    const keywordBySnapshot = new Map(keywords.map(k => [k.lastSnapshotId as string, k.id]));

    const snapshots = [];
    for (const ids of chunks([...keywordBySnapshot.keys()], ID_CHUNK)) {
      for (const s of await prisma.serpSnapshot.findMany({
        where: { id: { in: ids } },
        select: { id: true, rows: true, takenAt: true },
      })) snapshots.push(s);
    }

    // rows are "[position, urlId][]" — resolve urlId → hostId once, in dictionary-sized chunks.
    const urlIds = new Set<number>();
    const parsed: Array<{ snapshotId: string; takenAt: Date; rows: Array<[number, number]> }> = [];
    for (const s of snapshots) {
      let raw: unknown = [];
      try { raw = JSON.parse(s.rows); } catch { /* a corrupt row means "no rows", not "no snapshot" */ }
      const tuples: Array<[number, number]> = [];
      if (Array.isArray(raw)) {
        for (const r of raw) {
          if (!Array.isArray(r) || r.length < 2) continue;
          const pos = Number(r[0]);
          const urlId = Number(r[1]);
          if (!Number.isFinite(pos) || !Number.isInteger(urlId)) continue;
          tuples.push([pos, urlId]);
          urlIds.add(urlId);
        }
      }
      parsed.push({ snapshotId: s.id, takenAt: s.takenAt, rows: tuples });
    }

    const hostOfUrl = new Map<number, number>();
    for (const ids of chunks([...urlIds], ID_CHUNK)) {
      for (const u of await prisma.serpUrl.findMany({ where: { id: { in: ids } }, select: { id: true, hostId: true } })) {
        hostOfUrl.set(u.id, u.hostId);
      }
    }

    const acc = new Map<number, HostAccum>();
    for (const p of parsed) {
      const kwId = keywordBySnapshot.get(p.snapshotId);
      // Best position of every host within this one snapshot (a host may hold several URLs).
      const bestHere = new Map<number, number>();
      for (const [pos, urlId] of p.rows) {
        const hostId = hostOfUrl.get(urlId);
        if (hostId === undefined) continue;
        const prev = bestHere.get(hostId);
        if (prev === undefined || pos < prev) bestHere.set(hostId, pos);
      }
      for (const [hostId, pos] of bestHere) {
        let a = acc.get(hostId);
        if (!a) { a = { kwBest: new Map(), first: p.takenAt, last: p.takenAt }; acc.set(hostId, a); }
        if (kwId) {
          const prevBest = a.kwBest.get(kwId);
          if (prevBest === undefined || pos < prevBest) a.kwBest.set(kwId, pos);
        }
        if (p.takenAt < a.first) a.first = p.takenAt;
        if (p.takenAt > a.last) a.last = p.takenAt;
      }
    }

    // bounces: enter→exit pairs over the last 2 × BOUNCE_RUNS runs of the project. Indices are
    // local to that window, which is enough — both endpoints of every pair live inside it.
    const windowRuns = await prisma.serpRun.findMany({
      where: { projectId },
      orderBy: { startedAt: "desc" },
      take: 2 * BOUNCE_RUNS,
      select: { id: true },
    });
    const runIndex = new Map(windowRuns.map((r, i) => [r.id, windowRuns.length - 1 - i]));
    if (!runIndex.has(runId)) runIndex.set(runId, windowRuns.length);

    const bounceByHost = new Map<number, number>();
    if (runIndex.size) {
      const changes = await prisma.serpChange.findMany({
        where: { projectId, snapshot: { runId: { in: [...runIndex.keys()] } } },
        orderBy: { takenAt: "asc" },
        select: { hostId: true, keywordId: true, kind: true, snapshot: { select: { runId: true } } },
      });
      const perHost = new Map<number, BounceChange[]>();
      for (const c of changes) {
        const idx = runIndex.get(c.snapshot.runId);
        if (idx === undefined) continue;
        let list = perHost.get(c.hostId);
        if (!list) { list = []; perHost.set(c.hostId, list); }
        list.push({ keywordId: c.keywordId, kind: c.kind, runIndex: idx });
      }
      for (const [hostId, list] of perHost) bounceByHost.set(hostId, countBounces(list));
    }

    // prevKeywords is the value stored before this rebuild — the trend arrow needs the run before.
    const existing = await prisma.serpProjectHost.findMany({
      where: { projectId },
      select: { hostId: true, keywords: true },
    });
    const prevKeywordsByHost = new Map(existing.map(e => [e.hostId, e.keywords]));

    const present = [...acc.entries()].map(([hostId, a]) => {
      const bests = [...a.kwBest.values()];
      const kwCount = bests.length;
      return {
        hostId,
        firstSeenAt: a.first,
        lastSeenAt: a.last,
        keywords: kwCount,
        prevKeywords: prevKeywordsByHost.get(hostId) ?? 0,
        top10: bests.filter(p => p <= 10).length,
        top30: bests.filter(p => p <= 30).length,
        bestPos: kwCount ? Math.min(...bests) : null,
        avgPos: kwCount ? bests.reduce((s, p) => s + p, 0) / kwCount : null,
        bounces: bounceByHost.get(hostId) ?? 0,
      };
    });
    const presentIds = new Set(present.map(r => r.hostId));
    const gone = existing
      .filter(e => !presentIds.has(e.hostId))
      .map(e => ({
        hostId: e.hostId,
        prevKeywords: e.keywords,
        bounces: bounceByHost.get(e.hostId) ?? 0,
      }));

    for (const part of chunks(present, UPSERT_CHUNK)) {
      await prisma.$transaction(part.map(r => prisma.serpProjectHost.upsert({
        where: { projectId_hostId: { projectId, hostId: r.hostId } },
        create: {
          projectId, hostId: r.hostId,
          firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt,
          keywords: r.keywords, prevKeywords: r.prevKeywords,
          top10: r.top10, top30: r.top30,
          bestPos: r.bestPos, avgPos: r.avgPos, bounces: r.bounces,
        },
        update: {
          lastSeenAt: r.lastSeenAt,
          keywords: r.keywords, prevKeywords: r.prevKeywords,
          top10: r.top10, top30: r.top30,
          bestPos: r.bestPos, avgPos: r.avgPos, bounces: r.bounces,
        },
      })));
    }
    for (const part of chunks(gone, UPSERT_CHUNK)) {
      try {
        await prisma.$transaction(part.map(r => prisma.serpProjectHost.update({
          where: { projectId_hostId: { projectId, hostId: r.hostId } },
          data: {
            keywords: 0, prevKeywords: r.prevKeywords,
            top10: 0, top30: 0, bestPos: null, avgPos: null,
            bounces: r.bounces,
          },
        })));
      } catch (e) {
        // A row removed concurrently (project deleted mid-rebuild) is not a rebuild failure.
        if ((e as { code?: string })?.code !== "P2025") throw e;
      }
    }
  } catch (e) {
    if (isSchemaMissing(e)) return; // no tables yet — the project page tells the user what to run
    throw e;
  }
}

// ─── Listing ────────────────────────────────────────────────────────────────────

const DOMAIN_PRESETS = ["all", "new", "young", "rising", "falling", "bounced"] as const;
const DOMAIN_SORTS = ["keywords", "top10", "bestPos", "firstSeen", "age", "dr"] as const;

/** DomainQuery from a URL query string; unknown values fall back to defaults, numbers clamp. */
export function domainQueryFromSearchParams(sp: URLSearchParams): DomainQuery {
  const q: DomainQuery = {};
  const preset = sp.get("preset");
  if (preset && (DOMAIN_PRESETS as readonly string[]).includes(preset)) q.preset = preset as DomainQuery["preset"];
  const query = sp.get("q");
  if (query) q.q = query;
  const maxAge = Number(sp.get("maxAgeMonths"));
  if (Number.isFinite(maxAge) && maxAge > 0) q.maxAgeMonths = Math.floor(maxAge);
  const platforms = sp.get("includePlatforms");
  if (platforms === "1" || platforms === "true") q.includePlatforms = true;
  const sort = sp.get("sort");
  if (sort && (DOMAIN_SORTS as readonly string[]).includes(sort)) q.sort = sort as DomainQuery["sort"];
  const page = Number(sp.get("page"));
  if (Number.isFinite(page) && page > 0) q.page = Math.floor(page);
  const pageSize = Number(sp.get("pageSize"));
  if (Number.isFinite(pageSize) && pageSize > 0) q.pageSize = Math.floor(Math.min(pageSize, MAX_PAGE_SIZE));
  return q;
}

/**
 * The "Домены" rows. Filters that Prisma cannot express on the computed fields (rising/falling
 * deltas, age in months) run after the fetch — the fetch is the whole project anyway, a few
 * thousand small rows, so `total` stays honest for every preset.
 */
export async function domainRows(userId: string, projectId: string, q: DomainQuery): Promise<{ rows: DomainRow[]; total: number } | null> {
  const project = await prisma.serpProject.findFirst({
    where: { id: projectId, userId },
    select: { firstRunAt: true, ownDomains: true, ignoreHosts: true },
  });
  if (!project) return null;

  const now = new Date();
  const ownDomains = parseHostList(project.ownDomains);
  const platformEntries = [...DEFAULT_PLATFORM_HOSTS, ...parseHostList(project.ignoreHosts)];
  const isPlatform = (h: string) => hostMatchesEntries(h, platformEntries);
  const maxAgeMonths = q.maxAgeMonths ?? YOUNG_HOST_MONTHS;
  const preset = q.preset ?? "all";
  const query = (q.q ?? "").trim().toLowerCase();

  const projectHosts = await prisma.serpProjectHost.findMany({ where: { projectId } });
  const hosts = new Map<number, {
    id: number; host: string; registrable: string;
    registeredAt: Date | null; ageError: string | null; dr: number | null;
  }>();
  const hostIds = [...new Set(projectHosts.map(r => r.hostId))];
  for (const ids of chunks(hostIds, ID_CHUNK)) {
    for (const h of await prisma.serpHost.findMany({ where: { id: { in: ids } } })) hosts.set(h.id, h);
  }

  const filtered = projectHosts.filter(r => {
    const h = hosts.get(r.hostId);
    if (!h) return false;
    if (query && !h.host.includes(query)) return false;
    // By default a host that holds nothing is noise — except in the falling preset, whose whole
    // point is the drop to zero.
    if (r.keywords === 0 && preset !== "falling") return false;
    const firstSeen = r.firstSeenAt;
    switch (preset) {
      case "new":
        if (!project.firstRunAt || firstSeen <= project.firstRunAt) return false;
        if (now.getTime() - firstSeen.getTime() > NEW_HOST_DAYS * DAY_MS) return false;
        break;
      case "young": {
        const age = h.registeredAt ? calcAgeMonths(h.registeredAt, now) : null;
        if (age === null || age >= maxAgeMonths) return false;
        break;
      }
      case "rising":
        if (r.keywords - r.prevKeywords < 2) return false;
        break;
      case "falling":
        if (r.keywords - r.prevKeywords > -2) return false;
        break;
      case "bounced":
        if (r.bounces <= 0) return false;
        break;
    }
    if (q.maxAgeMonths != null) {
      const age = h.registeredAt ? calcAgeMonths(h.registeredAt, now) : null;
      if (age === null || age > q.maxAgeMonths) return false;
    }
    return true;
  });

  const rows: DomainRow[] = filtered.map(r => {
    const h = hosts.get(r.hostId)!;
    const registeredAt = h.registeredAt;
    const base = {
      hostId: r.hostId,
      host: h.host,
      registrable: h.registrable,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      registeredAt: registeredAt ? registeredAt.toISOString() : null,
      ageMonths: registeredAt ? calcAgeMonths(registeredAt, now) : null,
      ageError: h.ageError,
      dr: h.dr,
      keywords: r.keywords,
      prevKeywords: r.prevKeywords,
      top10: r.top10,
      top30: r.top30,
      bestPos: r.bestPos,
      avgPos: r.avgPos,
      bounces: r.bounces,
    };
    return {
      ...base,
      tags: domainTags(base, { now, firstRunAt: project.firstRunAt, ownDomains, isPlatform, maxAgeMonths }),
    };
  }).filter(row => q.includePlatforms || !row.tags.includes("platform"));

  const sort = q.sort ?? "keywords";
  const cmp: Record<string, (a: DomainRow, b: DomainRow) => number> = {
    keywords: (a, b) => b.keywords - a.keywords,
    top10: (a, b) => b.top10 - a.top10,
    bestPos: (a, b) => (a.bestPos ?? Number.POSITIVE_INFINITY) - (b.bestPos ?? Number.POSITIVE_INFINITY),
    firstSeen: (a, b) => Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt),
    age: (a, b) => (a.ageMonths ?? Number.POSITIVE_INFINITY) - (b.ageMonths ?? Number.POSITIVE_INFINITY),
    dr: (a, b) => (b.dr ?? -1) - (a.dr ?? -1),
  };
  rows.sort((a, b) => cmp[sort](a, b) || a.host.localeCompare(b.host));

  const total = rows.length;
  const pageSize = Math.min(Math.max(q.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const page = Math.max(q.page ?? 1, 1);
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total };
}
