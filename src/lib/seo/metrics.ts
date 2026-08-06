// Third-party SEO metrics (Ahrefs / Semrush) behind one call surface, mirroring the shape of
// `src/lib/llm.ts`: several providers, one signature, retries and normalization in one place.
//
// Three things about this module are load-bearing and easy to get wrong:
//
// 1. **`select` is the price.** Ahrefs bills `max(50, per_row_cost × rows)`, where most fields
//    cost 1 unit but a handful cost 5 or 10 — `volume` and `difficulty` among them. Adding one
//    column to a 100-row request can double its cost, so callers choose fields explicitly and
//    `estimateUnits()` prices the request BEFORE it is sent. Nothing here picks fields for you.
//
// 2. **The 50-unit floor makes small requests wasteful.** A single keyword costs the same as
//    four. Anything that would fetch row-by-row (on hover, on expand, per table row) is a bug,
//    not an optimization — batch, always.
//
// 3. **Three concurrent requests per key, then 429.** The gateway is explicit about this. This
//    module owns a per-key semaphore so callers cannot accidentally fan out with Promise.all;
//    `/api/dr` uses concurrency 4 for the *free* endpoint and must not be copied here.

export type MetricsProvider = "ahrefs" | "semrush";

export interface MetricsCreds {
  provider: MetricsProvider;
  apiKey: string;
  /** Optional host override — an official client pointed at a different gateway. Path is unchanged. */
  baseUrl?: string;
}

export const DEFAULT_BASE_URL: Record<MetricsProvider, string> = {
  ahrefs: "https://api.ahrefs.com",
  semrush: "https://api.semrush.com",
};

// ─── Cost model ────────────────────────────────────────────────────────────────

/**
 * Published gateway rates, used only to turn a unit count into a number a human can judge.
 *
 * Lives here rather than in `metricsClient.ts` — where it started — because the server now prices
 * requests too, and that file is `"use client"`. Importing a client module into a server one to
 * get at two constants would drag the whole browser-storage surface across the boundary.
 * `metricsClient` re-exports both, so every existing import keeps working unchanged.
 */
export const UNIT_PRICE_USD: Record<MetricsProvider, number> = {
  ahrefs: 0.000025,
  semrush: 0.00006,
};

export function estimateCostUsd(units: number, provider: MetricsProvider): number {
  return units * (UNIT_PRICE_USD[provider] ?? 0);
}

/** Ahrefs charges a flat 50 units for anything cheaper, so tiny batches are pure waste. */
export const AHREFS_UNIT_FLOOR = 50;

/**
 * Per-field unit cost, by endpoint. Fields absent from a table cost 1 unit.
 * Source: gateway docs, "Cost: max(50, per_row_cost × rows) — most fields cost 1 unit.
 * Premium fields: ...". Kept as data rather than magic numbers so a price change is a
 * one-line edit and `estimateUnits` stays honest.
 */
const AHREFS_PREMIUM_FIELDS: Record<string, Record<string, number>> = {
  "keywords-explorer/overview": {
    volume: 10, difficulty: 10, global_volume: 10, intents: 10,
    parent_volume: 10, traffic_potential: 10, volume_monthly: 10,
  },
  "site-explorer/metrics": {
    org_traffic: 10, org_cost: 10, paid_traffic: 10, paid_cost: 10,
  },
  "site-explorer/organic-keywords": {
    volume: 10, volume_merged: 10, volume_prev: 10,
    keyword_difficulty: 10, keyword_difficulty_merged: 10, keyword_difficulty_prev: 10,
    sum_traffic: 10, sum_traffic_merged: 10, sum_traffic_prev: 10,
    sum_paid_traffic: 10, sum_paid_traffic_merged: 10, sum_paid_traffic_prev: 10,
    all_positions: 5, all_positions_prev: 5,
  },
  "site-explorer/all-backlinks": {
    traffic: 10, traffic_domain: 10,
    class_c: 5, refdomains_source: 5, refdomains_source_domain: 5, refdomains_target_domain: 5,
  },
  // Keyword ideas. Same premium set as `overview` — the endpoint differs, the price of a column
  // does not. `limit` is what makes these expensive: Ahrefs bills the rows it returns, so asking
  // for 1000 ideas costs ten times what asking for 100 does.
  "keywords-explorer/matching-terms": {
    volume: 10, difficulty: 10, global_volume: 10, intents: 10,
    traffic_potential: 10, volume_monthly: 10,
  },
  "keywords-explorer/related-terms": {
    volume: 10, difficulty: 10, global_volume: 10, intents: 10,
    traffic_potential: 10, volume_monthly: 10,
  },
  "site-explorer/refdomains": { traffic_domain: 10, dofollow_refdomains: 5 },
  "site-explorer/organic-competitors": {
    traffic: 10, traffic_merged: 10, traffic_prev: 10,
    value: 10, value_merged: 10, value_prev: 10,
  },
};

/** Cost of one row for a given endpoint and field selection. */
export function perRowCost(endpoint: string, select: string[]): number {
  const premium = AHREFS_PREMIUM_FIELDS[endpoint] ?? {};
  return select.reduce((sum, f) => sum + (premium[f] ?? 1), 0);
}

/**
 * What a request will cost, computed before sending it.
 *
 * `filterFields` exists because Ahrefs bills columns used in `where`/`order_by` even when they
 * are not returned — a filter on `difficulty` costs exactly as much as displaying it. Omitting
 * them would make every estimate quietly low on precisely the requests that are expensive.
 */
export function estimateUnits(
  endpoint: string,
  select: string[],
  rows: number,
  filterFields: string[] = [],
): number {
  const billed = [...new Set([...select, ...filterFields])];
  return Math.max(AHREFS_UNIT_FLOOR, perRowCost(endpoint, billed) * Math.max(1, rows));
}

// Field sets used by the app. Named so the UI can price a request without knowing Ahrefs.
export const KEYWORD_FIELDS_BASE = ["keyword", "volume", "cpc", "parent_topic"];
export const KEYWORD_FIELDS_KD = ["difficulty"];

/** Cost of loading weights for N keywords, with and without the KD column. */
export function estimateKeywordUnits(count: number, withDifficulty: boolean): number {
  const select = withDifficulty ? [...KEYWORD_FIELDS_BASE, ...KEYWORD_FIELDS_KD] : KEYWORD_FIELDS_BASE;
  return estimateUnits("keywords-explorer/overview", select, count);
}

/**
 * Which flavour of "more keywords like this" to ask for.
 *
 * `matching` (matching-terms) returns the long tail that literally contains the seed — the shape
 * the content tools expect, and the closest match to what DataForSEO's related_keywords returned
 * before. `related` (related-terms) returns what top-ranking pages ALSO rank for, which finds
 * neighbouring topics that share no words with the seed. They answer different questions and are
 * billed separately, so this is a choice and never a merge.
 */
export type IdeaMode = "matching" | "related";

/**
 * Ideas carry the same columns as an overview row; KD stays optional for the same reason.
 *
 * `global_volume` and `intents` are included unconditionally even though both are 10-unit premium
 * fields. A brand/niche term often has zero local demand but real worldwide demand, and the
 * outline prompt's intent→section rule depends on the intent label — without it the rule is dead.
 * The combined cost (≈$0.05 extra per 100 ideas over the volume-only base) is worth paying on
 * every call rather than gating behind a toggle an SEO user would leave on anyway.
 */
export const IDEA_FIELDS_BASE = ["keyword", "volume", "global_volume", "cpc", "intents", "parent_topic"];

export function ideaEndpoint(mode: IdeaMode): string {
  return mode === "related" ? "keywords-explorer/related-terms" : "keywords-explorer/matching-terms";
}

/**
 * Price of one ideas request.
 *
 * `limit` is the row count Ahrefs will bill, so this is a ceiling rather than an estimate: a thin
 * seed returns fewer rows and costs less. Quoting the ceiling is deliberate — a button that
 * under-promises the price is the one that gets pressed by accident.
 */
export function estimateIdeaUnits(mode: IdeaMode, limit: number, withDifficulty: boolean): number {
  const select = withDifficulty ? [...IDEA_FIELDS_BASE, ...KEYWORD_FIELDS_KD] : IDEA_FIELDS_BASE;
  return estimateUnits(ideaEndpoint(mode), select, limit);
}

/**
 * Semrush prices a whole report per line, not per column, so its ideas cost is a flat rate.
 * `phrase_fullsearch` (broad match) is 20 units/line against `phrase_related`'s 40 and returns
 * `Kd` in the same report — which makes it the only sensible choice here.
 */
export const SEMRUSH_IDEA_UNITS_PER_ROW = 20;

export function estimateSemrushIdeaUnits(limit: number): number {
  return SEMRUSH_IDEA_UNITS_PER_ROW * Math.max(1, limit);
}

// Domain reports: per-line flat rates, same column-agnostic pricing as ideas. `domain_organic`
// (the keywords a domain ranks for) is 10 units/line; `domain_organic_organic` (organic
// competitors) is 40. KD is part of the `domain_organic` report at no surcharge — the same
// structural fact that makes it free in `phrase_these`.
export const SEMRUSH_COMPETITOR_UNITS_PER_ROW = 40;
export const SEMRUSH_ORGANIC_KEYWORD_UNITS_PER_ROW = 10;

/**
 * Pricing for the keyword-source layer, so a button can quote itself before it is pressed.
 *
 * Lives here — not in `metricsClient.ts` — because the server route charges the cap before the
 * call, and `metricsClient.ts` is `"use client"`: importing it from a server route fails the
 * production bundle. `metrics.ts` is imported by both sides and touches no browser API, so it is
 * the one place that stays safe for both. `metricsClient.ts` re-exports both for the browser
 * callers, so existing imports keep working.
 */
export function priceExpand(
  source: string, limit: number, withDifficulty: boolean, mode: IdeaMode = "matching",
): { units: number; usd: number } {
  if (source === "ahrefs") {
    const units = estimateIdeaUnits(mode, limit, withDifficulty);
    return { units, usd: estimateCostUsd(units, "ahrefs") };
  }
  if (source === "semrush") {
    const units = estimateSemrushIdeaUnits(limit);
    return { units, usd: estimateCostUsd(units, "semrush") };
  }
  return { units: 0, usd: 0 };
}

/** Cost of pricing N unknown keywords, so a button can quote itself before it is pressed. */
export function priceEnrich(source: string, count: number, withDifficulty: boolean) {
  if (source === "ahrefs" || source === "semrush") {
    const units = estimateKeywordUnits(count, withDifficulty);
    return { units, usd: estimateCostUsd(units, source as MetricsProvider) };
  }
  return { units: 0, usd: 0 };
}

// ─── Concurrency + retries ─────────────────────────────────────────────────────

/**
 * One in-flight slot pool per API key. The gateway rejects a 4th simultaneous request with 429,
 * and a rejected request still costs a round-trip, so queueing beats retrying.
 */
const MAX_IN_FLIGHT = 3;
const pools = new Map<string, { active: number; queue: (() => void)[] }>();

function poolFor(key: string) {
  let p = pools.get(key);
  if (!p) { p = { active: 0, queue: [] }; pools.set(key, p); }
  return p;
}

async function withSlot<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const pool = poolFor(key);
  if (pool.active >= MAX_IN_FLIGHT) {
    await new Promise<void>(resolve => pool.queue.push(resolve));
  }
  pool.active++;
  try {
    return await fn();
  } finally {
    pool.active--;
    const next = pool.queue.shift();
    if (next) next();
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Retries 429 (rate limit) and 5xx — the gateway names 502 specifically, because its upstream
 * data path can be briefly unavailable. A 4xx that is not 429 is not retried: a bad key or a
 * malformed `select` will fail identically on every attempt, and each attempt may still bill.
 */
async function requestWithRetry(url: string, init: RequestInit, poolKey: string): Promise<Response> {
  let lastErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await withSlot(poolKey, () =>
        fetch(url, { ...init, signal: AbortSignal.timeout(45_000) }),
      );
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 2) return res;
        await sleep(800 * 2 ** attempt + Math.random() * 400);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === 2) break;
      await sleep(800 * 2 ** attempt + Math.random() * 400);
    }
  }
  throw lastErr ?? new Error("request_failed");
}

// ─── Normalized shapes ─────────────────────────────────────────────────────────

export interface KeywordMetric {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  globalVolume: number | null;
  parentTopic: string | null;
  intents: string | null;
  payload: any;
}

export interface DomainMetric {
  domain: string;
  dr: number | null;
  refDomains: number | null;
  backlinks: number | null;
  orgTraffic: number | null;
  orgKeywords: number | null;
  orgCost: number | null;
  payload: any;
}

export interface MetricsResult<T> {
  items: T[];
  /** Units actually requested (the estimate that was charged against the cap). */
  units: number;
  error?: string;
}

/**
 * A provider's number, or null when it did not give one.
 *
 * The explicit null/empty guard is the whole point. `Number(null)` is `0` and `0` is finite, so
 * without it every field the API answered as JSON `null` — "we have no data for this keyword in
 * this country" — was stored as a hard zero, which reads as "nobody searches for this". The two
 * are opposite conclusions and the cache could not tell them apart.
 *
 * The live instance shows exactly this: of 124 cached Ahrefs rows, 65 carry `volume = 0` and not
 * one carries `volume = NULL`, while 88 carry `cpc = NULL` — because `cpc` was the single field
 * guarded by hand at its call site and the others were not. The asymmetry is the proof.
 */
const num = (v: any): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The market is a required argument, not a defaulted one.
 *
 * Every call here used to read `opts.country || "us"`. The cache is keyed on
 * `(keyword, country, provider)`, so a missing market did not merely query the wrong country —
 * it wrote the answer into a cell nothing would ever read again. A Greek keyword bought as `us`
 * stays invisible to the Greek view that paid for it, forever, and the screen shows an em dash
 * beside a row that is already on the invoice.
 *
 * Required in the type so the compiler catches static callers, and re-checked here because the
 * API routes build these options from parsed JSON, where the type guarantees nothing.
 */
const normCountry = (c: string): string => (c || "").trim().toLowerCase();

// ─── Ahrefs ────────────────────────────────────────────────────────────────────

/**
 * Keyword metrics for a batch of keywords.
 *
 * Keywords are passed as a comma-separated list, which means a keyword containing a comma
 * cannot be expressed — those are dropped rather than silently mangled into two keywords,
 * because a wrong volume attached to a real keyword is worse than a missing one.
 */
async function ahrefsKeywords(
  creds: MetricsCreds,
  keywords: string[],
  opts: { country: string; withDifficulty?: boolean },
): Promise<MetricsResult<KeywordMetric>> {
  const usable = keywords.filter(k => k && !k.includes(","));
  if (!usable.length) return { items: [], units: 0 };

  const select = opts.withDifficulty
    ? [...KEYWORD_FIELDS_BASE, ...KEYWORD_FIELDS_KD]
    : [...KEYWORD_FIELDS_BASE];
  const units = estimateUnits("keywords-explorer/overview", select, usable.length);

  const base = (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
  const params = new URLSearchParams({
    select: select.join(","),
    country: normCountry(opts.country),
    keywords: usable.join(","),
  });

  const res = await requestWithRetry(
    `${base}/v3/keywords-explorer/overview?${params}`,
    { headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" } },
    creds.apiKey,
  );
  if (!res.ok) {
    return { items: [], units: 0, error: `ahrefs ${res.status}: ${(await res.text()).slice(0, 300)}` };
  }

  // Every Ahrefs list endpoint answers with one top-level object keyed by report name.
  const data = await res.json();
  const rows: any[] = Array.isArray(data?.keywords) ? data.keywords : [];

  return {
    units,
    items: rows.map(r => ({
      keyword: String(r.keyword ?? ""),
      volume: num(r.volume),
      difficulty: num(r.difficulty),
      cpc: r.cpc == null ? null : num(r.cpc),
      globalVolume: num(r.global_volume),
      parentTopic: r.parent_topic ? String(r.parent_topic) : null,
      intents: r.intents ? JSON.stringify(r.intents) : null,
      payload: r,
    })).filter(k => k.keyword),
  };
}

/**
 * Domain metrics: organic traffic/value from Site Explorer, link counts from backlinks-stats.
 *
 * Two calls, and both hit the 50-unit floor, so a domain costs 100 units whatever it returns.
 * That is the whole reason this is not fetched on render anywhere — a dashboard with 40 sites
 * would cost 4 000 units per page view.
 *
 * DR is deliberately absent. It already arrives free through `/api/dr` and the public
 * domain-rating endpoint, which needs no key and works for every user; buying it again here
 * would charge people for a number they already have.
 */
export const DOMAIN_UNITS = AHREFS_UNIT_FLOOR * 2;

async function ahrefsDomain(creds: MetricsCreds, domain: string): Promise<MetricsResult<DomainMetric>> {
  const base = (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
  const auth = { headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" } };
  const date = new Date().toISOString().slice(0, 10);

  // Neither endpoint accepts `select` — both always return their full field set (8 and 4
  // fields). Sending one anyway is at best ignored and at worst a 400, and it would also make
  // the cost estimate a fiction: with no field choice, the price is fixed and both land on the
  // 50-unit floor regardless of what is read out of the response.
  const [mRes, lRes] = await Promise.all([
    requestWithRetry(
      `${base}/v3/site-explorer/metrics?${new URLSearchParams({ target: domain, mode: "domain", date })}`,
      auth, creds.apiKey,
    ),
    requestWithRetry(
      `${base}/v3/site-explorer/backlinks-stats?${new URLSearchParams({ target: domain, mode: "domain", date })}`,
      auth, creds.apiKey,
    ),
  ]);

  // A failure on either half is not fatal: half a card is better than an error, and the caller
  // has no way to ask for just the part that worked.
  const m = mRes.ok ? ((await mRes.json())?.metrics ?? {}) : {};
  const l = lRes.ok ? (await lRes.json()) : {};
  const stats = l?.metrics ?? l;

  if (!mRes.ok && !lRes.ok) {
    return { items: [], units: 0, error: `ahrefs ${mRes.status}/${lRes.status}` };
  }

  return {
    units: DOMAIN_UNITS,
    items: [{
      domain,
      dr: null,
      refDomains: num(stats?.live_refdomains),
      backlinks: num(stats?.live),
      orgTraffic: num(m?.org_traffic),
      orgKeywords: num(m?.org_keywords),
      orgCost: num(m?.org_cost),
      payload: { ...m, ...stats },
    }],
  };
}

// ─── Backlink profile ──────────────────────────────────────────────────────────

export interface RefDomainItem {
  refDomain: string;
  dr: number | null;
  linksToTarget: number | null;
  dofollow: boolean;
  firstSeen: string;
}

export interface BacklinkProfile {
  refDomainsTotal: number | null;
  backlinksTotal: number | null;
  dofollowPct: number | null;
  refDomains: RefDomainItem[];
}

/** Cost of one profile pull, so the button can price itself the same way the server will. */
export function estimateProfileUnits(limit: number): number {
  // backlinks-stats is a single floored call; refdomains bills 5 units a row on the fields below.
  return AHREFS_UNIT_FLOOR + estimateUnits("site-explorer/refdomains", REFDOMAIN_FIELDS, limit);
}

/**
 * Every field here costs 1 unit. The tempting ones — `traffic_domain` (10) and
 * `dofollow_refdomains` (5) — are left out deliberately: they would triple the price of a
 * 100-row pull to show numbers that do not change which links you care about.
 */
const REFDOMAIN_FIELDS = ["domain", "domain_rating", "links_to_target", "dofollow_links", "first_seen"];

async function ahrefsProfile(
  creds: MetricsCreds,
  domain: string,
  opts: { limit?: number; minDr?: number },
): Promise<MetricsResult<BacklinkProfile>> {
  const limit = Math.max(10, Math.min(1000, opts.limit ?? 100));
  const base = (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
  const auth = { headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" } };
  const date = new Date().toISOString().slice(0, 10);

  // No `select` here either — backlinks-stats always returns all four of
  // all_time / all_time_refdomains / live / live_refdomains.
  const statsParams = new URLSearchParams({ target: domain, mode: "domain", date });

  const rdParams = new URLSearchParams({
    target: domain, mode: "domain", limit: String(limit),
    select: REFDOMAIN_FIELDS.join(","),
    order_by: "domain_rating:desc",
  });
  // `where` columns are billed even when not returned, and `domain_rating` is already in the
  // select — so filtering by DR here is free rather than a hidden surcharge.
  if (opts.minDr && opts.minDr > 0) {
    rdParams.set("where", JSON.stringify({ and: [{ field: "domain_rating", is: ["gte", opts.minDr] }] }));
  }

  const [sRes, rRes] = await Promise.all([
    requestWithRetry(`${base}/v3/site-explorer/backlinks-stats?${statsParams}`, auth, creds.apiKey),
    requestWithRetry(`${base}/v3/site-explorer/refdomains?${rdParams}`, auth, creds.apiKey),
  ]);

  if (!rRes.ok) {
    return { items: [], units: 0, error: `ahrefs ${rRes.status}: ${(await rRes.text()).slice(0, 300)}` };
  }

  const stats = sRes.ok ? ((await sRes.json())?.metrics ?? {}) : {};
  const rows: any[] = (await rRes.json())?.refdomains ?? [];

  const refDomains: RefDomainItem[] = rows.map(r => ({
    refDomain: String(r.domain ?? "").toLowerCase().replace(/^www\./, ""),
    dr: num(r.domain_rating),
    linksToTarget: num(r.links_to_target),
    dofollow: Number(r.dofollow_links ?? 0) > 0,
    firstSeen: String(r.first_seen ?? ""),
  })).filter(r => r.refDomain.includes("."));

  const live = num(stats?.live);
  const dofollowCount = refDomains.filter(r => r.dofollow).length;

  return {
    units: estimateProfileUnits(limit),
    items: [{
      refDomainsTotal: num(stats?.live_refdomains),
      backlinksTotal: live,
      // Computed from the rows we actually pulled, not from the whole profile — labelled as
      // such in the UI, because paying 5 units a row for the true figure is not worth it.
      dofollowPct: refDomains.length ? Math.round((dofollowCount / refDomains.length) * 100) : null,
      refDomains,
    }],
  };
}

export async function fetchBacklinkProfile(
  creds: MetricsCreds,
  domain: string,
  opts: { limit?: number; minDr?: number } = {},
): Promise<MetricsResult<BacklinkProfile>> {
  if (!creds.apiKey) return { items: [], units: 0, error: "no_key" };
  // Semrush charges 40 units a line for the same data against Ahrefs' 5. Rather than offer a
  // choice that is never the right one, this path is Ahrefs-only and says so.
  if (creds.provider === "semrush") return { items: [], units: 0, error: "provider_unsupported" };
  try {
    return await ahrefsProfile(creds, domain, opts);
  } catch (e: any) {
    return { items: [], units: 0, error: String(e?.message ?? e) };
  }
}

// ─── Competitors and their keywords ────────────────────────────────────────────

export interface CompetitorItem {
  domain: string;
  sharedKeywords: number | null;
  traffic: number | null;
}

export interface OrganicKeywordItem {
  keyword: string;
  position: number | null;
  volume: number | null;
  difficulty: number | null;
  url: string;
}

/**
 * `traffic` and `value` cost 10 units each here. `keywords_common` is 1, and it is the field
 * that actually orders the list usefully — a competitor sharing 4 000 keywords with you is
 * more relevant than one with more traffic and 12 keywords in common.
 */
const COMPETITOR_FIELDS = ["competitor_domain", "keywords_common", "keywords_competitor"];

export function estimateCompetitorUnits(limit: number): number {
  return estimateUnits("site-explorer/organic-competitors", COMPETITOR_FIELDS, limit);
}

export async function fetchOrganicCompetitors(
  creds: MetricsCreds,
  domain: string,
  opts: { limit?: number; country: string },
): Promise<MetricsResult<CompetitorItem>> {
  if (!creds.apiKey) return { items: [], units: 0, error: "no_key" };
  if (!normCountry(opts.country)) return { items: [], units: 0, error: "no_country" };
  if (creds.provider === "semrush") return semrushCompetitors(creds, domain, opts);
  return ahrefsCompetitors(creds, domain, opts);
}

async function ahrefsCompetitors(
  creds: MetricsCreds, domain: string, opts: { limit?: number; country: string },
): Promise<MetricsResult<CompetitorItem>> {
  const limit = Math.max(5, Math.min(100, opts.limit ?? 20));
  const base = (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
  const params = new URLSearchParams({
    target: domain, mode: "domain",
    country: normCountry(opts.country),
    date: new Date().toISOString().slice(0, 10),
    select: COMPETITOR_FIELDS.join(","),
    limit: String(limit),
    order_by: "keywords_common:desc",
  });

  try {
    const res = await requestWithRetry(
      `${base}/v3/site-explorer/organic-competitors?${params}`,
      { headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" } },
      creds.apiKey,
    );
    if (!res.ok) return { items: [], units: 0, error: `ahrefs ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const rows: any[] = (await res.json())?.competitors ?? [];
    return {
      units: estimateCompetitorUnits(limit),
      items: rows.map(r => ({
        domain: String(r.competitor_domain ?? "").toLowerCase().replace(/^www\./, ""),
        sharedKeywords: num(r.keywords_common),
        traffic: null,
      })).filter(c => c.domain.includes(".")),
    };
  } catch (e: any) {
    return { items: [], units: 0, error: String(e?.message ?? e) };
  }
}

/**
 * Semrush organic competitors — `domain_organic_organic`.
 *
 * 40 units/line against Ahrefs' ≈3, so this is the more expensive source for the same question.
 * Offered anyway rather than stubbed: a Semrush-only subscriber previously got nothing from this
 * screen, and 40 units (≈$0.0024) for a competitor that actually competes is a price worth quoting.
 * `Np` (common keywords) orders the list the same way Ahrefs' `keywords_common` does.
 */
async function semrushCompetitors(
  creds: MetricsCreds, domain: string, opts: { limit?: number; country: string },
): Promise<MetricsResult<CompetitorItem>> {
  const limit = Math.max(5, Math.min(100, opts.limit ?? 20));
  const base = (creds.baseUrl || DEFAULT_BASE_URL.semrush).replace(/\/+$/, "");
  const params = new URLSearchParams({
    type: "domain_organic_organic",
    key: creds.apiKey,
    domain,
    database: normCountry(opts.country),
    export_columns: "Dn,Np,Ot",
    display_limit: String(limit),
    display_sort: "np_desc",
  });

  try {
    const res = await requestWithRetry(`${base}/?${params}`, { headers: { Accept: "text/plain" } }, creds.apiKey);
    const text = await res.text();
    if (!res.ok || /^ERROR/i.test(text)) {
      return { items: [], units: 0, error: `semrush ${res.status}: ${text.slice(0, 300)}` };
    }
    const rows = parseSemrushCsv(text);
    return {
      // Billed per line actually returned, like every Semrush report in this module.
      units: SEMRUSH_COMPETITOR_UNITS_PER_ROW * rows.length,
      items: rows.map(r => ({
        domain: String(r["Domain"] ?? "").toLowerCase().replace(/^www\./, ""),
        sharedKeywords: num(r["Common Keywords"]),
        traffic: num(r["Organic Traffic"]),
      })).filter(c => c.domain.includes(".")),
    };
  } catch (e: any) {
    return { items: [], units: 0, error: String(e?.message ?? e) };
  }
}

// `volume` and `keyword_difficulty` are 10 units each. KD is optional for the same reason it is
// optional everywhere else: it roughly doubles the bill for a column you may not sort by.
const ORGANIC_KEYWORD_FIELDS = ["keyword", "best_position", "best_position_url", "volume"];

export function estimateOrganicKeywordUnits(limit: number, withDifficulty: boolean): number {
  const select = withDifficulty
    ? [...ORGANIC_KEYWORD_FIELDS, "keyword_difficulty"]
    : ORGANIC_KEYWORD_FIELDS;
  return estimateUnits("site-explorer/organic-keywords", select, limit);
}

/** The keywords a domain ranks for — run against a competitor, this is one half of a gap. */
export async function fetchOrganicKeywords(
  creds: MetricsCreds,
  domain: string,
  opts: { limit?: number; country: string; withDifficulty?: boolean; maxPosition?: number },
): Promise<MetricsResult<OrganicKeywordItem>> {
  if (!creds.apiKey) return { items: [], units: 0, error: "no_key" };
  if (!normCountry(opts.country)) return { items: [], units: 0, error: "no_country" };
  if (creds.provider === "semrush") return semrushOrganicKeywords(creds, domain, opts);
  return ahrefsOrganicKeywords(creds, domain, opts);
}

async function ahrefsOrganicKeywords(
  creds: MetricsCreds, domain: string, opts: { limit?: number; country: string; withDifficulty?: boolean; maxPosition?: number },
): Promise<MetricsResult<OrganicKeywordItem>> {
  const limit = Math.max(10, Math.min(1000, opts.limit ?? 200));
  const select = opts.withDifficulty
    ? [...ORGANIC_KEYWORD_FIELDS, "keyword_difficulty"]
    : [...ORGANIC_KEYWORD_FIELDS];

  const base = (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
  const params = new URLSearchParams({
    target: domain, mode: "domain",
    country: normCountry(opts.country),
    date: new Date().toISOString().slice(0, 10),
    select: select.join(","),
    limit: String(limit),
    order_by: "volume:desc",
  });
  // `best_position` is already selected, so filtering on it adds nothing to the bill.
  if (opts.maxPosition) {
    params.set("where", JSON.stringify({ and: [{ field: "best_position", is: ["lte", opts.maxPosition] }] }));
  }

  try {
    const res = await requestWithRetry(
      `${base}/v3/site-explorer/organic-keywords?${params}`,
      { headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" } },
      creds.apiKey,
    );
    if (!res.ok) return { items: [], units: 0, error: `ahrefs ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const rows: any[] = (await res.json())?.keywords ?? [];
    return {
      units: estimateOrganicKeywordUnits(limit, !!opts.withDifficulty),
      items: rows.map(r => ({
        keyword: String(r.keyword ?? "").trim().toLowerCase(),
        position: num(r.best_position),
        volume: num(r.volume),
        difficulty: num(r.keyword_difficulty),
        url: String(r.best_position_url ?? ""),
      })).filter(k => k.keyword),
    };
  } catch (e: any) {
    return { items: [], units: 0, error: String(e?.message ?? e) };
  }
}

/**
 * Semrush organic keywords — `domain_organic`.
 *
 * 10 units/line, the same rate Ahrefs charges, and `Kd` is in the report at no surcharge — so
 * unlike the Ahrefs path the `withDifficulty` flag does not change this price. Semrush has no
 * native "best position" filter; the `maxPosition` cap is applied client-side after the call.
 */
async function semrushOrganicKeywords(
  creds: MetricsCreds, domain: string, opts: { limit?: number; country: string; withDifficulty?: boolean; maxPosition?: number },
): Promise<MetricsResult<OrganicKeywordItem>> {
  const limit = Math.max(10, Math.min(1000, opts.limit ?? 200));
  const base = (creds.baseUrl || DEFAULT_BASE_URL.semrush).replace(/\/+$/, "");
  const params = new URLSearchParams({
    type: "domain_organic",
    key: creds.apiKey,
    domain,
    database: normCountry(opts.country),
    export_columns: "Ph,Po,Nq,Ur,Kd",
    display_limit: String(limit),
    display_sort: "nq_desc",
  });

  try {
    const res = await requestWithRetry(`${base}/?${params}`, { headers: { Accept: "text/plain" } }, creds.apiKey);
    const text = await res.text();
    if (!res.ok || /^ERROR/i.test(text)) {
      return { items: [], units: 0, error: `semrush ${res.status}: ${text.slice(0, 300)}` };
    }
    const rows = parseSemrushCsv(text);
    const seen = rows.map(r => ({
      keyword: (r["Keyword"] ?? "").trim().toLowerCase(),
      position: num(r["Position"]),
      volume: num(r["Search Volume"]),
      difficulty: num(r["Keyword Difficulty Index"] ?? r["Keyword Difficulty"]),
      url: String(r["Url"] ?? ""),
    })).filter(k => k.keyword);
    // Applied after the fetch: Semrush bills the rows it returns, so the cap cannot lower the cost,
    // but it can stop a 1000-row pull of top-3-only keywords from flooding the gap table. `position`
    // can be null when Semrush omits it; such rows are dropped under a cap, since a gap analysis
    // keyed on "top N" cannot place them anyway.
    const cap = opts.maxPosition;
    const capped = cap ? seen.filter(k => k.position != null && k.position > 0 && k.position <= cap) : seen;
    return {
      units: SEMRUSH_ORGANIC_KEYWORD_UNITS_PER_ROW * rows.length,
      items: capped,
    };
  } catch (e: any) {
    return { items: [], units: 0, error: String(e?.message ?? e) };
  }
}

// ─── Keyword ideas (expanding a seed) ──────────────────────────────────────────

/**
 * Expanding one seed into a list of real keywords with real volumes.
 *
 * This is the half of the picture the metrics module never had: `fetchKeywordMetrics` prices a
 * list you already own, while this one produces the list. Until it existed, the content tools
 * could only get a list from DataForSEO, which is why an Ahrefs subscriber writing an outline got
 * no keyword data at all.
 *
 * Returns the same {@link KeywordMetric} shape as an overview row, so callers cannot tell — and
 * should not care — whether a keyword arrived from a seed expansion or from a priced list.
 */
export interface IdeaOptions {
  country: string;
  limit?: number;
  withDifficulty?: boolean;
  mode?: IdeaMode;
  /** Ahrefs only: restrict matching-terms to question phrasings. */
  questionsOnly?: boolean;
  /** Ahrefs related-terms only: judge by the top 10 or the top 100 ranking pages. */
  viewFor?: "top_10" | "top_100";
}

const IDEA_LIMIT_MAX = 200;
const clampIdeaLimit = (n: number | undefined) => Math.max(10, Math.min(IDEA_LIMIT_MAX, n ?? 100));

async function ahrefsIdeas(
  creds: MetricsCreds, seed: string, opts: IdeaOptions,
): Promise<MetricsResult<KeywordMetric>> {
  const mode: IdeaMode = opts.mode === "related" ? "related" : "matching";
  const limit = clampIdeaLimit(opts.limit);
  const select = opts.withDifficulty ? [...IDEA_FIELDS_BASE, ...KEYWORD_FIELDS_KD] : [...IDEA_FIELDS_BASE];
  const units = estimateIdeaUnits(mode, limit, !!opts.withDifficulty);

  const base = (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
  const params = new URLSearchParams({
    select: select.join(","),
    country: normCountry(opts.country),
    keywords: seed,
    limit: String(limit),
    // `volume` is already selected, so ordering by it adds nothing to the bill — and without it
    // the API returns an arbitrary slice of the tail, which for a capped limit is the difference
    // between the 100 best ideas and 100 random ones.
    order_by: "volume:desc",
  });

  if (mode === "related") {
    params.set("terms", "all");
    params.set("view_for", opts.viewFor === "top_100" ? "top_100" : "top_10");
  } else {
    params.set("terms", opts.questionsOnly ? "questions" : "all");
    params.set("match_mode", "terms");
  }

  const res = await requestWithRetry(
    `${base}/v3/${mode === "related" ? "keywords-explorer/related-terms" : "keywords-explorer/matching-terms"}?${params}`,
    { headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" } },
    creds.apiKey,
  );
  if (!res.ok) {
    return { items: [], units: 0, error: `ahrefs ${res.status}: ${(await res.text()).slice(0, 300)}` };
  }

  const rows: any[] = (await res.json())?.keywords ?? [];
  // Billed on what came back, not on `limit`.
  //
  // `units` above is the ceiling the caller reserved against the cap — correct for that job, and
  // wrong to report as the outcome. Ahrefs charges for the rows it returns, and a thin seed
  // returns a handful of the two hundred asked for. Reporting the ceiling here made the refund in
  // `releaseUnusedUnits` compute `ceiling - ceiling = 0` and hand nothing back, which quietly
  // undid the whole reconciliation.
  const billed = rows.length
    ? estimateIdeaUnits(mode, rows.length, !!opts.withDifficulty)
    : AHREFS_UNIT_FLOOR;

  return {
    units: billed,
    items: rows.map(r => ({
      keyword: String(r.keyword ?? "").trim().toLowerCase(),
      volume: num(r.volume),
      difficulty: num(r.difficulty),
      // Ahrefs returns CPC in USD cents here, unlike the overview endpoint. Normalized so a
      // caller mixing both sources does not silently show one of them a hundred times too big.
      cpc: r.cpc == null ? null : (num(r.cpc) ?? 0) / 100,
      globalVolume: num(r.global_volume),
      parentTopic: r.parent_topic ? String(r.parent_topic) : null,
      intents: r.intents ? JSON.stringify(r.intents) : null,
      payload: r,
    })).filter(k => k.keyword),
  };
}

/**
 * Semrush broad match. One flat rate per returned line covers every column the report has,
 * including `Kd` — so unlike Ahrefs there is no cheaper variant to offer, and the KD toggle does
 * not change this price.
 */
async function semrushIdeas(
  creds: MetricsCreds, seed: string, opts: IdeaOptions,
): Promise<MetricsResult<KeywordMetric>> {
  const limit = clampIdeaLimit(opts.limit);
  const base = (creds.baseUrl || DEFAULT_BASE_URL.semrush).replace(/\/+$/, "");
  const params = new URLSearchParams({
    type: "phrase_fullsearch",
    key: creds.apiKey,
    phrase: seed,
    database: normCountry(opts.country),
    export_columns: "Ph,Nq,Cp,Co,Nr,Kd",
    display_limit: String(limit),
    display_sort: "nq_desc",
  });

  const res = await requestWithRetry(`${base}/?${params}`, { headers: { Accept: "text/plain" } }, creds.apiKey);
  const text = await res.text();
  if (!res.ok || /^ERROR/i.test(text)) {
    return { items: [], units: 0, error: `semrush ${res.status}: ${text.slice(0, 300)}` };
  }

  const rows = parseSemrushCsv(text);
  return {
    // Billed per line actually returned, so this is the real figure rather than the ceiling.
    units: SEMRUSH_IDEA_UNITS_PER_ROW * rows.length,
    items: rows.map(r => ({
      keyword: (r["Keyword"] ?? "").trim().toLowerCase(),
      volume: num(r["Search Volume"]),
      difficulty: num(r["Keyword Difficulty Index"] ?? r["Keyword Difficulty"]),
      cpc: num(r["CPC"]),
      globalVolume: null,
      parentTopic: null,
      intents: null,
      payload: r,
    })).filter(k => k.keyword),
  };
}

export async function fetchKeywordIdeas(
  creds: MetricsCreds, seed: string, opts: IdeaOptions,
): Promise<MetricsResult<KeywordMetric>> {
  if (!creds.apiKey) return { items: [], units: 0, error: "no_key" };
  if (!normCountry(opts.country)) return { items: [], units: 0, error: "no_country" };
  const s = seed.trim();
  if (!s) return { items: [], units: 0, error: "no_seed" };
  // Ahrefs takes the seed through a comma-separated parameter, so a comma cannot be expressed.
  if (creds.provider === "ahrefs" && s.includes(",")) return { items: [], units: 0, error: "bad_seed" };

  try {
    return creds.provider === "semrush"
      ? await semrushIdeas(creds, s, opts)
      : await ahrefsIdeas(creds, s, opts);
  } catch (e: any) {
    return { items: [], units: 0, error: String(e?.message ?? e) };
  }
}

// ─── Demand history ────────────────────────────────────────────────────────────

export interface VolumePoint { date: string; volume: number }

/**
 * Monthly search volume over time for one keyword. No premium fields, so this is the 50-unit
 * floor and nothing more — which is what makes it affordable to ask per decaying page.
 */
export async function fetchVolumeHistory(
  creds: MetricsCreds,
  keyword: string,
  opts: { country: string },
): Promise<MetricsResult<VolumePoint>> {
  if (!creds.apiKey) return { items: [], units: 0, error: "no_key" };
  if (!normCountry(opts.country)) return { items: [], units: 0, error: "no_country" };
  if (creds.provider === "semrush") return { items: [], units: 0, error: "provider_unsupported" };

  const base = (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
  // No `select`: this endpoint always returns date + volume and rejects nothing else.
  const params = new URLSearchParams({
    keyword,
    country: normCountry(opts.country),
  });

  try {
    const res = await requestWithRetry(
      `${base}/v3/keywords-explorer/volume-history?${params}`,
      { headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" } },
      creds.apiKey,
    );
    if (!res.ok) return { items: [], units: 0, error: `ahrefs ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const d = await res.json();
    const rows: any[] = d?.metrics ?? d?.volume_history ?? [];
    return {
      units: AHREFS_UNIT_FLOOR,
      items: rows
        .map(r => ({ date: String(r.date ?? "").slice(0, 10), volume: Number(r.volume ?? 0) }))
        .filter(p => p.date && Number.isFinite(p.volume)),
    };
  } catch (e: any) {
    return { items: [], units: 0, error: String(e?.message ?? e) };
  }
}

// ─── Semrush ───────────────────────────────────────────────────────────────────

/** Semrush answers CSV with `;` separators and no JSON option on the standard reports. */
function parseSemrushCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const head = lines[0].split(";");
  return lines.slice(1).map(line => {
    const cells = line.split(";");
    return Object.fromEntries(head.map((h, i) => [h.trim(), (cells[i] ?? "").trim()]));
  });
}

/**
 * `phrase_these` takes several keywords in one call. Semrush prices Keyword Difficulty at 50
 * units/line against Ahrefs' 10, so KD is deliberately not requested here — a caller that needs
 * it should be on Ahrefs, and the settings UI says so.
 */
async function semrushKeywords(
  creds: MetricsCreds,
  keywords: string[],
  opts: { country: string },
): Promise<MetricsResult<KeywordMetric>> {
  const usable = keywords.filter(Boolean);
  if (!usable.length) return { items: [], units: 0 };

  const base = (creds.baseUrl || DEFAULT_BASE_URL.semrush).replace(/\/+$/, "");
  const params = new URLSearchParams({
    type: "phrase_these",
    key: creds.apiKey,
    phrase: usable.join(";"),
    database: normCountry(opts.country),
    export_columns: "Ph,Nq,Cp,Co,Nr",
  });

  const res = await requestWithRetry(`${base}/?${params}`, { headers: { Accept: "text/plain" } }, creds.apiKey);
  const text = await res.text();
  if (!res.ok || /^ERROR/i.test(text)) {
    return { items: [], units: 0, error: `semrush ${res.status}: ${text.slice(0, 300)}` };
  }

  const rows = parseSemrushCsv(text);
  return {
    units: 10 * rows.length, // Keyword Overview: 10 units per line
    items: rows.map(r => ({
      keyword: r["Keyword"] ?? "",
      volume: num(r["Search Volume"]),
      difficulty: null,
      cpc: num(r["CPC"]),
      globalVolume: null,
      parentTopic: null,
      intents: null,
      payload: r,
    })).filter(k => k.keyword),
  };
}

async function semrushDomain(creds: MetricsCreds, domain: string): Promise<MetricsResult<DomainMetric>> {
  const base = (creds.baseUrl || DEFAULT_BASE_URL.semrush).replace(/\/+$/, "");
  const params = new URLSearchParams({
    type: "domain_ranks",
    key: creds.apiKey,
    domain,
    database: "us",
    export_columns: "Db,Dn,Rk,Or,Ot,Oc",
  });

  const res = await requestWithRetry(`${base}/?${params}`, { headers: { Accept: "text/plain" } }, creds.apiKey);
  const text = await res.text();
  if (!res.ok || /^ERROR/i.test(text)) {
    return { items: [], units: 0, error: `semrush ${res.status}: ${text.slice(0, 300)}` };
  }
  const r = parseSemrushCsv(text)[0] ?? {};
  return {
    units: 10,
    items: [{
      domain,
      dr: null,
      refDomains: null,
      backlinks: null,
      orgTraffic: num(r["Organic Traffic"]),
      orgKeywords: num(r["Organic Keywords"]),
      orgCost: num(r["Organic Cost"]),
      payload: r,
    }],
  };
}

// ─── Public surface ────────────────────────────────────────────────────────────

export async function fetchKeywordMetrics(
  creds: MetricsCreds,
  keywords: string[],
  opts: { country: string; withDifficulty?: boolean },
): Promise<MetricsResult<KeywordMetric>> {
  if (!creds.apiKey) return { items: [], units: 0, error: "no_key" };
  if (!normCountry(opts.country)) return { items: [], units: 0, error: "no_country" };
  try {
    return creds.provider === "semrush"
      ? await semrushKeywords(creds, keywords, opts)
      : await ahrefsKeywords(creds, keywords, opts);
  } catch (e: any) {
    return { items: [], units: 0, error: String(e?.message ?? e) };
  }
}

export async function fetchDomainMetrics(
  creds: MetricsCreds,
  domain: string,
): Promise<MetricsResult<DomainMetric>> {
  if (!creds.apiKey) return { items: [], units: 0, error: "no_key" };
  try {
    return creds.provider === "semrush"
      ? await semrushDomain(creds, domain)
      : await ahrefsDomain(creds, domain);
  } catch (e: any) {
    return { items: [], units: 0, error: String(e?.message ?? e) };
  }
}
