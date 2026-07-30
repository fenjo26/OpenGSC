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

const num = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

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
  opts: { country?: string; withDifficulty?: boolean },
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
    country: (opts.country || "us").toLowerCase(),
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
  opts: { limit?: number; country?: string } = {},
): Promise<MetricsResult<CompetitorItem>> {
  if (!creds.apiKey) return { items: [], units: 0, error: "no_key" };
  if (creds.provider === "semrush") return { items: [], units: 0, error: "provider_unsupported" };

  const limit = Math.max(5, Math.min(100, opts.limit ?? 20));
  const base = (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
  const params = new URLSearchParams({
    target: domain, mode: "domain",
    country: (opts.country || "us").toLowerCase(),
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
  opts: { limit?: number; country?: string; withDifficulty?: boolean; maxPosition?: number } = {},
): Promise<MetricsResult<OrganicKeywordItem>> {
  if (!creds.apiKey) return { items: [], units: 0, error: "no_key" };
  if (creds.provider === "semrush") return { items: [], units: 0, error: "provider_unsupported" };

  const limit = Math.max(10, Math.min(1000, opts.limit ?? 200));
  const select = opts.withDifficulty
    ? [...ORGANIC_KEYWORD_FIELDS, "keyword_difficulty"]
    : [...ORGANIC_KEYWORD_FIELDS];

  const base = (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
  const params = new URLSearchParams({
    target: domain, mode: "domain",
    country: (opts.country || "us").toLowerCase(),
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

// ─── Demand history ────────────────────────────────────────────────────────────

export interface VolumePoint { date: string; volume: number }

/**
 * Monthly search volume over time for one keyword. No premium fields, so this is the 50-unit
 * floor and nothing more — which is what makes it affordable to ask per decaying page.
 */
export async function fetchVolumeHistory(
  creds: MetricsCreds,
  keyword: string,
  opts: { country?: string } = {},
): Promise<MetricsResult<VolumePoint>> {
  if (!creds.apiKey) return { items: [], units: 0, error: "no_key" };
  if (creds.provider === "semrush") return { items: [], units: 0, error: "provider_unsupported" };

  const base = (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
  // No `select`: this endpoint always returns date + volume and rejects nothing else.
  const params = new URLSearchParams({
    keyword,
    country: (opts.country || "us").toLowerCase(),
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
  opts: { country?: string },
): Promise<MetricsResult<KeywordMetric>> {
  const usable = keywords.filter(Boolean);
  if (!usable.length) return { items: [], units: 0 };

  const base = (creds.baseUrl || DEFAULT_BASE_URL.semrush).replace(/\/+$/, "");
  const params = new URLSearchParams({
    type: "phrase_these",
    key: creds.apiKey,
    phrase: usable.join(";"),
    database: (opts.country || "us").toLowerCase(),
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
  opts: { country?: string; withDifficulty?: boolean } = {},
): Promise<MetricsResult<KeywordMetric>> {
  if (!creds.apiKey) return { items: [], units: 0, error: "no_key" };
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
