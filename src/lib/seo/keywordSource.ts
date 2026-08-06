// One way to ask "what should this page target", whatever the user actually pays for.
//
// Before this file, the app had three keyword systems that did not know about each other:
// `keywords.ts` (DataForSEO, hardwired into the content tools), `demand.ts` (DataForSEO, richer,
// used only by the Demand tab) and `metrics.ts` (Ahrefs/Semrush, used only by the analytics
// screens). A user with an Ahrefs key writing an outline therefore got no keyword data at all —
// and, worse, was never told.
//
// This module is the router between them. Two questions, one shape:
//
//   expandKeywords(seed)   — "what else do people search here" → produces a list
//   enrichKeywords(list)   — "what are these worth"            → prices a list you have
//
// Three rules it exists to enforce:
//
// 1. **The cache is read first, always, and for free.** A row bought from Ahrefs is a row the
//    Semrush user has already paid for; `readKeywordCacheAny` makes it visible either way. Only
//    what is genuinely missing reaches a provider.
//
// 2. **Nothing is bought without being asked.** Every function takes an explicit `fetch` flag.
//    Called without it they are pure cache reads — safe on render, safe in an MCP tool, safe in a
//    background job.
//
// 3. **The market is required.** It is not defaulted to `us` anywhere in this file, because the
//    keyword cache is keyed by country and a wrong market spends money to write a row that will
//    never be read again.

import {
  fetchKeywordIdeas, fetchKeywordMetrics, estimateCostUsd,
  type IdeaMode, type KeywordMetric,
  type MetricsCreds, type MetricsProvider,
} from "./metrics";
import {
  discoverKeywords, keywordOverview, isSupportedCountry,
  type DemandRow, type KeywordIntent,
} from "./demand";
import { readKeywordCacheAny, writeKeywordCache, staleKeywords, normalizeKeyword, type CachedKeyword } from "./metricsStore";

export type KwSource = "ahrefs" | "semrush" | "dataforseo" | "off";

export interface KwCreds {
  source: KwSource;
  /** Ahrefs/Semrush key, or the DataForSEO `login:password` / Base64 token. */
  apiKey: string;
  /** Ahrefs/Semrush only: reseller or custom gateway host. */
  baseUrl?: string;
}

export interface KwResult {
  rows: DemandRow[];
  /** Which provider actually answered — never assumed by the caller. */
  source: KwSource;
  /** Provider units spent (Ahrefs/Semrush). DataForSEO bills in dollars, so this stays 0. */
  units: number;
  /** Money implied by this call, in USD, whichever provider answered. */
  usd: number;
  /** Rows served from cache without contacting anyone. */
  fromCache: number;
  error?: string;
}

const empty = (source: KwSource, error?: string): KwResult =>
  ({ rows: [], source, units: 0, usd: 0, fromCache: 0, error });

// ─── Shape conversion ──────────────────────────────────────────────────────────

/**
 * Ahrefs and Semrush rows into the shape `demand.ts` already defined.
 *
 * `DemandRow` wins as the common type rather than `KeywordMetric` because it is the richer of the
 * two — it carries intent and a trend — and because the outline prompt, the Demand tab and the
 * MCP tools were already written against it. Fields no provider supplies stay null instead of
 * being invented: a competition score guessed from CPC would be indistinguishable from a measured
 * one, which is the failure this whole change exists to stop.
 */
function metricToRow(m: KeywordMetric): DemandRow {
  return {
    keyword: m.keyword,
    volume: m.volume,
    globalVolume: m.globalVolume,
    difficulty: m.difficulty,
    cpc: m.cpc,
    competition: null,
    competitionLevel: null,
    intent: intentFromAhrefs(m.intents),
    trend: [],
  };
}

/** Ahrefs returns intents as an object of booleans; Semrush and the cache return nothing. */
function intentFromAhrefs(raw: string | null): KeywordIntent {
  if (!raw) return "unknown";
  try {
    const o = JSON.parse(raw);
    if (o?.transactional) return "transactional";
    if (o?.commercial) return "commercial";
    if (o?.navigational) return "navigational";
    if (o?.informational) return "informational";
  } catch { /* not an object we recognise */ }
  return "unknown";
}

function cachedToRow(c: CachedKeyword): DemandRow {
  return {
    keyword: c.keyword,
    volume: c.volume,
    globalVolume: c.globalVolume,
    difficulty: c.difficulty,
    cpc: c.cpc,
    competition: null,
    competitionLevel: null,
    intent: intentFromAhrefs(c.intents),
    trend: [],
  };
}

/** Cache rows are written from whichever provider answered, so later reads are provider-agnostic. */
function rowsToCacheWrites(rows: DemandRow[]) {
  return rows.map(r => ({
    keyword: r.keyword,
    volume: r.volume,
    difficulty: r.difficulty,
    cpc: r.cpc,
    globalVolume: r.globalVolume,
    parentTopic: null,
    intents: r.intent === "unknown" ? null : JSON.stringify({ [r.intent]: true }),
    payload: null,
  }));
}

const metricsCreds = (c: KwCreds): MetricsCreds => ({
  provider: c.source as MetricsProvider,
  apiKey: c.apiKey,
  baseUrl: c.baseUrl,
});

// ─── Expanding a seed ──────────────────────────────────────────────────────────

export interface ExpandOptions {
  country: string;
  language?: string;
  limit?: number;
  withDifficulty?: boolean;
  /** Ahrefs only: `matching` (long tail containing the seed) or `related` (adjacent topics). */
  mode?: IdeaMode;
  /** Without this nothing is bought and the answer is whatever the cache already holds. */
  fetch?: boolean;
}

/**
 * What a seed expansion will cost, before it is sent.
 *
 * Quoted as a ceiling for Ahrefs (it bills the rows it returns, and `limit` is the maximum) and
 * as the flat rate for Semrush. DataForSEO is priced in dollars by `demand.ts` and cannot be
 * known before the call, so it is reported as 0 here and filled in from the result.
 *
 * The implementations moved to `metricsClient.ts` so the browser-side content tools can quote a
 * button without dragging this module's Prisma dependency into the bundle. This file keeps the
 * doc, since the pricing rationale belongs with the source-router that enforces it.
 */

export async function expandKeywords(
  creds: KwCreds, seed: string, opts: ExpandOptions,
): Promise<KwResult> {
  const country = (opts.country || "").trim().toLowerCase();
  if (creds.source === "off") return empty("off", "source_off");
  if (!country) return empty(creds.source, "no_country");
  if (!seed.trim()) return empty(creds.source, "no_seed");
  if (!opts.fetch) return empty(creds.source, "not_fetched");
  if (!creds.apiKey) return empty(creds.source, "no_key");

  if (creds.source === "dataforseo") {
    if (!isSupportedCountry(country)) return empty("dataforseo", `unsupported_country:${country}`);
    const r = await discoverKeywords(creds.apiKey, seed, {
      gl: country, hl: opts.language || "en", limit: opts.limit ?? 100,
    });
    // Written into the shared cache so an Ahrefs user later sees rows DataForSEO paid for, and
    // vice versa. The whole point of one cache is that the money follows the keyword, not the tool.
    if (r.rows.length) await writeKeywordCache(rowsToCacheWrites(r.rows), country, "dataforseo", "api");
    return { rows: r.rows, source: "dataforseo", units: 0, usd: r.cost, fromCache: 0, error: r.error };
  }

  const mode: IdeaMode = opts.mode === "related" ? "related" : "matching";
  const res = await fetchKeywordIdeas(metricsCreds(creds), seed, {
    country, limit: opts.limit, withDifficulty: opts.withDifficulty, mode,
  });
  if (res.error) return { ...empty(creds.source, res.error), units: res.units };

  const rows = res.items.map(metricToRow);
  if (rows.length) await writeKeywordCache(rowsToCacheWrites(rows), country, creds.source, "api");

  return {
    rows,
    source: creds.source,
    units: res.units,
    usd: estimateCostUsd(res.units, creds.source as MetricsProvider),
    fromCache: 0,
  };
}

// ─── Pricing a list you already have ───────────────────────────────────────────

export interface EnrichOptions {
  country: string;
  language?: string;
  withDifficulty?: boolean;
  /** Without this the answer is the cache and nothing else — which is the common case. */
  fetch?: boolean;
}

/**
 * Attach volume / KD / CPC to keywords the caller already knows.
 *
 * Always answers, even with no key and no `fetch`: the cache alone is a useful answer and is what
 * makes a second outline on the same topic free. Rows it cannot price are simply absent, never
 * zero — a keyword with no data must not look like a keyword with no demand.
 */
export async function enrichKeywords(
  creds: KwCreds, keywords: string[], opts: EnrichOptions,
): Promise<KwResult> {
  const country = (opts.country || "").trim().toLowerCase();
  if (!country) return empty(creds.source, "no_country");

  const unique = [...new Set(keywords.map(normalizeKeyword).filter(Boolean))];
  if (!unique.length) return { rows: [], source: creds.source, units: 0, usd: 0, fromCache: 0 };

  // Free pass, across every provider that ever answered for this market.
  const cache = await readKeywordCacheAny(unique, country);
  const cachedRows = unique.map(k => cache[k]).filter(Boolean).map(cachedToRow);

  const canFetch = !!opts.fetch && creds.source !== "off" && !!creds.apiKey;
  if (!canFetch) {
    return {
      rows: cachedRows,
      source: creds.source,
      units: 0, usd: 0,
      fromCache: cachedRows.length,
      ...(opts.fetch && !creds.apiKey ? { error: "no_key" } : {}),
    };
  }

  const missing = staleKeywords(unique, cache, { needDifficulty: !!opts.withDifficulty });
  if (!missing.length) {
    return { rows: cachedRows, source: creds.source, units: 0, usd: 0, fromCache: cachedRows.length };
  }

  if (creds.source === "dataforseo") {
    if (!isSupportedCountry(country)) {
      return { rows: cachedRows, source: "dataforseo", units: 0, usd: 0, fromCache: cachedRows.length, error: `unsupported_country:${country}` };
    }
    const r = await keywordOverview(creds.apiKey, missing, { gl: country, hl: opts.language || "en" });
    if (r.rows.length) await writeKeywordCache(rowsToCacheWrites(r.rows), country, "dataforseo", "api");
    return {
      rows: merge(cachedRows, r.rows),
      source: "dataforseo", units: 0, usd: r.cost,
      fromCache: cachedRows.length, error: r.error,
    };
  }

  const res = await fetchKeywordMetrics(metricsCreds(creds), missing, {
    country, withDifficulty: opts.withDifficulty,
  });
  if (res.error) {
    return { rows: cachedRows, source: creds.source, units: res.units, usd: 0, fromCache: cachedRows.length, error: res.error };
  }

  const fresh = res.items.map(metricToRow);
  if (fresh.length) await writeKeywordCache(rowsToCacheWrites(fresh), country, creds.source, "api");

  return {
    rows: merge(cachedRows, fresh),
    source: creds.source,
    units: res.units,
    usd: estimateCostUsd(res.units, creds.source as MetricsProvider),
    fromCache: cachedRows.length,
  };
}

/** Later rows win on conflict — the freshly fetched ones are by definition the newer answer. */
function merge(a: DemandRow[], b: DemandRow[]): DemandRow[] {
  const by = new Map<string, DemandRow>();
  for (const r of [...a, ...b]) by.set(r.keyword, r);
  return [...by.values()].sort((x, z) => (z.volume ?? 0) - (x.volume ?? 0));
}
