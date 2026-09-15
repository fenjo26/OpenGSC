// SERP Monitor — the only module of the wave that owns queries. Collection (collector.ts),
// scheduling (scheduler.ts) and every route read and write through this file, so the invariants
// live here rather than being re-invented per caller:
//
//   - every function that takes a userId first verifies that the project (or the row's project)
//     belongs to that user — a foreign id is indistinguishable from a missing one;
//   - a `failed` snapshot never touches SerpKeyword.lastSnapshotId — a burned proxy must never
//     look like an empty SERP, or the next comparison invents a fake storm;
//   - one keyword write is one transaction (snapshot + changes + keyword + run counter);
//   - statement parameter lists stay ≤ 400 (SQLite's ceiling is lower than you hope);
//   - `createMany({ skipDuplicates })` does not exist on SQLite — read what exists, split into
//     inserts and updates, and catch P2002 for the rare race, then re-read.
//
// The Serp* models are reached through an untyped accessor, the way drops and a dozen other
// modules do: the generated client only learns a model after `prisma db push`, and this app
// pushes at container start rather than at build time.
import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { apexOf } from "@/lib/drops/registries";
import { COUNTRIES, defaultLanguageFor } from "@/lib/seo/regions";
import { hostMatches, ignorePredicate, parseHostList } from "./hosts";
import { comparableDepth } from "./noise";
import { diffKeyword } from "./diff";
import { parseKeywordImport, type KeywordImport } from "./keywords";
import {
  SERPMON_DEPTHS, SERPMON_INTERVALS, SERPMON_MAX_KEYWORDS, STORM_MIN_BASELINE,
  type KeywordHistory, type MarketQuery, type MarketRow, type ProjectDetail,
  type ProjectSummary, type RunSummary, type SerpRow, type SnapshotStatus,
  type SnapshotView,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema
const db = prisma as any;

/**
 * Row and client shapes coming back through the untyped accessor are `any` by definition. One
 * alias per purpose keeps the annotations below explicit about that without an eslint-disable
 * on every line; both are the same escape hatch, named for readability.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema
type DbRow = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema
type DbClient = any;

/** Rows per statement. See the drops store for why 400 and not "as many as fit". */
const CHUNK = 400;

/** True when the failure is "the Serp* tables are not pushed yet", not a real error. */
export function schemaMissing(e: unknown): boolean {
  const value = e as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" ||
    /Serp\w*.*(?:does not exist|no such table)/i.test(String(value?.message ?? ""))
  );
}

function isP2002(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "P2002";
}

/** A request the route answers with 400 — the code is the message the UI can map. */
export class InputError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.name = "InputError";
    this.code = code;
  }
}

function chunk<T>(xs: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

const clampInt = (v: number, lo: number, hi: number) => Math.min(Math.max(Math.round(v), lo), hi);

// ─── Project input validation ────────────────────────────────────────────────

export interface ProjectInput {
  name: string; country: string; lang: string; depth: number; intervalHours: number;
  keywords?: string;          // raw import text
  ownDomains?: string; ignoreHosts?: string; retentionDays?: number; alertStorm?: boolean; paused?: boolean;
}

const MAX_LIST_FIELD = 10_000; // textarea fields; hosts are newline/comma separated

/**
 * Validate a create (partial=false) or patch (partial=true). Returns the columns ready for
 * Prisma; anything wrong throws {@link InputError} with a code the route turns into a 400.
 */
function validateProjectInput(input: Partial<ProjectInput>, partial: boolean) {
  const out: {
    name?: string; country?: string; lang?: string; depth?: number; intervalHours?: number;
    ownDomains?: string; ignoreHosts?: string; retentionDays?: number; alertStorm?: boolean; paused?: boolean;
  } = {};

  if (input.name !== undefined || !partial) {
    const name = String(input.name ?? "").trim();
    if (!name) throw new InputError("name_required");
    if (name.length > 120) throw new InputError("name_too_long");
    out.name = name;
  }
  if (input.country !== undefined || !partial) {
    const country = String(input.country ?? "").trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(country) || !COUNTRIES.some(c => c.code === country)) {
      throw new InputError("country_invalid");
    }
    out.country = country;
  }
  if (input.lang !== undefined || !partial) {
    const lang = String(input.lang ?? "").trim().toLowerCase();
    // Empty lang means "the default for the market" — the same list the SEO Tools use.
    const final = lang || defaultLanguageFor(out.country ?? "");
    if (!/^[a-z0-9-]{2,10}$/.test(final)) throw new InputError("lang_invalid");
    out.lang = final;
  }
  if (input.depth !== undefined || !partial) {
    const depth = Number(input.depth);
    if (!Number.isInteger(depth) || !(SERPMON_DEPTHS as readonly number[]).includes(depth)) {
      throw new InputError("depth_invalid");
    }
    out.depth = depth;
  }
  if (input.intervalHours !== undefined || !partial) {
    const intervalHours = Number(input.intervalHours);
    if (!Number.isInteger(intervalHours) || !(SERPMON_INTERVALS as readonly number[]).includes(intervalHours)) {
      throw new InputError("interval_invalid");
    }
    out.intervalHours = intervalHours;
  }
  if (input.retentionDays !== undefined) {
    const retentionDays = Number(input.retentionDays);
    if (!Number.isInteger(retentionDays) || retentionDays < 30 || retentionDays > 3650) {
      throw new InputError("retention_invalid");
    }
    out.retentionDays = retentionDays;
  }
  if (input.ownDomains !== undefined) out.ownDomains = String(input.ownDomains).slice(0, MAX_LIST_FIELD);
  if (input.ignoreHosts !== undefined) out.ignoreHosts = String(input.ignoreHosts).slice(0, MAX_LIST_FIELD);
  if (input.alertStorm !== undefined) out.alertStorm = Boolean(input.alertStorm);
  if (input.paused !== undefined) out.paused = Boolean(input.paused);
  return out;
}

// ─── Run summaries ───────────────────────────────────────────────────────────

export interface RunRowLike {
  id: string;
  projectId?: string;
  trigger: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  planned: number; ok: number; partial: number; failed: number; compared: number;
  volatility: number | null; volTop10: number | null; shareHigh: number | null;
  stormScore: number | null; storm: boolean; error: string | null;
}

const RUN_SELECT = {
  id: true, projectId: true, trigger: true, status: true, startedAt: true, finishedAt: true,
  planned: true, ok: true, partial: true, failed: true, compared: true,
  volatility: true, volTop10: true, shareHigh: true, stormScore: true, storm: true, error: true,
} as const;

/** Map a run row. `calibrating` is not a column — callers compute it per §5. */
export function toRunSummary(r: RunRowLike, calibrating: boolean): RunSummary {
  return {
    id: r.id,
    trigger: r.trigger === "manual" ? "manual" : "schedule",
    status: r.status === "done" ? "done" : r.status === "aborted" ? "aborted" : "running",
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    planned: r.planned, ok: r.ok, partial: r.partial, failed: r.failed, compared: r.compared,
    volatility: r.volatility ?? null, volTop10: r.volTop10 ?? null, shareHigh: r.shareHigh ?? null,
    stormScore: r.stormScore ?? null, storm: Boolean(r.storm), calibrating, error: r.error ?? null,
  };
}

/**
 * `calibrating` for a list of runs, from ONE count per project: walk the runs newest-first and
 * subtract the done-with-volatility runs already seen from the project total — the difference is
 * exactly the baseline a run had beneath it, without a query per run.
 */
function summarizeRuns(runs: RunRowLike[], volDoneTotal: number): { lastRun: RunSummary | null; series: (number | null)[] } {
  let seenVol = 0;
  let lastRun: RunSummary | null = null;
  const series: (number | null)[] = [];
  for (const r of runs) { // newest first
    const isVol = r.status === "done" && (r.volatility ?? 0) > 0;
    const baseline = volDoneTotal - seenVol - (isVol ? 1 : 0);
    if (!lastRun) lastRun = toRunSummary(r, baseline < STORM_MIN_BASELINE);
    if (r.status === "done" && series.length < 30) series.push(r.volatility ?? null);
    if (isVol) seenVol++;
  }
  return { lastRun, series: series.reverse() }; // oldest first
}

// ─── Host / URL dictionaries ─────────────────────────────────────────────────

/**
 * Host ids for the given host names, inserting the missing ones (`registrable` from the public
 * suffix list, "" when unknown). Two runs racing on the same new host: the loser catches P2002
 * and re-reads instead of failing the snapshot.
 */
async function ensureHostsWith(client: DbClient, hosts: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(hosts.filter(h => typeof h === "string" && h))];
  for (const chunkHosts of chunk(unique)) {
    const existing = await client.serpHost.findMany({
      where: { host: { in: chunkHosts } }, select: { id: true, host: true },
    }) as { id: number; host: string }[];
    for (const e of existing) out.set(e.host, e.id);
    const missing = chunkHosts.filter(h => !out.has(h));
    if (!missing.length) continue;
    try {
      await client.serpHost.createMany({
        data: missing.map(h => ({ host: h, registrable: apexOf(h) ?? "" })),
      });
    } catch (e) {
      if (!isP2002(e)) throw e; // a parallel run inserted the same host — re-read below
    }
    const created = await client.serpHost.findMany({
      where: { host: { in: missing } }, select: { id: true, host: true },
    }) as { id: number; host: string }[];
    for (const c of created) out.set(c.host, c.id);
  }
  return out;
}

/** Same, without a transaction around it (T4's enrich path and tests). */
export function ensureHosts(hosts: string[]): Promise<Map<string, number>> {
  return ensureHostsWith(db, hosts);
}

const urlHash = (url: string) => createHash("sha1").update(url).digest("hex");

/**
 * URL ids keyed by sha1(url), inserting the missing ones under their host. Existing rows get one
 * `updateMany` for `lastSeenAt`; titles are refreshed individually only where the provider now
 * shows a different one — per-row updates for 100-row SERPs are waste when nothing changed.
 */
async function ensureUrlsWith(
  client: DbClient,
  rows: { url: string; host: string; title?: string }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const byHash = new Map<string, { url: string; host: string; title: string }>();
  for (const r of rows) {
    if (!r.url) continue;
    const hash = urlHash(r.url);
    if (!byHash.has(hash)) byHash.set(hash, { url: r.url, host: r.host, title: r.title ?? "" });
  }
  const now = new Date();
  for (const batch of chunk([...byHash.keys()])) {
    const existing = await client.serpUrl.findMany({
      where: { urlHash: { in: batch } }, select: { id: true, urlHash: true, title: true },
    }) as { id: number; urlHash: string; title: string }[];
    if (existing.length) {
      await client.serpUrl.updateMany({
        where: { id: { in: existing.map(e => e.id) } }, data: { lastSeenAt: now },
      });
      for (const e of existing) {
        out.set(e.urlHash, e.id);
        const fresh = byHash.get(e.urlHash);
        if (fresh && fresh.title && fresh.title !== e.title) {
          await client.serpUrl.update({ where: { id: e.id }, data: { title: fresh.title } });
        }
      }
    }
    const missing = batch.filter(h => !out.has(h));
    if (!missing.length) continue;
    const hostMap = await ensureHostsWith(client, missing.map(h => byHash.get(h)!.host));
    try {
      await client.serpUrl.createMany({
        data: missing.map(hash => {
          const r = byHash.get(hash)!;
          return { urlHash: hash, url: r.url, hostId: hostMap.get(r.host) ?? 0, title: r.title };
        }),
      });
    } catch (e) {
      if (!isP2002(e)) throw e;
    }
    const created = await client.serpUrl.findMany({
      where: { urlHash: { in: missing } }, select: { id: true, urlHash: true },
    }) as { id: number; urlHash: string }[];
    for (const c of created) out.set(c.urlHash, c.id);
  }
  return out;
}

/** Same, without a transaction around it. */
export function ensureUrls(rows: { url: string; host: string; title?: string }[]): Promise<Map<string, number>> {
  return ensureUrlsWith(db, rows);
}

// ─── Snapshot rows: stored JSON ↔ SerpRow[] ──────────────────────────────────

export interface UrlHostMaps {
  urlById: Map<number, { url: string; hostId: number; title: string }>;
  hostById: Map<number, string>;
}

/** `[position, urlId][]` out of a stored `rows` column. Tolerates garbage: bad JSON → []. */
export function urlIdsFromRows(rowsJson: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rowsJson || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: number[] = [];
  for (const pair of parsed) {
    if (Array.isArray(pair) && Number.isInteger(pair[1])) out.push(pair[1] as number);
  }
  return out;
}

function parseRowPairs(rowsJson: string): [number, number][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rowsJson || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: [number, number][] = [];
  for (const pair of parsed) {
    if (Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isInteger(pair[1])) {
      out.push([pair[0] as number, pair[1] as number]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Urls + hosts for a batch of urlIds, in ≤ 400-parameter chunks. */
export async function loadUrlHostMaps(urlIds: number[]): Promise<UrlHostMaps> {
  const urlById = new Map<number, { url: string; hostId: number; title: string }>();
  const hostIds = new Set<number>();
  for (const batch of chunk([...new Set(urlIds)])) {
    const urls = await db.serpUrl.findMany({
      where: { id: { in: batch } }, select: { id: true, url: true, hostId: true, title: true },
    }) as { id: number; url: string; hostId: number; title: string }[];
    for (const u of urls) {
      urlById.set(u.id, { url: u.url, hostId: u.hostId, title: u.title });
      hostIds.add(u.hostId);
    }
  }
  const hostById = new Map<number, string>();
  for (const batch of chunk([...hostIds])) {
    const hosts = await db.serpHost.findMany({
      where: { id: { in: batch } }, select: { id: true, host: true },
    }) as { id: number; host: string }[];
    for (const h of hosts) hostById.set(h.id, h.host);
  }
  return { urlById, hostById };
}

/** Expand a stored `rows` column into display rows, positions ascending. */
export function expandRowsJson(rowsJson: string, maps: UrlHostMaps): SerpRow[] {
  const out: SerpRow[] = [];
  for (const [position, urlId] of parseRowPairs(rowsJson)) {
    const u = maps.urlById.get(urlId);
    if (!u) continue;
    out.push({ position, url: u.url, host: maps.hostById.get(u.hostId) ?? "", title: u.title });
  }
  return out;
}

// ─── Snapshot write (used by the collector) ──────────────────────────────────

export interface SnapshotWriteInput {
  runId: string;
  projectId: string;
  keywordId: string;
  status: SnapshotStatus;
  problem: string | null;
  detail: string | null;                 // raw provider/transport error, sanitized; null when none
  depth: number;
  totalCount: string;
  features: string[];
  rows: SerpRow[];                       // empty for failed
  prev: { id: string; status: SnapshotStatus; got: number; rows: SerpRow[] } | null;
  ignore: (host: string) => boolean;
}

export interface SnapshotWriteResult {
  /** false when another writer already stored this (runId, keywordId) — the keyword counts as taken. */
  written: boolean;
  compared: boolean;
  volatility: number | null;
  visibleChanges: number;
}

/**
 * Store one keyword's snapshot: dictionaries, the snapshot (`rows` as [position, urlId] JSON),
 * its SerpChange rows, the keyword's last* columns and the run's progress counter — one
 * transaction, so a crash halfway leaves nothing half-written. A `failed` snapshot is stored
 * with empty rows and touches only lastStatus/lastProblem/lastDetail: it must never become the
 * keyword's comparison base.
 */
export async function writeSnapshot(input: SnapshotWriteInput): Promise<SnapshotWriteResult> {
  const notCompared: SnapshotWriteResult = { written: false, compared: false, volatility: null, visibleChanges: 0 };
  const now = new Date();
  const failed = input.status === "failed";
  const depth = input.prev
    ? comparableDepth({ status: input.prev.status, got: input.prev.got }, { status: input.status, got: input.rows.length })
    : 0;
  const diff = input.prev && depth > 0 && !failed
    ? diffKeyword(input.prev.rows, input.rows, { depth, ignore: input.ignore })
    : null;

  try {
    await db.$transaction(async (tx: DbClient) => {
      const hosts = [
        ...input.rows.map(r => r.host),
        ...(diff ? diff.changes.map(c => c.host) : []),
      ];
      const hostMap = await ensureHostsWith(tx, hosts);
      const urlMap = failed ? new Map<string, number>() : await ensureUrlsWith(tx, input.rows);

      const rowPairs: [number, number][] = failed
        ? []
        : input.rows
            .map(r => [r.position, urlMap.get(urlHash(r.url)) ?? 0] as [number, number])
            .filter(([, urlId]) => urlId > 0);

      let snapshotId = "";
      try {
        const snap = await tx.serpSnapshot.create({
          data: {
            projectId: input.projectId,
            keywordId: input.keywordId,
            runId: input.runId,
            takenAt: now,
            status: input.status,
            problem: input.problem ?? null,
            detail: input.detail ?? null,
            depth: input.depth,
            got: input.rows.length,
            totalCount: input.totalCount ?? "",
            rows: JSON.stringify(rowPairs),
            features: input.features?.length ? JSON.stringify(input.features) : "",
            prevId: diff ? input.prev!.id : null,
            comparedDepth: diff ? depth : null,
            volatility: diff ? diff.volatility : null,
            volTop10: diff ? diff.volTop10 : null,
            changeCount: diff ? diff.visibleCount : 0,
          },
          select: { id: true },
        }) as { id: string };
        snapshotId = snap.id;
      } catch (e) {
        if (isP2002(e)) return; // the unique [runId, keywordId] says this keyword is already taken
        throw e;
      }

      if (diff?.changes.length) {
        await tx.serpChange.createMany({
          data: diff.changes.map(c => ({
            projectId: input.projectId,
            keywordId: input.keywordId,
            snapshotId,
            hostId: hostMap.get(c.host) ?? 0,
            kind: c.kind,
            fromPos: c.from,
            toPos: c.to,
            urls: c.urls,
            hidden: c.hidden,
            takenAt: now,
          })),
        });
      }

      await tx.serpKeyword.update({
        where: { id: input.keywordId },
        data: failed
          ? { lastStatus: input.status, lastProblem: input.problem ?? null, lastDetail: input.detail ?? null }
          : {
              lastStatus: input.status,
              lastProblem: input.problem ?? null,
              lastDetail: input.detail ?? null,
              lastSnapshotId: snapshotId,
              lastOkAt: now,
              lastChangeCount: diff ? diff.visibleCount : 0,
              lastVolatility: diff ? diff.volatility : null,
            },
      });

      const increment = input.status === "ok"
        ? { ok: { increment: 1 } }
        : input.status === "partial"
          ? { partial: { increment: 1 } }
          : { failed: { increment: 1 } };
      await tx.serpRun.update({ where: { id: input.runId }, data: increment });
    });
  } catch (e) {
    if (isP2002(e)) return notCompared;
    throw e;
  }

  return {
    written: true,
    compared: Boolean(diff),
    volatility: diff ? diff.volatility : null,
    visibleChanges: diff ? diff.visibleCount : 0,
  };
}

// ─── Projects ────────────────────────────────────────────────────────────────

async function ownedProject(userId: string, id: string) {
  return db.serpProject.findFirst({ where: { id, userId } }) as Promise<Record<string, DbRow> | null>;
}

export async function listProjects(userId: string): Promise<ProjectSummary[]> {
  const projects = await db.serpProject.findMany({
    where: { userId }, orderBy: { createdAt: "desc" },
  }) as Record<string, DbRow>[];
  if (!projects.length) return [];
  const ids = projects.map(p => p.id);

  // Three queries for the whole list, regardless of project count: keyword totals, the done
  // runs each project can calibrate against, and one window of recent runs for lastRun + the
  // 30-point volatility series.
  const [kwCounts, volCounts, runs] = await Promise.all([
    db.serpKeyword.groupBy({
      by: ["projectId"], where: { projectId: { in: ids }, active: true }, _count: { _all: true },
    }) as Promise<{ projectId: string; _count: { _all: number } }[]>,
    db.serpRun.groupBy({
      by: ["projectId"], where: { projectId: { in: ids }, status: "done", volatility: { gt: 0 } },
      _count: { _all: true },
    }) as Promise<{ projectId: string; _count: { _all: number } }[]>,
    db.serpRun.findMany({
      where: { projectId: { in: ids } },
      orderBy: { startedAt: "desc" },
      take: Math.min(ids.length * 40 + 40, 2000),
      select: RUN_SELECT,
    }) as Promise<(RunRowLike & { projectId: string })[]>,
  ]);

  const kwByProject = new Map(kwCounts.map(g => [g.projectId, g._count._all]));
  const volByProject = new Map(volCounts.map(g => [g.projectId, g._count._all]));
  const runsByProject = new Map<string, RunRowLike[]>();
  for (const r of runs) {
    if (!runsByProject.has(r.projectId)) runsByProject.set(r.projectId, []);
    runsByProject.get(r.projectId)!.push(r);
  }

  return projects.map(p => {
    const { lastRun, series } = summarizeRuns(runsByProject.get(p.id) ?? [], volByProject.get(p.id) ?? 0);
    return {
      id: p.id, name: p.name, engine: p.engine, device: p.device, country: p.country, lang: p.lang,
      depth: p.depth, intervalHours: p.intervalHours, paused: Boolean(p.paused),
      keywords: kwByProject.get(p.id) ?? 0,
      lastRunAt: p.lastRunAt ? p.lastRunAt.toISOString() : null,
      nextRunAt: p.nextRunAt ? p.nextRunAt.toISOString() : null,
      lastRun, volatilitySeries: series,
    };
  });
}

export async function getProject(userId: string, id: string): Promise<ProjectDetail | null> {
  const p = await ownedProject(userId, id);
  if (!p) return null;
  const [kwCount, volCount, runs, groups] = await Promise.all([
    db.serpKeyword.count({ where: { projectId: id, active: true } }),
    db.serpRun.count({ where: { projectId: id, status: "done", volatility: { gt: 0 } } }),
    db.serpRun.findMany({
      where: { projectId: id }, orderBy: { startedAt: "desc" }, take: 40, select: RUN_SELECT,
    }) as Promise<RunRowLike[]>,
    db.serpKeyword.groupBy({
      by: ["groupName"], where: { projectId: id, active: true }, _count: { _all: true },
    }) as Promise<{ groupName: string; _count: { _all: number } }[]>,
  ]);
  const { lastRun, series } = summarizeRuns(runs, volCount);
  return {
    id: p.id, name: p.name, engine: p.engine, device: p.device, country: p.country, lang: p.lang,
    depth: p.depth, intervalHours: p.intervalHours, paused: Boolean(p.paused),
    keywords: kwCount,
    lastRunAt: p.lastRunAt ? p.lastRunAt.toISOString() : null,
    nextRunAt: p.nextRunAt ? p.nextRunAt.toISOString() : null,
    lastRun, volatilitySeries: series,
    ownDomains: parseHostList(p.ownDomains ?? ""),
    ignoreHosts: parseHostList(p.ignoreHosts ?? ""),
    retentionDays: p.retentionDays,
    alertStorm: Boolean(p.alertStorm),
    groups: groups
      .map(g => ({ name: g.groupName, count: g._count._all }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    firstRunAt: p.firstRunAt ? p.firstRunAt.toISOString() : null,
  };
}

export async function createProject(userId: string, input: ProjectInput): Promise<{ project: ProjectDetail; import: KeywordImport & { added: number } }> {
  const data = validateProjectInput(input, false);
  const parsed = parseKeywordImport(input.keywords ?? "");
  if (parsed.rows.length > SERPMON_MAX_KEYWORDS) throw new InputError("too_many_keywords");

  const project = await db.serpProject.create({
    data: {
      userId,
      ...data,
      // The first scheduled check happens on the nearest tick, not a full interval away.
      nextRunAt: data.intervalHours! > 0 ? new Date() : null,
    },
    select: { id: true },
  }) as { id: string };

  let added = 0;
  for (const batch of chunk(parsed.rows)) {
    try {
      await db.serpKeyword.createMany({
        data: batch.map(r => ({ projectId: project.id, keyword: r.keyword, groupName: r.group })),
      });
      added += batch.length;
    } catch (e) {
      if (!isP2002(e)) throw e;
      // A fresh project cannot contain these keywords; a P2002 here means the same import
      // arrived twice concurrently. Insert what is still missing, one by one.
      for (const r of batch) {
        try {
          await db.serpKeyword.create({
            data: { projectId: project.id, keyword: r.keyword, groupName: r.group },
          });
          added++;
        } catch (dup) {
          if (!isP2002(dup)) throw dup;
        }
      }
    }
  }

  const detail = await getProject(userId, project.id);
  return {
    project: detail!,
    import: { rows: parsed.rows, skipped: parsed.skipped, duplicates: parsed.duplicates, added },
  };
}

export async function updateProject(userId: string, id: string, patch: Partial<ProjectInput>): Promise<ProjectDetail | null> {
  const existing = await ownedProject(userId, id);
  if (!existing) return null;
  // `keywords` is deliberately not a patch field — the list is edited through /keywords.
  const data = validateProjectInput(patch, true);
  if (Object.keys(data).length) {
    await db.serpProject.update({ where: { id }, data });
  }
  return getProject(userId, id);
}

export async function deleteProject(userId: string, id: string): Promise<boolean> {
  const res = await db.serpProject.deleteMany({ where: { id, userId } });
  return res.count > 0;
}

// ─── Keyword list ────────────────────────────────────────────────────────────

export async function addKeywords(
  userId: string, projectId: string, raw: string, mode: "add" | "replace",
): Promise<KeywordImport & { added: number; deactivated: number } | null> {
  const project = await ownedProject(userId, projectId);
  if (!project) return null;

  const parsed = parseKeywordImport(raw ?? "");
  const wanted = new Map(parsed.rows.map(r => [r.keyword, r.group]));
  const existing = await db.serpKeyword.findMany({
    where: { projectId }, select: { id: true, keyword: true, active: true, groupName: true },
  }) as { id: string; keyword: string; active: boolean; groupName: string }[];
  const byKeyword = new Map(existing.map(e => [e.keyword, e]));

  if (mode === "replace") {
    if (parsed.rows.length > SERPMON_MAX_KEYWORDS) throw new InputError("too_many_keywords");
  } else {
    const freshCount = parsed.rows.filter(r => !byKeyword.has(r.keyword)).length;
    if (existing.length + freshCount > SERPMON_MAX_KEYWORDS) throw new InputError("too_many_keywords");
  }

  let added = 0;
  for (const batch of chunk(parsed.rows.filter(r => !byKeyword.has(r.keyword)))) {
    try {
      await db.serpKeyword.createMany({
        data: batch.map(r => ({ projectId, keyword: r.keyword, groupName: r.group })),
      });
      added += batch.length;
    } catch (e) {
      if (!isP2002(e)) throw e;
      for (const r of batch) {
        try {
          await db.serpKeyword.create({ data: { projectId, keyword: r.keyword, groupName: r.group } });
          added++;
        } catch (dup) {
          if (!isP2002(dup)) throw dup;
        }
      }
    }
  }

  // Replace keeps history: keywords missing from the new list are deactivated, not deleted, and
  // their snapshots survive for the trend view. `deactivated` counts the rows this call flipped.
  let deactivated = 0;
  if (mode === "replace") {
    for (const batch of chunk(existing.filter(e => e.active && !wanted.has(e.keyword)).map(e => e.id))) {
      const res = await db.serpKeyword.updateMany({
        where: { id: { in: batch }, active: true }, data: { active: false },
      });
      deactivated += res.count;
    }
    for (const batch of chunk(existing.filter(e => !e.active && wanted.has(e.keyword)).map(e => e.id))) {
      await db.serpKeyword.updateMany({ where: { id: { in: batch } }, data: { active: true } });
    }
    for (const r of parsed.rows) {
      const e = byKeyword.get(r.keyword);
      if (e && e.groupName !== r.group) {
        await db.serpKeyword.update({ where: { id: e.id }, data: { groupName: r.group } });
      }
    }
  }

  return { rows: parsed.rows, skipped: parsed.skipped, duplicates: parsed.duplicates, added, deactivated };
}

export async function removeKeywords(userId: string, projectId: string, ids: string[]): Promise<number> {
  const project = await ownedProject(userId, projectId);
  if (!project) return 0;
  const clean = [...new Set(ids.filter(id => typeof id === "string" && id))];
  let removed = 0;
  for (const batch of chunk(clean)) {
    const res = await db.serpKeyword.deleteMany({ where: { projectId, id: { in: batch } } });
    removed += res.count;
  }
  return removed;
}

// ─── Runs ────────────────────────────────────────────────────────────────────

export async function listRuns(userId: string, projectId: string, limit: number): Promise<RunSummary[]> {
  const project = await ownedProject(userId, projectId);
  if (!project) return [];
  const [runs, volDoneTotal] = await Promise.all([
    db.serpRun.findMany({
      where: { projectId }, orderBy: { startedAt: "desc" }, take: clampInt(limit, 1, 200),
      select: RUN_SELECT,
    }) as Promise<RunRowLike[]>,
    db.serpRun.count({ where: { projectId, status: "done", volatility: { gt: 0 } } }),
  ]);
  // Newest first: the done-with-volatility runs already walked past are exactly the ones newer
  // than the current run, so one subtraction gives the baseline each run had beneath it.
  let seenVol = 0;
  return runs.map(r => {
    const isVol = r.status === "done" && (r.volatility ?? 0) > 0;
    const baseline = volDoneTotal - seenVol;
    if (isVol) seenVol += 1;
    return toRunSummary(r, baseline - (isVol ? 1 : 0) < STORM_MIN_BASELINE);
  });
}

// ─── Market table ────────────────────────────────────────────────────────────

const CHANGE_SORT_RANK: Record<string, number> = { enter: 0, up: 1, down: 1, exit: 2 };

/** Contract order: enter (by `to`), up/down (by |delta| desc), exit (by `from`). */
function changeComparator(a: { kind: string; from: number | null; to: number | null }, b: { kind: string; from: number | null; to: number | null }): number {
  const rank = (CHANGE_SORT_RANK[a.kind] ?? 9) - (CHANGE_SORT_RANK[b.kind] ?? 9);
  if (rank) return rank;
  if (a.kind === "enter") return (a.to ?? 0) - (b.to ?? 0);
  if (a.kind === "exit") return (a.from ?? 0) - (b.from ?? 0);
  return Math.abs((b.from ?? 0) - (b.to ?? 0)) - Math.abs((a.from ?? 0) - (a.to ?? 0));
}

/** Keyword ids of a project whose last snapshot contains the host — no LIKE over the JSON. */
async function keywordIdsHosting(projectId: string, needle: string): Promise<Set<string>> {
  const hosts = await db.serpHost.findMany({
    where: { host: { contains: needle.trim().toLowerCase() } },
    select: { id: true }, take: 400,
  }) as { id: number }[];
  const out = new Set<string>();
  if (!hosts.length) return out;
  const hostIds = hosts.map(h => h.id);
  const urlIdSet = new Set<number>();
  for (const batch of chunk(hostIds)) {
    const urls = await db.serpUrl.findMany({
      where: { hostId: { in: batch } }, select: { id: true }, take: 50_000,
    }) as { id: number }[];
    for (const u of urls) urlIdSet.add(u.id);
  }
  if (!urlIdSet.size) return out;
  const keywords = await db.serpKeyword.findMany({
    where: { projectId, active: true, lastSnapshotId: { not: null } },
    select: { id: true, lastSnapshotId: true },
  }) as { id: string; lastSnapshotId: string }[];
  for (const batch of chunk(keywords.map(k => k.lastSnapshotId))) {
    const snaps = await db.serpSnapshot.findMany({
      where: { id: { in: batch } }, select: { id: true, keywordId: true, rows: true },
    }) as { id: string; keywordId: string; rows: string }[];
    for (const s of snaps) {
      if (urlIdsFromRows(s.rows).some(urlId => urlIdSet.has(urlId))) out.add(s.keywordId);
    }
  }
  return out;
}

export async function marketRows(
  userId: string, projectId: string, q: MarketQuery,
): Promise<{ rows: MarketRow[]; total: number; all: number } | null> {
  const project = await ownedProject(userId, projectId);
  if (!project) return null;
  const all = await db.serpKeyword.count({ where: { projectId, active: true } });

  const kwWhere: Record<string, unknown> = { projectId, active: true };
  if (q.q?.trim()) kwWhere.keyword = { contains: q.q.trim().toLowerCase() };
  if (q.group) kwWhere.groupName = q.group;
  if (q.changedOnly) kwWhere.lastChangeCount = { gt: 0 };

  const page = Math.max(q.page ?? 1, 1);
  const pageSize = clampInt(q.pageSize ?? 50, 1, 200);
  const sort = q.sort ?? "keyword";
  const orderBy = sort === "volatility"
    ? [{ lastVolatility: "desc" as const }, { keyword: "asc" as const }]
    : sort === "changes"
      ? [{ lastChangeCount: "desc" as const }, { keyword: "asc" as const }]
      : { keyword: "asc" as const };

  let pageKeywords: Record<string, DbRow>[];
  let total: number;
  if (q.host?.trim()) {
    // Host filter cannot be a WHERE on the keyword: the host lives inside the snapshot JSON. All
    // matching keywords are fetched and the page is cut in memory — the table caps at 5 000.
    const hosting = await keywordIdsHosting(projectId, q.host);
    const matches = hosting.size
      ? (await db.serpKeyword.findMany({ where: kwWhere, orderBy: { keyword: "asc" } }) as Record<string, DbRow>[])
          .filter(k => hosting.has(k.id))
      : [];
    total = matches.length;
    const sorted = [...matches];
    if (sort !== "keyword") {
      sorted.sort((a, b) =>
        sort === "volatility"
          ? (b.lastVolatility ?? -1) - (a.lastVolatility ?? -1) || a.keyword.localeCompare(b.keyword)
          : (b.lastChangeCount ?? 0) - (a.lastChangeCount ?? 0) || a.keyword.localeCompare(b.keyword));
    }
    pageKeywords = sorted.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
  } else {
    total = await db.serpKeyword.count({ where: kwWhere });
    pageKeywords = await db.serpKeyword.findMany({
      where: kwWhere, orderBy, take: pageSize, skip: (page - 1) * pageSize,
    }) as Record<string, DbRow>[];
  }

  const ownList = parseHostList(project.ownDomains ?? "");
  const snapById = new Map<string, { rows: string }>();
  const lastSnapIds = pageKeywords.map(k => k.lastSnapshotId).filter((x: string | null): x is string => Boolean(x));
  for (const batch of chunk(lastSnapIds)) {
    const snaps = await db.serpSnapshot.findMany({
      where: { id: { in: batch } }, select: { id: true, rows: true },
    }) as { id: string; rows: string }[];
    for (const s of snaps) snapById.set(s.id, s);
  }

  const maps = await loadUrlHostMaps(
    [...snapById.values()].flatMap(s => urlIdsFromRows(s.rows)),
  );

  const changesBySnapshot = new Map<string, { hostId: number; kind: string; fromPos: number | null; toPos: number | null; urls: number; hidden: boolean }[]>();
  if (lastSnapIds.length) {
    const changes = await db.serpChange.findMany({
      where: { snapshotId: { in: lastSnapIds } },
      select: { snapshotId: true, hostId: true, kind: true, fromPos: true, toPos: true, urls: true, hidden: true },
    }) as { snapshotId: string; hostId: number; kind: string; fromPos: number | null; toPos: number | null; urls: number; hidden: boolean }[];
    for (const c of changes) {
      if (!changesBySnapshot.has(c.snapshotId)) changesBySnapshot.set(c.snapshotId, []);
      changesBySnapshot.get(c.snapshotId)!.push(c);
    }
  }

  const rows: MarketRow[] = pageKeywords.map(k => {
    const snap = k.lastSnapshotId ? snapById.get(k.lastSnapshotId) : undefined;
    const serpRows = snap ? expandRowsJson(snap.rows, maps) : [];

    const leaders: string[] = [];
    for (const r of serpRows) {
      if (!leaders.includes(r.host)) leaders.push(r.host);
      if (leaders.length === 3) break;
    }

    const changes = (changesBySnapshot.get(k.lastSnapshotId ?? "") ?? [])
      .map(c => ({
        host: maps.hostById.get(c.hostId) ?? "",
        kind: c.kind as MarketRow["changes"][number]["kind"],
        from: c.fromPos, to: c.toPos, urls: c.urls, hidden: c.hidden,
      }))
      .sort(changeComparator);

    let own: MarketRow["own"] = null;
    if (ownList.length) {
      for (const r of serpRows) {
        if (!hostMatches(r.host, ownList)) continue;
        if (!own || r.position < own.position) own = { host: r.host, position: r.position };
      }
    }

    return {
      keywordId: k.id,
      keyword: k.keyword,
      group: k.groupName ?? "",
      status: (k.lastStatus ?? "") as MarketRow["status"],
      problem: k.lastProblem ?? null,
      detail: k.lastDetail ?? null,
      lastOkAt: k.lastOkAt ? k.lastOkAt.toISOString() : null,
      leaders,
      changes,
      volatility: k.lastVolatility ?? null,
      own,
    };
  });

  return { rows, total, all };
}

// ─── Keyword history ─────────────────────────────────────────────────────────

export async function keywordHistory(userId: string, keywordId: string, limit: number): Promise<KeywordHistory | null> {
  const kw = await db.serpKeyword.findUnique({
    where: { id: keywordId },
    select: { project: { select: { userId: true } } },
  }) as { project: { userId: string } } | null;
  if (!kw || kw.project.userId !== userId) return null;

  const snapshots = await db.serpSnapshot.findMany({
    where: { keywordId },
    orderBy: { takenAt: "desc" },
    take: clampInt(limit, 1, 100),
    select: {
      id: true, takenAt: true, status: true, problem: true, detail: true, depth: true, got: true,
      volatility: true, changeCount: true, rows: true,
    },
  }) as Record<string, DbRow>[];
  snapshots.reverse(); // oldest first, so series read left → right

  const maps = await loadUrlHostMaps(snapshots.flatMap(s => urlIdsFromRows(s.rows)));

  // The ≤ 10 hosts with the most presence across these snapshots, each with a position series
  // aligned to the snapshot list; null = absent from that snapshot.
  const presence = new Map<string, { count: number; positions: (number | null)[] }>();
  snapshots.forEach((s, index) => {
    const best = new Map<string, number>();
    for (const row of expandRowsJson(s.rows, maps)) {
      const prev = best.get(row.host);
      if (prev === undefined || row.position < prev) best.set(row.host, row.position);
    }
    for (const [host, pos] of best) {
      if (!presence.has(host)) presence.set(host, { count: 0, positions: snapshots.map(() => null) });
      const entry = presence.get(host)!;
      entry.count++;
      entry.positions[index] = pos;
    }
  });

  return {
    snapshots: snapshots.map(s => ({
      id: s.id,
      takenAt: s.takenAt.toISOString(),
      status: s.status as SnapshotStatus,
      problem: s.problem ?? null,
      detail: s.detail ?? null,
      depth: s.depth,
      got: s.got,
      volatility: s.volatility ?? null,
      changeCount: s.changeCount ?? 0,
    })),
    hosts: [...presence.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([host, entry]) => ({ host, series: entry.positions })),
  };
}

// ─── Snapshot view ───────────────────────────────────────────────────────────

export async function snapshotView(userId: string, snapshotId: string, compareId?: string): Promise<SnapshotView | null> {
  const snap = await db.serpSnapshot.findUnique({
    where: { id: snapshotId },
    select: {
      id: true, takenAt: true, status: true, problem: true, depth: true, got: true, rows: true,
      prevId: true, keywordId: true,
      keyword: { select: { project: { select: { userId: true, ignoreHosts: true } } } },
    },
  }) as Record<string, DbRow> | null;
  if (!snap || snap.keyword.project.userId !== userId) return null;

  const maps = await loadUrlHostMaps(urlIdsFromRows(snap.rows));
  const rows = expandRowsJson(snap.rows, maps);

  // Explicit compare target when it belongs to the same keyword, else the snapshot's own prevId.
  let targetId = snap.prevId as string | null;
  if (compareId && compareId !== snapshotId) {
    const probe = await db.serpSnapshot.findUnique({
      where: { id: compareId }, select: { id: true, keywordId: true },
    }) as { id: string; keywordId: string } | null;
    if (probe && probe.keywordId === snap.keywordId) targetId = probe.id;
  }

  let compare: SnapshotView["compare"] = null;
  if (targetId) {
    const prev = await db.serpSnapshot.findUnique({
      where: { id: targetId },
      select: { id: true, takenAt: true, rows: true, status: true, got: true },
    }) as Record<string, DbRow> | null;
    if (prev) {
      const prevMaps = await loadUrlHostMaps(urlIdsFromRows(prev.rows));
      const prevRows = expandRowsJson(prev.rows, prevMaps);
      const depth = comparableDepth(
        { status: prev.status as SnapshotStatus, got: prev.got },
        { status: snap.status as SnapshotStatus, got: snap.got },
      );
      const diff = diffKeyword(prevRows, rows, {
        depth,
        ignore: ignorePredicateFor(snap.keyword.project.ignoreHosts ?? ""),
      });
      compare = { id: prev.id, takenAt: prev.takenAt.toISOString(), rows: prevRows, diff };
    }
  }

  return {
    id: snap.id,
    takenAt: snap.takenAt.toISOString(),
    status: snap.status as SnapshotStatus,
    problem: snap.problem ?? null,
    depth: snap.depth,
    got: snap.got,
    rows,
    compare,
  };
}

function ignorePredicateFor(ignoreHostsRaw: string): (host: string) => boolean {
  return ignorePredicate(parseHostList(ignoreHostsRaw));
}

// ─── Retention (§6) ──────────────────────────────────────────────────────────

/** ISO-8601 week key ("2026-W37") — the retention unit: one full snapshot per week per keyword. */
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // Monday = 0
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // this week's Thursday
  const isoYear = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week1Thu = new Date(jan4);
  week1Thu.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((t.getTime() - week1Thu.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${week}`;
}

/**
 * Thin full snapshots older than `retentionDays` to the first of each ISO week per keyword,
 * cascading their SerpChange rows. Bounded: reads the oldest 3 000 candidates and deletes at
 * most 2 000 per call — the next run's call drains the rest. lastSnapshotId is never deleted,
 * and a protected snapshot anchors its week so the week keeps exactly one full snapshot.
 */
export async function pruneProjectSnapshots(projectId: string, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const protectedRows = await db.serpKeyword.findMany({
    where: { projectId, lastSnapshotId: { not: null } },
    select: { lastSnapshotId: true },
  }) as { lastSnapshotId: string }[];
  const protect = new Set(protectedRows.map(r => r.lastSnapshotId));

  const candidates = await db.serpSnapshot.findMany({
    where: { projectId, takenAt: { lt: cutoff } },
    orderBy: { takenAt: "asc" },
    take: 3000,
    select: { id: true, keywordId: true, takenAt: true },
  }) as { id: string; keywordId: string; takenAt: Date }[];

  const seenWeek = new Set<string>();
  const doomed: string[] = [];
  for (const s of candidates) {
    if (protect.has(s.id)) continue;
    const key = `${s.keywordId}|${isoWeekKey(s.takenAt)}`;
    if (!seenWeek.has(key)) {
      seenWeek.add(key);
      continue;
    }
    doomed.push(s.id);
    if (doomed.length >= 2000) break;
  }

  let deleted = 0;
  for (const batch of chunk(doomed)) {
    const res = await db.serpSnapshot.deleteMany({ where: { id: { in: batch } } });
    deleted += res.count;
  }
  return deleted;
}
