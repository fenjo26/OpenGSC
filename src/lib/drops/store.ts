// The only module in src/lib/drops that talks to the database. Everything else stays pure so it
// can be tested without one; the interesting decisions here are about volume, not about logic.

import { prisma } from "@/lib/prisma";
import { parseDomainList, summariseSkips } from "./ingest";
import { tldOf } from "./registries";
import type { DropSource, DropStage } from "./types";
import { WATCH_STAGES, nextWatchCheckMin, watchAcceleration } from "./watch";

/**
 * Rows per statement.
 *
 * 400, not "as many as fit". SQLite has a hard ceiling on bound parameters per statement (999 on
 * builds older than 3.32), and an `IN (...)` list of domains is one parameter each. A chunk that
 * works on the developer's machine and fails on a user's older SQLite is the kind of bug that
 * only ever appears in someone else's logs.
 */
const CHUNK = 400;

/**
 * The three drop models are reached through an untyped accessor, the way `siteScan`,
 * `seoJob`, `geoAudit` and a dozen others already are in this codebase.
 *
 * The reason is the same one: the generated client only learns about a model after
 * `prisma db push` runs, and this app pushes at container start rather than at build time.
 * Typing against a client that may predate the schema would make every instance that has not
 * restarted yet fail to compile.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema
const db = prisma as any;

/**
 * True when the failure is "this table does not exist" rather than a real error — an instance
 * that pulled the code but has not restarted yet. Routes turn this into `notMigrated: true`
 * so the page can say "run prisma db push" instead of showing a 500.
 */
export function schemaMissing(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" ||
    /Drop(?:Run|Candidate|Event).*(?:does not exist|no such table)/i.test(String(value?.message ?? ""))
  );
}

export interface CreateRunInput {
  label?: string | null;
  source: DropSource;
  sourceRef?: string | null;
  /** Raw pasted text or CSV. Normalisation and rejection happen here, not in the route. */
  raw: string;
}

export interface CreateRunResult {
  runId: string;
  accepted: number;
  inserted: number;
  reattached: number;
  skipped: number;
  skipReport: Record<string, number>;
}

/**
 * Ingest a list into a new run.
 *
 * Candidates are unique per (userId, domain), so a domain that arrives again from a second source
 * is not a second row — it is re-pointed at the newer run and keeps every check, metric and event
 * it already has. Losing that history because the same name showed up in another CSV would be a
 * silent and expensive kind of wrong.
 */
export async function createRun(userId: string, input: CreateRunInput): Promise<CreateRunResult> {
  const parsed = parseDomainList(input.raw);
  const skipReport = summariseSkips(parsed.skipped);

  const run = await db.dropRun.create({
    data: {
      userId,
      label: input.label?.trim() || null,
      source: input.source,
      sourceRef: input.sourceRef?.trim() || null,
      total: parsed.domains.length,
      skipped: parsed.skipped.length,
      skipReport: JSON.stringify(skipReport),
    },
    select: { id: true },
  });

  let inserted = 0;
  let reattached = 0;

  for (let i = 0; i < parsed.domains.length; i += CHUNK) {
    const chunk = parsed.domains.slice(i, i + CHUNK);

    // `createMany({ skipDuplicates })` is not available on SQLite, and this app ships SQLite by
    // default — so the duplicates are found first and handled explicitly instead.
    const existing = (await db.dropCandidate.findMany({
      where: { userId, domain: { in: chunk } },
      select: { id: true, domain: true },
    })) as { id: string; domain: string }[];
    const existingByDomain = new Map(existing.map(e => [e.domain, e.id]));

    const fresh = chunk
      .filter(d => !existingByDomain.has(d))
      .map(domain => ({ userId, runId: run.id, domain, tld: tldOf(domain) as string }));

    if (fresh.length) {
      await db.dropCandidate.createMany({ data: fresh });
      inserted += fresh.length;
    }
    if (existing.length) {
      await db.dropCandidate.updateMany({
        where: { id: { in: existing.map(e => e.id) } },
        data: { runId: run.id },
      });
      reattached += existing.length;
    }
  }

  await db.dropRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date() },
  });

  return {
    runId: run.id,
    accepted: parsed.domains.length,
    inserted,
    reattached,
    skipped: parsed.skipped.length,
    skipReport,
  };
}

export async function listRuns(userId: string, limit = 50) {
  return db.dropRun.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
  });
}

/**
 * Columns the table may sort by. Kept as a union rather than a free string because each entry
 * maps to a real column — the route whitelists with this list, so a crafted `orderBy` cannot
 * reach the query.
 */
export type CandidateSortField =
  | "score" | "createdAt" | "domain" | "dr" | "refdomains" | "snapshots" | "checkedAt";

/** The column behind a sort field. `refdomains` sorts by the dofollow count the score uses. */
const SORT_COLUMNS: Record<CandidateSortField, string> = {
  score: "score",
  createdAt: "createdAt",
  domain: "domain",
  dr: "dr",
  refdomains: "refdomainsDofollow",
  snapshots: "waybackSnapshots",
  checkedAt: "lastCheckedAt",
};

export interface CandidateFilter {
  runId?: string;
  stage?: DropStage;
  tld?: string;
  source?: DropSource;
  /** Substring match on the domain, for the search box. */
  q?: string;
  minScore?: number;
  starred?: boolean;
  /** Only rows the watch loop is polling (see scheduler.ts). */
  watched?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: CandidateSortField;
  orderDir?: "asc" | "desc";
}

/**
 * The where behind every catalogue query — the list, the "По фильтру" count, and the bulk
 * operations ("выбрать все по фильтру" then удалить). One builder, so a filter can never mean
 * one set of rows in the table and a different set in the bulk action that came after it.
 */
function buildCandidateWhere(userId: string, f: CandidateFilter = {}): Record<string, unknown> {
  const where: Record<string, unknown> = { userId };
  if (f.runId) where.runId = f.runId;
  if (f.stage) where.stage = f.stage;
  if (f.tld) where.tld = f.tld;
  if (f.starred !== undefined) where.starred = f.starred;
  if (f.watched !== undefined) where.watched = f.watched;
  if (typeof f.minScore === "number") where.score = { gte: f.minScore };
  // `contains` without `mode: "insensitive"`: that option is Postgres-only, and domains are
  // stored lower-cased on the way in, so folding the needle is enough and works on both engines.
  if (f.q?.trim()) where.domain = { contains: f.q.trim().toLowerCase() };
  if (f.source) where.run = { source: f.source };
  return where;
}

/**
 * A page of the catalogue plus the total behind the current filter.
 *
 * The count is what the UI shows as "По фильтру: 1 910 доменов", and it is a separate query on
 * purpose — `take`/`skip` cannot produce it, and loading 50 000 rows to length them would defeat
 * the pagination.
 */
export async function listCandidates(userId: string, f: CandidateFilter = {}) {
  const where = buildCandidateWhere(userId, f);

  const take = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const skip = Math.max(f.offset ?? 0, 0);
  const column = SORT_COLUMNS[f.orderBy ?? "score"];
  const dir = f.orderDir === "asc" ? "asc" as const : "desc" as const;
  // Both SQLite and MySQL order NULL lowest, so asc puts unscored rows on top and desc sinks
  // them — consistent across engines without dialect-specific null clauses. Score-descending
  // (the default) additionally carries a stable second key so equal scores keep a fixed order.
  const orderBy = column === "score" && dir === "desc"
    ? [{ score: "desc" as const }, { createdAt: "desc" as const }]
    : { [column]: dir };

  const [rows, total] = await Promise.all([
    db.dropCandidate.findMany({ where, orderBy, take, skip }),
    db.dropCandidate.count({ where }),
  ]);

  return { rows, total, limit: take, offset: skip };
}

/** Per-stage counts for the funnel widget. One grouped query, not one query per stage. */
export async function stageCounts(userId: string, runId?: string) {
  const grouped = (await db.dropCandidate.groupBy({
    by: ["stage"],
    where: runId ? { userId, runId } : { userId },
    _count: { _all: true },
  })) as { stage: string; _count: { _all: number } }[];
  const out: Record<string, number> = {};
  for (const g of grouped) out[g.stage] = g._count._all;
  return out;
}

/**
 * Candidates still waiting on their DNS lookup, oldest first.
 *
 * `ingested` only. A row that already carries a DNS verdict is never re-asked here: the point of
 * the stage is to run once per candidate and retire nine in ten of them, and re-resolving a list
 * that has already been filtered is pure cost with no new information.
 */
export async function pendingDnsCandidates(
  userId: string,
  opts: { runId?: string; limit?: number } = {},
): Promise<string[]> {
  const rows = (await db.dropCandidate.findMany({
    where: { userId, stage: "ingested" satisfies DropStage, ...(opts.runId ? { runId: opts.runId } : {}) },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(opts.limit ?? 200, 1), 1000),
    select: { domain: true },
  })) as { domain: string }[];
  return rows.map(r => r.domain);
}

/** How many are still waiting. Drives the progress line and tells the UI when to stop looping. */
export async function countPendingDns(userId: string, runId?: string): Promise<number> {
  return db.dropCandidate.count({
    where: { userId, stage: "ingested" satisfies DropStage, ...(runId ? { runId } : {}) },
  });
}

/**
 * Candidates ready for the availability stage: DNS found no delegation, so the registry is the
 * only thing left that can answer. `checking` is included so a batch interrupted mid-flight is
 * picked up again instead of stranding rows.
 */
export async function pendingAvailabilityCandidates(
  userId: string,
  opts: { runId?: string; limit?: number; domains?: string[] } = {},
): Promise<string[]> {
  const rows = (await db.dropCandidate.findMany({
    where: {
      userId,
      stage: { in: ["dns_checked", "checking"] as DropStage[] },
      ...(opts.runId ? { runId: opts.runId } : {}),
      // A bulk "проверить выбранных" narrows the queue to the named rows; rows outside the
      // selection — including ones already backed off — are nobody's business this round.
      ...(opts.domains?.length ? { domain: { in: opts.domains } } : {}),
      // Rows the registry refused earlier wait for their backoff to expire; without this a
      // throttled zone would be retried on every pass and never recover.
      OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(opts.limit ?? 40, 1), 200),
    select: { domain: true },
  })) as { domain: string }[];
  return rows.map(r => r.domain);
}

export async function countPendingAvailability(userId: string, runId?: string): Promise<number> {
  return db.dropCandidate.count({
    where: {
      userId,
      stage: { in: ["dns_checked", "checking"] as DropStage[] },
      ...(runId ? { runId } : {}),
      OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }],
    },
  });
}

/**
 * Candidates that still carry no DR, oldest first, optionally scoped to one run.
 *
 * The free DR endpoint answers one domain per request, so a row that already has a rating is
 * never asked again — the post-import sweep drains this queue until it stops shrinking, and the
 * names the endpoint cannot rate (never-indexed domains) are exactly what makes it stop instead
 * of looping.
 */
export async function pendingDrCandidates(
  userId: string,
  opts: { runId?: string; limit?: number } = {},
): Promise<string[]> {
  const rows = (await db.dropCandidate.findMany({
    where: { userId, dr: null, ...(opts.runId ? { runId: opts.runId } : {}) },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(opts.limit ?? 60, 1), 250),
    select: { domain: true },
  })) as { domain: string }[];
  return rows.map(r => r.domain);
}

/** How many still lack a DR — the sweep's progress line and its no-progress stop condition. */
export async function countPendingDr(userId: string, runId?: string): Promise<number> {
  return db.dropCandidate.count({
    where: { userId, dr: null, ...(runId ? { runId } : {}) },
  });
}

/** Backoff after a refusal, in minutes: 6h → 12h → 24h, then held at 24h. */
const REFUSAL_BACKOFF_MIN = [6 * 60, 12 * 60, 24 * 60, 24 * 60];

/**
 * Write a batch of registry verdicts back, one row at a time.
 *
 * Not a `updateMany` per outcome, because every row carries its own expiry, statuses and
 * nameservers. The loop is fine at this stage's volume: a batch is tens of rows, not thousands,
 * since each one costs a throttled registry call to produce.
 *
 * A rate-limited or errored row keeps its stage and gets `nextCheckAt` pushed out. It is
 * deliberately NOT recorded as "taken": the registry declined to answer, and a decision the
 * registry did not make must never end up in the catalogue as one.
 */
export async function recordAvailabilityResults(
  userId: string,
  results: Map<string, import("./types").AvailabilityResult>,
): Promise<{ available: number; taken: number; deferred: number; decided: number }> {
  let available = 0, taken = 0, deferred = 0;

  for (const [domain, res] of results) {
    const now = new Date();
    if (res.ok && res.status === "registered") {
      taken++;
      await db.dropCandidate.updateMany({
        where: { userId, domain },
        data: {
          stage: "taken" satisfies DropStage,
          lastStatus: "registered", lastHttp: res.http, lastVia: res.via, lastError: null,
          consecutiveErrors: 0, corroborated: false, lastCheckedAt: now, nextCheckAt: null,
          registryExpiresAt: res.expiresAt ?? null,
          registryCreatedAt: res.createdAt ?? null,
          registryStatus: res.registryStatus?.join(",") || null,
          nameServers: res.nameServers?.length ? JSON.stringify(res.nameServers) : null,
        },
      });
    } else if (res.ok && res.status === "available") {
      available++;
      await db.dropCandidate.updateMany({
        where: { userId, domain },
        data: {
          stage: "available" satisfies DropStage,
          lastStatus: "available", lastHttp: res.http, lastVia: res.via, lastError: null,
          consecutiveErrors: 0, corroborated: res.corroborated, lastCheckedAt: now, nextCheckAt: null,
        },
      });
      await addEventByDomain(userId, domain, "available",
        res.corroborated
          ? `${domain} is free (confirmed by two sources)`
          : `${domain} looks free via ${res.via} only — not corroborated`);
    } else {
      deferred++;
      const existing = (await db.dropCandidate.findFirst({
        where: { userId, domain },
        select: { id: true, consecutiveErrors: true },
      })) as { id: string; consecutiveErrors: number } | null;
      const step = Math.min((existing?.consecutiveErrors ?? 0) + 1, REFUSAL_BACKOFF_MIN.length);
      const waitMin = REFUSAL_BACKOFF_MIN[step - 1];
      await db.dropCandidate.updateMany({
        where: { userId, domain },
        data: {
          stage: "dns_checked" satisfies DropStage,
          lastStatus: res.status,
          lastHttp: res.status === "rate_limited" ? 429 : res.http,
          lastError: res.status === "error" ? res.error : "rate_limited",
          consecutiveErrors: step,
          lastCheckedAt: now,
          nextCheckAt: new Date(Date.now() + waitMin * 60_000),
        },
      });
    }
  }

  return { available, taken, deferred, decided: available + taken };
}

/** Trail entry addressed by domain rather than id, for the batch writers above. */
async function addEventByDomain(userId: string, domain: string, type: string, message: string): Promise<void> {
  try {
    const row = (await db.dropCandidate.findFirst({ where: { userId, domain }, select: { id: true } })) as { id: string } | null;
    if (row) await addEvent(row.id, type, message);
  } catch {
    // Intentionally swallowed — see addEvent.
  }
}

/** Append to the trail. Never throws into the caller — a lost log line must not fail a check. */
export async function addEvent(candidateId: string, type: string, message: string): Promise<void> {
  try {
    await db.dropEvent.create({ data: { candidateId, type, message: message.slice(0, 1000) } });
  } catch {
    // Intentionally swallowed.
  }
}

/**
 * Write back a batch of DNS results.
 *
 * Delegated names are retired here (`resolved_taken`) and never reach the registry stage — that
 * retirement is the entire economic argument for the module. Everything else moves to
 * `dns_checked` and stays in the queue, including the lookups that failed: a resolver timeout is
 * not evidence, and treating it as one silently shrinks every list.
 */
export async function recordDnsResults(
  userId: string,
  results: { domain: string; hasRecords: boolean; nameServers: string[] }[],
): Promise<{ retired: number; advanced: number }> {
  const delegated = results.filter(r => r.hasRecords).map(r => r.domain);
  const rest = results.filter(r => !r.hasRecords).map(r => r.domain);
  let retired = 0;
  let advanced = 0;

  for (let i = 0; i < delegated.length; i += CHUNK) {
    const res = await db.dropCandidate.updateMany({
      where: { userId, domain: { in: delegated.slice(i, i + CHUNK) } },
      data: { stage: "resolved_taken" satisfies DropStage, dnsHasRecords: true, lastCheckedAt: new Date() },
    });
    retired += res.count;
  }
  for (let i = 0; i < rest.length; i += CHUNK) {
    const res = await db.dropCandidate.updateMany({
      where: { userId, domain: { in: rest.slice(i, i + CHUNK) } },
      data: { stage: "dns_checked" satisfies DropStage, dnsHasRecords: false, lastCheckedAt: new Date() },
    });
    advanced += res.count;
  }

  return { retired, advanced };
}

/**
 * Rows whose zone has no registry that can answer (`.gr` today).
 *
 * They are not errored into a backoff the user cannot see — they get a named marker, a trail
 * entry saying exactly what is missing, and a week off. The week, not the 6h refusal ladder,
 * because nothing will have changed about the zone by tonight: without a registrar API these
 * rows are not checkable, and re-learning that every six hours is pure cost. If a registrar
 * integration ever arrives, clearing `lastError` puts them back in the queue.
 */
export async function markUncheckableZones(userId: string, domains: string[]): Promise<number> {
  if (!domains.length) return 0;
  let touched = 0;
  for (const domain of domains) {
    const res = await db.dropCandidate.updateMany({
      where: { userId, domain, stage: { in: ["dns_checked", "checking"] as DropStage[] } },
      data: {
        lastStatus: "error",
        lastError: "zone_uncheckable",
        lastCheckedAt: new Date(),
        nextCheckAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    });
    touched += res.count;
    if (res.count) await addEventByDomain(userId, domain, "info",
      "zone has no working RDAP or WHOIS — registry check needs a registrar API");
  }
  return touched;
}

/**
 * Bulk delete. `ids` covers the checked rows; `filter` alone covers "выбрать все по фильтру" —
 * the same builder the table reads with, so what the user saw selected is exactly what goes.
 * Events cascade away with their candidates by schema design.
 */
export async function deleteCandidates(
  userId: string,
  scope: { ids?: string[]; filter?: CandidateFilter },
): Promise<number> {
  if (scope.ids?.length) {
    let deleted = 0;
    for (let i = 0; i < scope.ids.length; i += CHUNK) {
      const res = await db.dropCandidate.deleteMany({
        where: { userId, id: { in: scope.ids.slice(i, i + CHUNK) } },
      });
      deleted += res.count;
    }
    return deleted;
  }
  if (scope.filter) {
    const res = await db.dropCandidate.deleteMany({ where: buildCandidateWhere(userId, scope.filter) });
    return res.count;
  }
  return 0;
}

/** Bulk star / unstar over a row selection or a whole filter. */
export async function setStarred(
  userId: string,
  scope: { ids?: string[]; filter?: CandidateFilter },
  starred: boolean,
): Promise<number> {
  const data = { starred };
  if (scope.ids?.length) {
    let touched = 0;
    for (let i = 0; i < scope.ids.length; i += CHUNK) {
      const res = await db.dropCandidate.updateMany({
        where: { userId, id: { in: scope.ids.slice(i, i + CHUNK) } }, data,
      });
      touched += res.count;
    }
    return touched;
  }
  if (scope.filter) {
    const res = await db.dropCandidate.updateMany({ where: buildCandidateWhere(userId, scope.filter), data });
    return res.count;
  }
  return 0;
}

export interface MetricsUpdate {
  domain: string;
  dr?: number | null;
  refdomains?: number | null;
  /** Total live backlinks, when the source reports them. */
  backlinks?: number | null;
}

/**
 * Persist enrichment numbers (DR from the free endpoint, refdomains/backlinks from the paid
 * metrics call) onto candidates. The numbers are computed elsewhere and arrive ready; this only
 * decides what a missing value means — `undefined` leaves the column alone, `null` would clear
 * it, and the callers never send `null`: a check that failed says nothing and overwrites less.
 */
export async function writeMetricsUpdates(userId: string, entries: MetricsUpdate[]): Promise<number> {
  let touched = 0;
  for (const e of entries) {
    const data: Record<string, unknown> = { metricsAt: new Date() };
    if (e.dr != null) data.dr = e.dr;
    if (e.refdomains != null) data.refdomains = e.refdomains;
    if (e.backlinks != null) data.liveBacklinks = e.backlinks;
    const res = await db.dropCandidate.updateMany({
      where: { userId, domain: e.domain },
      data,
    });
    touched += res.count;
    if (res.count) await recomputeScore(userId, e.domain);
  }
  return touched;
}

export interface WaybackUpdate {
  domain: string;
  snapshots: number;
  firstAt: Date | null;
  lastAt: Date | null;
  gapDays: number | null;
}

/** Persist a Wayback CDX pass. `historyAt` stamps the run so the UI can show staleness. */
export async function writeWaybackResults(userId: string, results: WaybackUpdate[]): Promise<number> {
  let touched = 0;
  for (const r of results) {
    const res = await db.dropCandidate.updateMany({
      where: { userId, domain: r.domain },
      data: {
        waybackSnapshots: r.snapshots,
        waybackFirstAt: r.firstAt,
        waybackLastAt: r.lastAt,
        waybackGapDays: r.gapDays,
        historyAt: new Date(),
      },
    });
    touched += res.count;
    if (res.count) await recomputeScore(userId, r.domain);
  }
  return touched;
}

/**
 * Recompute one candidate's score from the columns enrichment has filled so far.
 *
 * Called after every write that can change the inputs (metrics, wayback, history verdict), so
 * the "Скор" column comes alive progressively instead of waiting for a phase that computes
 * everything at once. The detailed breakdown is not persisted — the number is, and the pure
 * module behind it can always explain any row.
 */
export async function recomputeScore(userId: string, domain: string): Promise<void> {
  const row = (await db.dropCandidate.findFirst({
    where: { userId, domain },
    select: {
      dr: true, refdomains: true, refdomainsDofollow: true,
      waybackSnapshots: true, waybackGapDays: true, historyVerdict: true,
    },
  })) as {
    dr: number | null; refdomains: number | null; refdomainsDofollow: number | null;
    waybackSnapshots: number | null; waybackGapDays: number | null; historyVerdict: string | null;
  } | null;
  if (!row) return;
  const { scoreCandidate } = await import("./score");
  const score = scoreCandidate({
    dr: row.dr,
    refdomains: row.refdomains,
    refdomainsDofollow: row.refdomainsDofollow,
    waybackSnapshots: row.waybackSnapshots,
    waybackGapDays: row.waybackGapDays,
    historyVerdict: (row.historyVerdict as import("./types").HistoryVerdict | null) ?? undefined,
  });
  await db.dropCandidate.updateMany({ where: { userId, domain }, data: { score } });
}

/** Persist the AI history pass. The note is human-readable, the verdict drives score and veto. */
export async function setHistoryVerdict(
  userId: string,
  domain: string,
  verdict: import("./types").HistoryVerdict,
  note: string,
): Promise<void> {
  await db.dropCandidate.updateMany({
    where: { userId, domain },
    data: { historyVerdict: verdict, historyNote: note.slice(0, 1000), historyAt: new Date() },
  });
  await recomputeScore(userId, domain);
}

/**
 * Watch / unwatch rows. Turning a watch ON makes the row due immediately — the user asked to be
 * told when it drops, and "in up to one day" is a worse answer than "on the next scheduler tick".
 */
export async function setWatched(
  userId: string,
  scope: { ids?: string[]; filter?: CandidateFilter },
  watched: boolean,
): Promise<number> {
  const data: Record<string, unknown> = watched ? { watched, nextCheckAt: new Date() } : { watched };
  if (scope.ids?.length) {
    let touched = 0;
    for (let i = 0; i < scope.ids.length; i += CHUNK) {
      const res = await db.dropCandidate.updateMany({
        where: { userId, id: { in: scope.ids.slice(i, i + CHUNK) } }, data,
      });
      touched += res.count;
    }
    return touched;
  }
  if (scope.filter) {
    const res = await db.dropCandidate.updateMany({ where: buildCandidateWhere(userId, scope.filter), data });
    return res.count;
  }
  return 0;
}

/** How many rows the watch loop is currently polling. */
export async function countWatched(userId: string): Promise<number> {
  return db.dropCandidate.count({ where: { userId, watched: true } });
}

/**
 * Watch / unwatch by domain names, scoped to the caller — the surface the MCP tool speaks
 * (agents name domains, not row ids). Unknown names are silently absent, the way list filters
 * treat them; the return is how many of the caller's rows actually changed.
 */
export async function setWatchedByDomains(
  userId: string,
  domains: string[],
  watched: boolean,
): Promise<number> {
  if (!domains.length) return 0;
  const rows = (await db.dropCandidate.findMany({
    where: { userId, domain: { in: domains } },
    select: { id: true },
  })) as { id: string }[];
  if (!rows.length) return 0;
  return setWatched(userId, { ids: rows.map(r => r.id) }, watched);
}

/**
 * Watched rows the registry owes an answer about, oldest due first, across all users — the
 * scheduler is a background process with no signed-in user, and rows carry their owner so every
 * write below stays scoped to that owner (a domain is unique per (userId, domain), not globally).
 *
 * Rows already known free (`available`) are never returned: a free name ended its watch. The
 * backoff columns are shared with the manual check route, so a registry refusal pushes a watched
 * row out exactly as far as it pushes a funnel row.
 */
export async function dueWatchedRows(limit = 60): Promise<WatchRow[]> {
  return db.dropCandidate.findMany({
    where: {
      watched: true,
      stage: { in: WATCH_STAGES as unknown as string[] },
      OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }],
    },
    orderBy: { nextCheckAt: "asc" },
    take: Math.min(Math.max(limit, 1), 200),
    select: { id: true, userId: true, domain: true, checkIntervalMin: true },
  });
}

export interface WatchRow {
  id: string;
  userId: string;
  domain: string;
  checkIntervalMin: number;
}

export interface WatchAlert {
  domain: string;
  userId: string;
  dr: number | null;
  refdomains: number | null;
  score: number | null;
}

export interface WatchWriteResult {
  checked: number;
  /** Confirmed free — alerted, and the watch turned itself off. */
  freed: WatchAlert[];
  /** Looked free through one source only — re-check scheduled, no alert raised. */
  uncertain: string[];
  accelerated: number;
}

/**
 * Write one scheduler batch of registry verdicts onto watched rows.
 *
 * Iterated by row rather than by verdict so the owner scope is the row's own: the same domain
 * can exist for two users, and a batch keyed by domain alone would write one user's verdict over
 * the other's row.
 *
 * The rules differ from the funnel writer in exactly the ways watching requires:
 *
 * - a `registered` verdict is not an ending — the row is rescheduled on its interval (or the
 *   lifecycle acceleration, if the registry reports pendingDelete/redemption) and keeps being
 *   polled. That is the entire difference between the watch and the catalogue check, which stops
 *   at "taken".
 * - only a corroborated `available` ends a watch: alert once, stop watching, leave the name for
 *   the human. An uncorroborated one schedules a near-term re-check and stays quiet — the rule
 *   from availability.ts, applied to notifications.
 * - a refusal keeps the watch and rides the same 6h→12h→24h ladder as the funnel.
 */
export async function recordWatchResults(
  rows: WatchRow[],
  results: Map<string, import("./types").AvailabilityResult>,
): Promise<WatchWriteResult> {
  const out: WatchWriteResult = { checked: 0, freed: [], uncertain: [], accelerated: 0 };

  for (const row of rows) {
    const res = results.get(row.domain);
    if (!res) continue; // not reached before the batch deadline — still due, next tick re-asks
    out.checked++;
    const now = new Date();
    const scope = { userId: row.userId, domain: row.domain };

    if (res.ok && res.status === "registered") {
      const nextMin = nextWatchCheckMin(row.checkIntervalMin, res.registryStatus);
      const acceleration = watchAcceleration(res.registryStatus);
      const prev = (await db.dropCandidate.findFirst({
        where: scope,
        select: { registryStatus: true },
      })) as { registryStatus: string | null } | null;
      await db.dropCandidate.updateMany({
        where: scope,
        data: {
          stage: "taken" satisfies DropStage,
          lastStatus: "registered", lastHttp: res.http, lastVia: res.via, lastError: null,
          consecutiveErrors: 0, corroborated: false, lastCheckedAt: now,
          nextCheckAt: new Date(Date.now() + nextMin * 60_000),
          registryExpiresAt: res.expiresAt ?? null,
          registryCreatedAt: res.createdAt ?? null,
          registryStatus: res.registryStatus?.join(",") || null,
          nameServers: res.nameServers?.length ? JSON.stringify(res.nameServers) : null,
        },
      });
      // The one expected change in a watched domain's life gets a trail line, so the suddenly
      // shorter interval in the schedule has a visible cause. The needle drops the underscore:
      // stored statuses are the registry's EPP spellings ("pendingDelete"), lowercased here.
      if (acceleration && !(prev?.registryStatus ?? "").toLowerCase().includes(acceleration.replace("_", ""))) {
        out.accelerated++;
        await addEvent(row.id, "info", acceleration === "pending_delete"
          ? "registry reports pendingDelete — watch interval tightened to 15 min"
          : "registry reports redemptionPeriod — watch interval tightened to 60 min");
      }
    } else if (res.ok && res.status === "available" && res.corroborated) {
      await db.dropCandidate.updateMany({
        where: scope,
        data: {
          stage: "available" satisfies DropStage,
          lastStatus: "available", lastHttp: res.http, lastVia: res.via, lastError: null,
          consecutiveErrors: 0, corroborated: true, lastCheckedAt: now,
          nextCheckAt: null, watched: false,
        },
      });
      await addEvent(row.id, "available",
        `${row.domain} is free (confirmed by two sources) — watch complete, notification sent`);
      const facts = (await db.dropCandidate.findFirst({
        where: scope,
        select: { dr: true, refdomains: true, refdomainsDofollow: true, score: true },
      })) as { dr: number | null; refdomains: number | null; refdomainsDofollow: number | null; score: number | null } | null;
      out.freed.push({
        domain: row.domain,
        userId: row.userId,
        dr: facts?.dr ?? null,
        refdomains: facts?.refdomainsDofollow ?? facts?.refdomains ?? null,
        score: facts?.score ?? null,
      });
    } else if (res.ok && res.status === "available") {
      // One source says free, the other said nothing usable. Not an alert; a prompt to look
      // again within the hour, in case the silent source answers then.
      await db.dropCandidate.updateMany({
        where: scope,
        data: {
          stage: "available" satisfies DropStage,
          lastStatus: "available", lastHttp: res.http, lastVia: res.via, lastError: null,
          consecutiveErrors: 0, corroborated: false, lastCheckedAt: now,
          nextCheckAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      await addEvent(row.id, "info",
        `${row.domain} looks free via ${res.via} only — re-check scheduled, not alerted`);
      out.uncertain.push(row.domain);
    } else {
      // Registry refused. Same ladder as the funnel: 6h → 12h → 24h, held at 24h. The stage
      // returns to dns_checked exactly as the funnel writer leaves it — the watch loop re-picks
      // the row from there, and the stage dance is cosmetic next to the schedule.
      const prev = (await db.dropCandidate.findFirst({
        where: scope,
        select: { consecutiveErrors: true },
      })) as { consecutiveErrors: number } | null;
      const n = Math.min((prev?.consecutiveErrors ?? 0) + 1, REFUSAL_BACKOFF_MIN.length);
      const waitMin = REFUSAL_BACKOFF_MIN[n - 1];
      await db.dropCandidate.updateMany({
        where: scope,
        data: {
          stage: "dns_checked" satisfies DropStage,
          lastStatus: res.status,
          lastHttp: res.status === "rate_limited" ? 429 : res.http,
          lastError: res.status === "error" ? res.error : "rate_limited",
          consecutiveErrors: n,
          lastCheckedAt: now,
          nextCheckAt: new Date(Date.now() + waitMin * 60_000),
        },
      });
    }
  }

  return out;
}
