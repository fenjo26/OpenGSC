// The only module in src/lib/drops that talks to the database. Everything else stays pure so it
// can be tested without one; the interesting decisions here are about volume, not about logic.

import { prisma } from "@/lib/prisma";
import { parseDomainList, summariseSkips } from "./ingest";
import { tldOf } from "./registries";
import type { DropSource, DropStage } from "./types";

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

export interface CandidateFilter {
  runId?: string;
  stage?: DropStage;
  tld?: string;
  source?: DropSource;
  /** Substring match on the domain, for the search box. */
  q?: string;
  minScore?: number;
  starred?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: "score" | "createdAt" | "domain";
}

/**
 * A page of the catalogue plus the total behind the current filter.
 *
 * The count is what the UI shows as "По фильтру: 1 910 доменов", and it is a separate query on
 * purpose — `take`/`skip` cannot produce it, and loading 50 000 rows to length them would defeat
 * the pagination.
 */
export async function listCandidates(userId: string, f: CandidateFilter = {}) {
  const where: Record<string, unknown> = { userId };
  if (f.runId) where.runId = f.runId;
  if (f.stage) where.stage = f.stage;
  if (f.tld) where.tld = f.tld;
  if (f.starred !== undefined) where.starred = f.starred;
  if (typeof f.minScore === "number") where.score = { gte: f.minScore };
  // `contains` without `mode: "insensitive"`: that option is Postgres-only, and domains are
  // stored lower-cased on the way in, so folding the needle is enough and works on both engines.
  if (f.q?.trim()) where.domain = { contains: f.q.trim().toLowerCase() };
  if (f.source) where.run = { source: f.source };

  const take = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const skip = Math.max(f.offset ?? 0, 0);
  const orderBy =
    f.orderBy === "domain" ? { domain: "asc" as const }
    : f.orderBy === "createdAt" ? { createdAt: "desc" as const }
    // Nulls sort first on SQLite for a desc order, which would put every unscored row at the top
    // of a list whose whole purpose is ranking. Score-descending is therefore paired with a
    // stable second key, and unscored rows are expected to be filtered out by stage instead.
    : [{ score: "desc" as const }, { createdAt: "desc" as const }];

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
  opts: { runId?: string; limit?: number } = {},
): Promise<string[]> {
  const rows = (await db.dropCandidate.findMany({
    where: {
      userId,
      stage: { in: ["dns_checked", "checking"] as DropStage[] },
      ...(opts.runId ? { runId: opts.runId } : {}),
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
