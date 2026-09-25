// Plagiarism check — orchestration (Prisma + SERP network). The pure halves live beside this:
// text.ts (prose extraction), sample.ts (fragment picking), match.ts (shingle matching),
// price.ts (per-provider cost). This file owns everything that touches the outside world:
// the user's SERP credentials, the quoted queries, the unit ledger and the 7-day textHash cache.
//
// CONTRACT.md §0.5 is the whole design: every checked fragment is one paid SERP query, so the
// sample is capped at 10, the price is computed and shown before the run, and nothing here
// spends without the caller's explicit confirm (routes gate on `spend`, MCP on `confirm: true`).

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getUserSerpCreds, type SerpCreds } from "@/lib/rank";
import { runSerp } from "@/lib/seo/serp";
import { rankProviderName } from "@/lib/seo/rankProviders";
import { recordUsage, releaseUnusedUnits, withinCap } from "@/lib/seo/metricsStore";
import { normalizeTextForPlagiarism, splitSentences } from "./text";
import { MAX_FRAGMENTS, pickFragments, eligibleFragments, type Fragment } from "./sample";
import { aggregateMatches, type MatchReport } from "./match";
import { estimateSerpQueryCost, usdToUnits } from "./price";

export { MAX_FRAGMENTS } from "./sample";
export { estimateSerpQueryCost, usdToUnits, UNITS_PER_USD } from "./price";
export type { SerpCostEstimate } from "./price";
export type { MatchReport, FragmentMatch, SourceRow } from "./match";

/** A cached re-check is served for 7 days: the web moves, but not enough to re-bill daily. */
export const CACHE_TTL_DAYS = 7;

/** Pause between quoted queries — same kindness to rate limits the Rank Tracker pays (rank.ts). */
const QUERY_DELAY_MS = 800;

/** Give up on a provider that fails this many queries in a row: it is down, not unlucky. */
const CONSECUTIVE_ERRORS_ABORT = 5;

export interface PlagiarismResult extends MatchReport {
  provider: string;
  queries: number;
  checkedAt: string;
  /** Distinct errors returned by the provider mid-run (the result is still usable when short). */
  providerErrors: string[];
  /** Fragment start offsets in the normalized text, for highlighting in the UI. */
  offsets: { index: number; start: number }[];
}

export interface PlagiarismEstimate {
  provider: string;
  providerName: string;
  queries: number;
  costUsd: number | null;
  free: boolean;
  unknownPrice: boolean;
  cached: boolean;
  cachedAt: string | null;
  textHash: string;
  error?: string;
}

export interface PreparedText {
  normalized: string;
  fragments: Fragment[];
  textHash: string;
  keyword: string;
  historyId: string | null;
}

export function plagiarismTablesMissing(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" ||
    /PlagiarismCheck.*(?:does not exist|no such table)|(?:does not exist|no such table).*PlagiarismCheck/i.test(String(value?.message ?? ""))
  );
}

/** sha1 of the normalized text — the cache key. Normalized first: a re-paste with different
 *  markdown must not be billed as a new text. */
export function textHashOf(normalized: string): string {
  return createHash("sha1").update(normalized).digest("hex");
}

function extractArticle(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    // Landing/analysis records keep the prose under a field; a missing field is an honest
    // empty string, and the caller reports "no text" rather than searching garbage.
    for (const key of ["text", "body", "article", "content", "markdown"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
  }
  return "";
}

/**
 * Resolve the text to check: pasted directly, or the article of a History record. Shared by
 * the estimate (free) and the run (paid) so the two can never disagree about what was priced.
 * Throws `history_not_found` for a record that is not this user's.
 */
export async function preparePlagiarismText(
  userId: string,
  opts: { text?: unknown; historyId?: unknown },
): Promise<PreparedText> {
  let raw = "";
  let keyword = "";
  let historyId: string | null = null;

  const hid = String(opts.historyId ?? "").trim();
  if (hid) {
    const row = await prisma.seoHistory.findFirst({ where: { id: hid, userId } });
    if (!row) throw new Error("history_not_found");
    // SeoHistory.data is a string column: article markdown for `text` records, JSON for the rest.
    let data: unknown = row.data;
    if (row.type !== "text" && typeof row.data === "string") {
      try { data = JSON.parse(row.data); } catch { /* keep the raw string */ }
    }
    raw = extractArticle(data);
    keyword = String(row.keyword ?? "");
    historyId = row.id;
  } else {
    raw = String(opts.text ?? "");
  }

  const normalized = normalizeTextForPlagiarism(raw);
  const fragments = pickFragments(splitSentences(normalized), { keyword });
  return { normalized, fragments, textHash: textHashOf(normalized), keyword, historyId };
}

/** The cache lookup both estimate and run share: a fresh check of the same text is free. */
async function findCachedCheck(userId: string, textHash: string): Promise<{ result: PlagiarismResult; checkedAt: string } | null> {
  try {
    const row = await prisma.plagiarismCheck.findFirst({
      where: {
        userId, textHash, status: "done",
        createdAt: { gte: new Date(Date.now() - CACHE_TTL_DAYS * 86_400_000) },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!row?.result) return null;
    return { result: JSON.parse(row.result) as PlagiarismResult, checkedAt: row.createdAt.toISOString() };
  } catch (e) {
    if (plagiarismTablesMissing(e)) throw e; // surfaced by the route as notMigrated
    return null; // a broken cache row is a cache miss, never a failed check
  }
}

/**
 * The free half: how many queries this text would cost, on which provider, for how much —
 * without sending a single one of them. Reading the SERP credentials touches only settings
 * storage (the A-Parser branch may ping the instance to pick between two passwords; that is a
 * credentials probe, not a SERP query).
 */
export async function estimatePlagiarism(
  userId: string,
  opts: { text?: unknown; historyId?: unknown },
): Promise<PlagiarismEstimate> {
  const prepared = await preparePlagiarismText(userId, opts);
  const cache = await findCachedCheck(userId, prepared.textHash);
  if (cache) {
    return {
      provider: cache.result.provider,
      providerName: rankProviderName(cache.result.provider),
      queries: 0,
      costUsd: 0,
      free: true,
      unknownPrice: false,
      cached: true,
      cachedAt: cache.checkedAt,
      textHash: prepared.textHash,
    };
  }

  const creds = await getUserSerpCreds(userId);
  if (!creds) {
    return {
      provider: "", providerName: "", queries: prepared.fragments.length, costUsd: null,
      free: false, unknownPrice: false, cached: false, cachedAt: null,
      textHash: prepared.textHash, error: "no_serp_key",
    };
  }
  const price = estimateSerpQueryCost(creds.provider, prepared.fragments.length);
  return {
    provider: creds.provider,
    providerName: rankProviderName(creds.provider),
    queries: prepared.fragments.length,
    costUsd: price.costUsd,
    free: price.free,
    unknownPrice: price.unknownPrice,
    cached: false,
    cachedAt: null,
    textHash: prepared.textHash,
  };
}

function serpOpts(creds: SerpCreds) {
  return {
    num: 10,
    ...(creds.baseUrl ? { baseUrl: creds.baseUrl } : {}),
    ...(creds.configPreset ? { configPreset: creds.configPreset } : {}),
  };
}

export interface PlagiarismRunOutcome {
  ok: boolean;
  error?: string;
  detail?: string;
  cached?: boolean;
  result?: PlagiarismResult;
  checkedAt?: string;
  provider?: string;
  queries?: number;
  costUsd?: number | null;
}

/**
 * The paid half: one quoted query per fragment, shingle matching, sources, cache write.
 * Spending discipline: the ceiling is reserved BEFORE the first query, and whatever the run
 * did not actually spend (failed queries, an aborted provider) is released afterwards — the
 * same reserve/release pattern the Ahrefs paths in metricsStore use.
 */
export async function runPlagiarismCheck(
  userId: string,
  opts: { text?: unknown; historyId?: unknown; siteId?: unknown; cap?: unknown },
): Promise<PlagiarismRunOutcome> {
  const prepared = await preparePlagiarismText(userId, opts);
  if (!prepared.normalized) return { ok: false, error: "no_text" };
  if (!prepared.fragments.length) return { ok: false, error: "no_fragments" };

  const cache = await findCachedCheck(userId, prepared.textHash);
  if (cache) {
    return { ok: true, cached: true, result: cache.result, checkedAt: cache.checkedAt, queries: 0, costUsd: 0 };
  }

  const creds = await getUserSerpCreds(userId);
  if (!creds) return { ok: false, error: "no_serp_key" };

  const price = estimateSerpQueryCost(creds.provider, prepared.fragments.length);
  const perQueryUsd = price.costUsd != null && prepared.fragments.length
    ? price.costUsd / prepared.fragments.length
    : null;
  const cap = Number(opts.cap ?? 0) || 0;
  let reservedUnits = 0;
  if (price.costUsd != null && price.costUsd > 0) {
    reservedUnits = usdToUnits(price.costUsd);
    if (!(await withinCap(userId, creds.provider, reservedUnits, cap))) {
      return { ok: false, error: "cap_exceeded", detail: `≈ $${price.costUsd.toFixed(4)}`, provider: creds.provider, queries: prepared.fragments.length };
    }
    await recordUsage(userId, creds.provider, reservedUnits);
  }

  const siteId = String(opts.siteId ?? "").trim();
  let ownHost = "";
  if (siteId) {
    const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { url: true } });
    if (site) {
      ownHost = String(site.url).toLowerCase().replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").split("/")[0].replace(/^www\./, "");
    }
  }

  const check = await prisma.plagiarismCheck.create({
    data: {
      userId,
      historyId: prepared.historyId,
      textHash: prepared.textHash,
      provider: creds.provider,
      status: "running",
      queries: prepared.fragments.length,
      ...(price.costUsd != null ? { costUsd: price.costUsd } : {}),
    },
  });

  const finishFailed = async (detail: string, successfulQueries: number): Promise<PlagiarismRunOutcome> => {
    const spentUsd = perQueryUsd != null ? successfulQueries * perQueryUsd : null;
    if (reservedUnits > 0 && spentUsd != null) {
      await releaseUnusedUnits(userId, creds.provider, reservedUnits, usdToUnits(spentUsd));
    }
    try {
      await prisma.plagiarismCheck.update({
        where: { id: check.id },
        data: { status: "failed", error: detail.slice(0, 1000), finishedAt: new Date() },
      });
    } catch { /* the outcome still reaches the caller */ }
    return { ok: false, error: "provider_failed", detail, provider: creds.provider, queries: successfulQueries };
  };

  const optsSerp = serpOpts(creds);
  const checks: { index: number; fragment: string; hits: { url: string; title: string; snippet: string }[] }[] = [];
  const providerErrors: string[] = [];
  let successful = 0;
  let consecutiveErrors = 0;

  for (let i = 0; i < prepared.fragments.length; i++) {
    const frag = prepared.fragments[i];
    const serp = await runSerp(creds.provider, creds.apiKey, `"${frag.text}"`, optsSerp);
    if (serp.error) {
      providerErrors.push(serp.errorDetail ? `${serp.error} (${serp.errorDetail.slice(0, 120)})` : serp.error);
      consecutiveErrors++;
      checks.push({ index: i, fragment: frag.text, hits: [] });
      // A provider that fails everything is down, and an empty result table would read as
      // "100% original" — the exact quiet lie CONTRACT.md forbids. Abort, release, say so.
      if (successful === 0 && i >= 1) return finishFailed(providerErrors[0], successful);
      if (consecutiveErrors >= CONSECUTIVE_ERRORS_ABORT) {
        return finishFailed(providerErrors[providerErrors.length - 1], successful);
      }
      continue;
    }
    consecutiveErrors = 0;
    successful++;
    checks.push({
      index: i,
      fragment: frag.text,
      hits: serp.results.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet })),
    });
    if (i < prepared.fragments.length - 1) await new Promise((r) => setTimeout(r, QUERY_DELAY_MS));
  }

  if (successful === 0) return finishFailed(providerErrors[0] ?? "provider returned no answer", 0);

  const report = aggregateMatches(checks, ownHost);
  const result: PlagiarismResult = {
    ...report,
    provider: creds.provider,
    queries: successful,
    checkedAt: new Date().toISOString(),
    providerErrors,
    offsets: prepared.fragments.map((f, index) => ({ index, start: f.start })),
  };
  const spentUsd = perQueryUsd != null ? successful * perQueryUsd : null;
  if (reservedUnits > 0 && spentUsd != null) {
    await releaseUnusedUnits(userId, creds.provider, reservedUnits, usdToUnits(spentUsd));
  }
  try {
    await prisma.plagiarismCheck.update({
      where: { id: check.id },
      data: {
        status: "done",
        queries: successful,
        ...(spentUsd != null ? { costUsd: Math.round(spentUsd * 1e6) / 1e6 } : {}),
        result: JSON.stringify(result),
        finishedAt: new Date(),
        ...(providerErrors.length ? { error: providerErrors.join("; ").slice(0, 1000) } : {}),
      },
    });
  } catch { /* pre-migration instance: the answer is still returned, just not cached */ }

  return { ok: true, result, provider: creds.provider, queries: successful, costUsd: spentUsd };
}

/** Sentence diagnostics for the UI: why a text produced the fragment count it did. */
export function fragmentStats(sentences: { text: string; start: number }[], keyword = "") {
  const eligible = eligibleFragments(sentences, keyword);
  return { sentences: sentences.length, eligible: eligible.length, sampled: Math.min(MAX_FRAGMENTS, eligible.length) };
}
