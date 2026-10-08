// Third-party SEO metrics (Ahrefs / Semrush / Majestic / Keys.so) behind one call surface,
// mirroring the shape of `src/lib/llm.ts`: several providers, one signature, retries and
// normalization in one place. Keyword data exists on Ahrefs and Semrush only; Majestic and
// Keys.so serve the backlink/domain side and answer keyword calls with `provider_unsupported`
// rather than a wrong request (Keys.so's keywords are Yandex's — a different market).
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

import { loggedFetch } from "@/lib/providerLog/log";

import {
  AHREFS_UNIT_FLOOR, DEFAULT_BASE_URL, DOMAIN_UNITS, IDEA_FIELDS_BASE, KEYWORD_FIELDS_BASE, KEYWORD_FIELDS_KD,
  MAJESTIC_REFDOMAIN_ANALYSIS_UNITS, MAJESTIC_REFDOMAIN_PAGE_SIZE, MAJESTIC_STATS_UNITS,
  SEMRUSH_BACKLINKS_OVERVIEW_UNITS, SEMRUSH_BACKLINKS_UNITS_PER_ROW,
  SEMRUSH_COMPETITOR_UNITS_PER_ROW, SEMRUSH_IDEA_UNITS_PER_ROW, SEMRUSH_ORGANIC_KEYWORD_UNITS_PER_ROW,
  COMPETITOR_FIELDS, ORGANIC_KEYWORD_FIELDS, REFDOMAIN_FIELDS,
  estimateCompetitorUnits, estimateIdeaUnits, estimateOrganicKeywordUnits, estimateUnits,
  gatewayStatusFromError, ideaEndpoint, isKeywordCapable, parseKeyssoBase,
  KEYSSO_REFDOMAIN_PAGE_SIZE, KEYSSO_STATS_UNITS,
  type IdeaMode, type MetricsCreds, type MetricsProvider, type SubscriptionInfo,
} from "./metricsPricing";
import {
  keyssoErrorText, keyssoNextStep, keyssoRemainingCredits, mapKeyssoAiAnswer, mapKeyssoAiCompetitor,
  mapKeyssoDashboard, mapKeyssoRefDomain, parseKeyssoEnvelope, keyssoBacklinkToExportRow,
  mapKeyssoDirectAd, mapKeyssoDirectKeyword, type KeyssoDirectAd, type KeyssoDirectKeyword,
  mapKeyssoKeyword, type KeyssoKeyword,
  type KeyssoAiAnswer, type KeyssoAiCompetitor,
} from "./keyssoParse";

// The prices live next door so the browser can quote them without importing this module's
// network half — see the header of `metricsPricing.ts`. Re-exported wholesale, so every
// server-side `from "@/lib/seo/metrics"` keeps resolving exactly what it always did.
export * from "./metricsPricing";


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

async function withSlot<T>(key: string, fn: () => Promise<T>, max = MAX_IN_FLIGHT): Promise<T> {
  const pool = poolFor(key);
  if (pool.active >= max) {
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
async function requestWithRetry(
  url: string, init: RequestInit, poolKey: string, provider: MetricsProvider,
): Promise<Response> {
  let lastErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // One row per attempt, numbered. Each attempt is a request the gateway answered, and the
      // comment above is the reason it matters: a retried 429 still cost a round trip.
      //
      // The row is closed here rather than by the caller. Fifteen call sites read this response
      // in as many shapes — JSON, CSV, plain text — and neither gateway states a price or a
      // token count in any of them, so everything a row will ever know is known at the status.
      const { res, call } = await withSlot(poolKey, () =>
        loggedFetch(url, { ...init, signal: AbortSignal.timeout(45_000) }, { provider, attempt: attempt + 1 }),
      );
      if (res.status === 429 || res.status >= 500) {
        call.finish({ error: `${provider} ${res.status}` });
        if (attempt === 2) return res;
        await sleep(800 * 2 ** attempt + Math.random() * 400);
        continue;
      }
      call.finish(res.ok ? undefined : { error: `${provider} ${res.status}` });
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === 2) break;
      await sleep(800 * 2 ** attempt + Math.random() * 400);
    }
  }
  throw lastErr ?? new Error("request_failed");
}

// ─── Subscription balance (free endpoint) ──────────────────────────────────────

export interface SubscriptionResult {
  info: SubscriptionInfo | null;
  /** HTTP status the gateway answered with; 0 when the request never completed. */
  status: number;
  error?: string;
}

/**
 * `/v3/subscription-info/limits-and-usage` costs 0 units and is the only honest source for
 * "how much is left": our own `ApiUsage` counter is an estimate that refunds on failure and
 * cannot see top-ups made directly at the gateway. Cached in-process for 10 minutes — free, but
 * a placard that re-asks on every render still spends a round-trip and a semaphore slot.
 *
 * Successes are cached, failures are not: a 401 cached for ten minutes would keep showing
 * "key rejected" after the user has just fixed the key, which is the one screen where they
 * would definitely re-check immediately.
 */
const SUBSCRIPTION_TTL_MS = 10 * 60 * 1000;
const subscriptionCache = new Map<string, { at: number; info: SubscriptionInfo }>();

export async function fetchSubscriptionInfo(creds: MetricsCreds): Promise<SubscriptionResult> {
  if (!creds.apiKey) return { info: null, status: 0, error: "no_key" };
  if (creds.provider === "keysso") return keyssoSubscription(creds);
  // Semrush's protocol has no equivalent report; Majestic's `GetSubscriptionInfo` reports the
  // pooled upstream plan, deliberately not the caller's own credit ledger. Both fall back to
  // our own estimate rather than quote somebody else's wallet.
  if (creds.provider !== "ahrefs") return { info: null, status: 0, error: "provider_unsupported" };

  const base = (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
  const cacheKey = `${creds.apiKey}|${base}`;
  const hit = subscriptionCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SUBSCRIPTION_TTL_MS) return { info: hit.info, status: 200 };

  let res: Response;
  try {
    res = await requestWithRetry(
      `${base}/v3/subscription-info/limits-and-usage`,
      { headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" } },
      creds.apiKey, creds.provider,
    );
  } catch (e: any) {
    return { info: null, status: 0, error: String(e?.message ?? e) };
  }
  if (!res.ok) {
    return { info: null, status: res.status, error: `ahrefs ${res.status}: ${(await res.text()).slice(0, 300)}` };
  }

  const d = await res.json().catch(() => null);
  // The gateway wraps reports in a top-level key like every list endpoint; accepting a flat
  // body too costs nothing and keeps a wrapper rename from reading as "no balance available".
  const s = d?.subscription_info ?? d?.limits_and_usage ?? d ?? {};
  const info: SubscriptionInfo = {
    unitsLimitApiKey: num(s.units_limit_api_key),
    unitsUsageApiKey: num(s.units_usage_api_key),
    unitsLimitWorkspace: num(s.units_limit_workspace),
    unitsUsageWorkspace: num(s.units_usage_workspace),
    usageResetDate: String(s.usage_reset_date ?? "").slice(0, 10),
    apiKeyExpirationDate: String(s.api_key_expiration_date ?? "").slice(0, 10),
    fetchedAt: new Date().toISOString(),
  };
  subscriptionCache.set(cacheKey, { at: Date.now(), info });
  return { info, status: 200 };
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

  const base = (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
  const params = new URLSearchParams({
    select: select.join(","),
    country: normCountry(opts.country),
    keywords: usable.join(","),
  });

  const res = await requestWithRetry(
    `${base}/v3/keywords-explorer/overview?${params}`,
    { headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" } },
    creds.apiKey, creds.provider,
  );
  if (!res.ok) {
    return { items: [], units: 0, error: `ahrefs ${res.status}: ${(await res.text()).slice(0, 300)}` };
  }

  // Every Ahrefs list endpoint answers with one top-level object keyed by report name.
  const data = await res.json();
  const rows: any[] = Array.isArray(data?.keywords) ? data.keywords : [];

  // Billed on the rows that came back, not the keywords asked for — the same reconciliation
  // `ahrefsIdeas` does. A keyword the provider has never seen simply does not arrive, and
  // reporting the reservation here would make the caller's refund compute ceiling − ceiling = 0.
  const billed = estimateUnits("keywords-explorer/overview", select, rows.length);

  return {
    units: billed,
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
 * would cost 4 000 units per page view. (`DOMAIN_UNITS` — the Ahrefs price this makes constant —
 * lives in `metricsPricing.ts` now, beside `domainUnits()`, which prices the other providers.)
 *
 * DR is deliberately absent. It already arrives free through `/api/dr` and the public
 * domain-rating endpoint, which needs no key and works for every user; buying it again here
 * would charge people for a number they already have.
 */
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
      auth, creds.apiKey, creds.provider,
    ),
    requestWithRetry(
      `${base}/v3/site-explorer/backlinks-stats?${new URLSearchParams({ target: domain, mode: "domain", date })}`,
      auth, creds.apiKey, creds.provider,
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
  /** Majestic-only extras: Citation Flow, the donor's top Topical Trust Flow topic, its IP. */
  cf?: number | null;
  topic?: string;
  ip?: string;
}

export interface BacklinkProfile {
  refDomainsTotal: number | null;
  backlinksTotal: number | null;
  dofollowPct: number | null;
  refDomains: RefDomainItem[];
}

/** One refdomains page. A full profile pull is several of these — there is no row ceiling. */
export const REFDOMAIN_PAGE_SIZE = 1000;

/**
 * Params for one refdomains page. The first page keeps the DR-descending order the table shows;
 * keyset pages must order by the cursor instead. `domain` is already in the select, so the
 * keyset cursor adds nothing to the bill, and neither does a DR filter on `domain_rating`.
 * Pure — unit-tested without a network.
 */
export function refdomainsPageParams(q: {
  target: string; limit: number; minDr?: number; offset?: number; afterDomain?: string;
}): URLSearchParams {
  const params = new URLSearchParams({
    target: q.target, mode: "domain", limit: String(q.limit),
    select: REFDOMAIN_FIELDS.join(","),
    order_by: q.afterDomain !== undefined ? "domain:asc" : "domain_rating:desc",
  });
  const conds: Array<{ field: string; is: unknown[] }> = [];
  if (q.afterDomain !== undefined) conds.push({ field: "domain", is: ["gt", q.afterDomain] });
  if (q.minDr && q.minDr > 0) conds.push({ field: "domain_rating", is: ["gte", q.minDr] });
  if (conds.length) params.set("where", JSON.stringify({ and: conds }));
  if (q.offset) params.set("offset", String(q.offset));
  return params;
}

export interface BacklinkStatsTotals {
  refDomainsTotal: number | null;
  backlinksTotal: number | null;
}

/**
 * The floored `backlinks-stats` call on its own. Split out so the route can price the whole pull
 * from the real domain count before a single refdomains page is spent, and hand the same answer
 * to `fetchBacklinkProfile` — paying for stats twice to save a function argument is not a trade.
 *
 * Provider-aware: Majestic answers the same question from a one-item `GetIndexItemInfo` (1 unit
 * against Ahrefs' 50), whose `raw` is the Results row itself.
 */
export async function fetchBacklinkStats(
  creds: MetricsCreds,
  domain: string,
): Promise<{ ok: true; raw: any; totals: BacklinkStatsTotals } | { ok: false; error: string }> {
  if (creds.provider === "majestic") {
    const r = await majesticItemInfo(creds, [domain]);
    if (!r.items.length) return { ok: false, error: r.error ?? "majestic empty" };
    const row = r.items[0];
    return {
      ok: true,
      raw: row.raw,
      totals: { refDomainsTotal: row.refDomains, backlinksTotal: row.backlinks },
    };
  }
  if (creds.provider === "keysso") return keyssoBacklinkStats(creds, domain);
  if (creds.provider === "semrush") {
    const r = await semrushBacklinksCall(creds, {
      type: "backlinks_overview", target: domain, target_type: "root_domain",
    });
    if (r.error) return { ok: false, error: r.error };
    const row = r.rows[0] ?? {};
    return {
      ok: true,
      raw: row,
      totals: {
        refDomainsTotal: num(mjPick(row, "refdomains", "referring_domains", "domains_num")),
        backlinksTotal: num(mjPick(row, "backlinks", "total_backlinks", "links_num")),
      },
    };
  }
  const base = (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
  const auth = { headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" } };
  const date = new Date().toISOString().slice(0, 10);
  // No `select` here — backlinks-stats always returns all four of
  // all_time / all_time_refdomains / live / live_refdomains.
  const params = new URLSearchParams({ target: domain, mode: "domain", date });
  const res = await requestWithRetry(`${base}/v3/site-explorer/backlinks-stats?${params}`, auth, creds.apiKey, creds.provider);
  if (!res.ok) return { ok: false, error: `ahrefs ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const metrics = (await res.json())?.metrics ?? {};
  return {
    ok: true,
    raw: metrics,
    totals: { refDomainsTotal: num(metrics?.live_refdomains), backlinksTotal: num(metrics?.live) },
  };
}

/** Offset support is a gateway property, not a profile property — probed once per host per day. */
const refdomainsModeCache = new Map<string, { mode: "offset" | "keyset"; at: number }>();
const REFDOMAINS_MODE_CACHE_MS = 24 * 3600 * 1000;

async function ahrefsProfile(
  creds: MetricsCreds,
  domain: string,
  opts: { minDr?: number; stats?: any } = {},
): Promise<MetricsResult<BacklinkProfile> & { sawEnd?: boolean; unitsSpent?: number }> {
  const base = (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
  const auth = { headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" } };

  let stats = opts.stats ?? null;
  if (!stats) {
    const s = await fetchBacklinkStats(creds, domain);
    if (!s.ok) return { items: [], units: 0, error: s.error, unitsSpent: 0 };
    stats = s.raw;
  }
  // One floored stats call was spent on this pull, whoever fetched it.
  let unitsSpent = AHREFS_UNIT_FLOOR;

  const pageCost = (rows: number) =>
    estimateUnits("site-explorer/refdomains", REFDOMAIN_FIELDS, rows);

  const refDomains: RefDomainItem[] = [];
  const seen = new Set<string>();
  const addPage = (rawRows: any[]): number => {
    let added = 0;
    for (const r of rawRows) {
      const refDomain = String(r.domain ?? "").toLowerCase().replace(/^www\./, "");
      if (!refDomain.includes(".") || seen.has(refDomain)) continue;
      seen.add(refDomain);
      refDomains.push({
        refDomain,
        dr: num(r.domain_rating),
        linksToTarget: num(r.links_to_target),
        dofollow: Number(r.dofollow_links ?? 0) > 0,
        firstSeen: String(r.first_seen ?? ""),
      });
      added++;
    }
    return added;
  };

  const fetchPage = async (params: URLSearchParams) => {
    const res = await requestWithRetry(`${base}/v3/site-explorer/refdomains?${params}`, auth, creds.apiKey, creds.provider);
    if (!res.ok) return { ok: false as const, error: `ahrefs ${res.status}: ${(await res.text()).slice(0, 300)}` };
    return { ok: true as const, rows: ((await res.json())?.refdomains ?? []) as any[] };
  };

  // Paging only matters when the profile is bigger than one page. When it is, probe the gateway
  // first (two ten-row calls, one floor each) so a keyset gateway never pays for a DR-ordered
  // page it then has to re-fetch in cursor order. Same verdict rule as the all-backlinks probe
  // in backlinksApi.ts: an honored offset can never revisit a row, so any overlap between the
  // two windows means offset was ignored. Restated here rather than imported — backlinksApi
  // imports this module, and the cycle would bite both.
  const total = num(stats?.live_refdomains);
  let mode: "offset" | "keyset" | null = null;
  const cached = refdomainsModeCache.get(base);
  if (cached && Date.now() - cached.at < REFDOMAINS_MODE_CACHE_MS) mode = cached.mode;

  if ((total == null || total > REFDOMAIN_PAGE_SIZE) && !mode) {
    const probeParams = (offset: number) => new URLSearchParams({
      target: domain, mode: "domain", limit: "10", offset: String(offset),
      select: "domain", order_by: "domain:asc",
    });
    const keyOf = (rows: any[]) => rows.map(r => String(r.domain ?? "").toLowerCase()).filter(Boolean);
    const a = await fetchPage(probeParams(0));
    // Only a definitive answer is cached for the day: a 400 means the gateway does not know
    // `offset`, a clean comparison means it does. A transient 5xx or a 429 says nothing about
    // offset support, and caching it would lock the wrong mode in for 24 hours.
    if (!a.ok) {
      mode = "keyset";
      if (gatewayStatusFromError(a.error) === 400) refdomainsModeCache.set(base, { mode, at: Date.now() });
    } else {
      unitsSpent += AHREFS_UNIT_FLOOR;
      const b = await fetchPage(probeParams(10));
      if (!b.ok) {
        mode = "keyset";
        if (gatewayStatusFromError(b.error) === 400) refdomainsModeCache.set(base, { mode, at: Date.now() });
      } else {
        unitsSpent += AHREFS_UNIT_FLOOR;
        const k1 = keyOf(a.rows), k2 = keyOf(b.rows);
        mode = k2.length && k1.some(d => k2.includes(d)) ? "keyset" : "offset";
        refdomainsModeCache.set(base, { mode, at: Date.now() });
      }
    }
  }

  // Page until the profile ends. `sawEnd` is what makes the pull complete: only a run that saw
  // the last row may conclude that an absent domain is gone.
  let sawEnd = false;
  let partialError = "";
  let offset = 0;
  // In keyset mode even the first page goes out in cursor order: `domain > ""` matches every
  // domain, and starting from a DR-ordered page would key the cursor off a row that is not the
  // alphabetically last one, silently dropping everything after it.
  let afterDomain: string | undefined = mode === "keyset" ? "" : undefined;
  for (;;) {
    const p = await fetchPage(refdomainsPageParams({
      target: domain, limit: REFDOMAIN_PAGE_SIZE, minDr: opts.minDr, offset: offset || undefined, afterDomain,
    }));
    if (!p.ok) {
      if (refDomains.length === 0) return { items: [], units: unitsSpent, error: p.error, unitsSpent };
      partialError = p.error; // keep the pages already paid for, marked incomplete
      break;
    }
    unitsSpent += pageCost(p.rows.length);
    if (!p.rows.length) { sawEnd = true; break; }
    const added = addPage(p.rows);
    if (mode === "keyset") {
      const last = String(p.rows[p.rows.length - 1].domain ?? "").toLowerCase();
      if (last === afterDomain) break; // cursor not advancing — stop rather than re-bill the page
      afterDomain = last;
      if (added === 0 && p.rows.length >= REFDOMAIN_PAGE_SIZE) break; // safety: full page, nothing new
    } else {
      if (p.rows.length < REFDOMAIN_PAGE_SIZE) { sawEnd = true; break; }
      if (added === 0) break; // offset drifting in place — same guard as above
      offset += REFDOMAIN_PAGE_SIZE;
    }
  }

  const live = num(stats?.live);
  const dofollowCount = refDomains.filter(r => r.dofollow).length;

  const result: MetricsResult<BacklinkProfile> & { sawEnd?: boolean; unitsSpent?: number } = {
    units: unitsSpent,
    unitsSpent,
    sawEnd,
    items: [{
      refDomainsTotal: total,
      backlinksTotal: live,
      // Computed from the rows we actually pulled, not from the whole profile — labelled as
      // such in the UI, because paying 5 units a row for the true figure is not worth it.
      dofollowPct: refDomains.length ? Math.round((dofollowCount / refDomains.length) * 100) : null,
      refDomains,
    }],
  };
  if (partialError) result.error = partialError;
  return result;
}

export async function fetchBacklinkProfile(
  creds: MetricsCreds,
  domain: string,
  opts: { minDr?: number; stats?: any } = {},
): Promise<MetricsResult<BacklinkProfile> & { sawEnd?: boolean; unitsSpent?: number }> {
  if (!creds.apiKey) return { items: [], units: 0, error: "no_key" };
  try {
    return creds.provider === "majestic"
      ? await majesticProfile(creds, domain, opts)
      : creds.provider === "keysso"
        ? await keyssoProfile(creds, domain, opts)
      : creds.provider === "semrush"
        ? await semrushProfile(creds, domain, opts)
        : await ahrefsProfile(creds, domain, opts);
  } catch (e: any) {
    return { items: [], units: 0, error: String(e?.message ?? e) };
  }
}

// ─── Semrush backlinks (/analytics/v1/ reports) ────────────────────────────────
//
// The gateway's backlinks product is what unblocked this provider here: backlinks_overview,
// backlinks and backlinks_refdomains all answer on the same host and key as the SEO reports.
// At 40 units a line it is by far the most expensive profile source (≈10× Ahrefs, three orders
// of magnitude above Majestic) — the estimate functions quote that honestly, and the monthly
// cap is the real guard. It exists for Semrush-only subscribers, the same reason the keyword
// gap grew a Semrush path.

const SEMRUSH_BACKLINKS_PAGE_SIZE = 1000;

/**
 * One /analytics/v1/ call. The official host answers in JSON, the reseller gateway in CSV —
 * both are accepted: read as text, parsed as JSON when it opens with `{`, CSV otherwise.
 * The gateway's numeric ERROR codes are restated in HTTP vocabulary so every existing
 * diagnosis chain keeps working (401 bad key, 132 not enough units → 402); `ERROR 50 ::
 * NOTHING FOUND` is not an error but an empty profile — a new domain with no links is a
 * valid answer, the same conclusion `/api/dr` draws.
 */
async function semrushBacklinksCall(
  creds: MetricsCreds,
  params: Record<string, string>,
): Promise<{ rows: Record<string, any>[]; total: number | null; error?: string }> {
  const base = (creds.baseUrl || DEFAULT_BASE_URL.semrush).replace(/\/+$/, "");
  const search = new URLSearchParams({ key: creds.apiKey, ...params });
  const res = await requestWithRetry(
    `${base}/analytics/v1/?${search}`,
    { headers: { Accept: "text/plain, application/json" } },
    creds.apiKey, creds.provider,
  );
  const text = (await res.text()).trim();
  if (!res.ok) return { rows: [], total: null, error: `semrush ${res.status}: ${text.slice(0, 300)}` };
  if (/^ERROR/i.test(text)) {
    const code = /^ERROR\s*(\d+)/i.exec(text)?.[1] ?? "";
    const status = code === "401" ? 401 : code === "132" ? 402 : code === "50" ? 200 : 400;
    if (status === 200) return { rows: [], total: 0 }; // nothing found = empty profile
    return { rows: [], total: null, error: `semrush ${status}: ${text.slice(0, 300)}` };
  }
  if (text.startsWith("{")) {
    try {
      const d = JSON.parse(text);
      const rows = d?.data ?? d?.backlinks ?? d?.refdomains ?? d?.rows;
      return { rows: Array.isArray(rows) ? rows : [], total: num(d?.total) };
    } catch { /* fall through to CSV */ }
  }
  const rows = parseSemrushCsv(text);
  return { rows, total: null };
}

/**
 * Semrush referring domains — `backlinks_refdomains`, paged with display_offset at 1000 rows
 * a call and billed 40 units per row returned. Authority Score lands in the `dr` slot of
 * {@link RefDomainItem} (the UI labels the column AS); the report carries no nofollow flag,
 * so `dofollowPct` stays null rather than a fabricated figure.
 */
async function semrushProfile(
  creds: MetricsCreds,
  domain: string,
  opts: { minDr?: number; stats?: any } = {},
): Promise<MetricsResult<BacklinkProfile> & { sawEnd?: boolean; unitsSpent?: number }> {
  let stats = opts.stats ?? null;
  if (!stats) {
    const s = await fetchBacklinkStats(creds, domain);
    if (!s.ok) return { items: [], units: 0, error: s.error, unitsSpent: 0 };
    stats = s.raw;
  }
  // The flat overview call this pull was priced from was spent once, whoever made it.
  let unitsSpent = SEMRUSH_BACKLINKS_OVERVIEW_UNITS;

  const refDomains: RefDomainItem[] = [];
  const seen = new Set<string>();
  const minDr = opts.minDr && opts.minDr > 0 ? opts.minDr : 0;

  let sawEnd = false;
  let partialError = "";
  let offset = 0;
  for (;;) {
    const res = await semrushBacklinksCall(creds, {
      type: "backlinks_refdomains",
      target: domain,
      target_type: "root_domain",
      display_limit: String(SEMRUSH_BACKLINKS_PAGE_SIZE),
      ...(offset ? { display_offset: String(offset) } : {}),
    });
    if (res.error) {
      if (refDomains.length === 0) return { items: [], units: unitsSpent, error: res.error, unitsSpent };
      partialError = res.error; // keep the pages already paid for, marked incomplete
      break;
    }
    const rows = res.rows;
    unitsSpent += SEMRUSH_BACKLINKS_UNITS_PER_ROW * rows.length;
    if (!rows.length) { sawEnd = true; break; }

    let added = 0;
    for (const r of rows) {
      const refDomain = String(mjPick(r, "source_domain", "domain", "refdomain") ?? "")
        .toLowerCase().replace(/^www\./, "");
      if (!refDomain.includes(".") || seen.has(refDomain)) continue;
      const as = num(mjPick(r, "domain_ascore", "ascore", "authority_score"));
      if (minDr && (as == null || as < minDr)) continue;
      seen.add(refDomain);
      refDomains.push({
        refDomain,
        dr: as,
        linksToTarget: num(mjPick(r, "backlinks_num", "backlinks")),
        dofollow: true,
        firstSeen: String(mjPick(r, "first_seen") ?? ""),
        ip: String(mjPick(r, "ip") ?? ""),
      });
      added++;
    }
    if (rows.length < SEMRUSH_BACKLINKS_PAGE_SIZE) { sawEnd = true; break; }
    if (added === 0) break; // offset drifting in place — same guard as the other loops
    offset += SEMRUSH_BACKLINKS_PAGE_SIZE;
  }

  const total = num(mjPick(stats, "refdomains", "referring_domains", "domains_num"));
  const live = num(mjPick(stats, "backlinks", "total_backlinks", "links_num"));

  const result: MetricsResult<BacklinkProfile> & { sawEnd?: boolean; unitsSpent?: number } = {
    units: unitsSpent,
    unitsSpent,
    sawEnd,
    items: [{
      refDomainsTotal: total,
      backlinksTotal: live,
      dofollowPct: null, // not in this report — null beats a fabricated 100%
      refDomains,
    }],
  };
  if (partialError) result.error = partialError;
  return result;
}

// ─── Majestic ──────────────────────────────────────────────────────────────────
//
// The third provider, and the first that does not speak either of the other two protocols. It
// is command-oriented: one URL, `cmd` and `app_api_key` in the query string, and a
// `{ Code, DataTables }` envelope where failure often arrives dressed as HTTP 200. Two rules
// follow from that and both are load-bearing:
//
// 1. The envelope's `Code` — not the HTTP status — decides success. `mjError` restates envelope
//    failures in HTTP vocabulary (`majestic 401: Invalid API key`) so everything downstream that
//    diagnoses by `gatewayStatusFromError` keeps working without a Majestic branch.
// 2. Row fields are read case-insensitively through `mjPick`, because Majestic has renamed
//    columns across its own history and the web-adapted gateway is not obliged to match the
//    official snapshots the docs were written from.

/** Fresh Index, not the historic default. This is the Majestic counterpart of Ahrefs' "live"
 *  figures the profile screens are built around; the historic index would count links the
 *  target lost years ago and read as a permanently wrong refdomain total. */
const MAJESTIC_DATASOURCE = "fresh";

/** Read one row field across the names it has shipped under, case-insensitively. */
function mjPick(row: Record<string, any>, ...names: string[]): any {
  const lower = new Map(Object.keys(row).map(k => [k.toLowerCase(), k]));
  for (const n of names) {
    const k = lower.get(n.toLowerCase());
    if (k != null && row[k] !== "" && row[k] != null) return row[k];
  }
  return null;
}

/**
 * Read a per-target dynamic field. `GetRefDomains` names several of its columns after the
 * requested item — the link count for the queried target arrives as `BackLinks_<target>`, the
 * first-seen date as `FirstLinkDate_<target>` — so exact names cannot be known in advance.
 * Matched case-insensitively by prefix; the profile pull requests one item per call, so the
 * first hit is the one.
 */
function mjPickPrefix(row: Record<string, any>, prefix: string): any {
  const p = prefix.toLowerCase();
  for (const k of Object.keys(row)) {
    if (k.toLowerCase().startsWith(p) && row[k] !== "" && row[k] != null) return row[k];
  }
  return null;
}

/** Rows of a named DataTable. The docs pin table names per cmd (`Results`, `BackLinks`, …);
 *  matching without case costs nothing and survives a rename. */
function mjTable(d: any, ...names: string[]): Record<string, any>[] {
  const tables = d?.DataTables ?? {};
  const wanted = names.map(n => n.toLowerCase());
  for (const key of Object.keys(tables)) {
    if (wanted.includes(key.toLowerCase()) && Array.isArray(tables[key]?.Data)) return tables[key].Data;
  }
  return [];
}

function mjError(d: any): string | null {
  if (!d || d.Code === "OK") return null;
  const msg = String(d.ErrorMessage ?? d.FullError ?? "error").slice(0, 300);
  if (/invalid/i.test(msg) && /key/i.test(msg)) return `majestic 401: ${msg}`;
  if (/notenoughunits|insufficient/i.test(msg)) return `majestic 402: ${msg}`;
  return `majestic 400: ${msg}`;
}

/** One command call. Auth rides in the query — Majestic's convention, not a header. */
async function majesticCall(
  creds: MetricsCreds,
  params: Record<string, string>,
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const base = (creds.baseUrl || DEFAULT_BASE_URL.majestic).replace(/\/+$/, "");
  const search = new URLSearchParams({ app_api_key: creds.apiKey, ...params });
  try {
    const res = await requestWithRetry(
      `${base}/api/json?${search}`,
      { headers: { Accept: "application/json" } },
      creds.apiKey, creds.provider,
    );
    if (!res.ok) return { ok: false, error: `majestic ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const d = await res.json().catch(() => null);
    const err = mjError(d);
    return err ? { ok: false, error: err } : { ok: true, data: d };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export interface MajesticItemStats {
  item: string;
  status: string | null;
  trustFlow: number | null;
  citationFlow: number | null;
  refDomains: number | null;
  backlinks: number | null;
  raw: any;
}

/**
 * Batched `GetIndexItemInfo` — TF/CF and link counts for up to 100 items in one call, at one
 * index-item unit per item. Batching is not an optimization here but the documented contract:
 * the docs are explicit that one-item loops are the thing never to do. `Status` rides along
 * because `MayExist` means the counts are incomplete (the item sits below Majestic's backlink
 * threshold) and a caller quoting them as authoritative would lie.
 */
async function majesticItemInfo(
  creds: MetricsCreds,
  items: string[],
): Promise<{ items: MajesticItemStats[]; units: number; error?: string }> {
  const usable = items.map(s => s.trim()).filter(Boolean).slice(0, 100);
  if (!usable.length) return { items: [], units: 0 };
  const params: Record<string, string> = {
    cmd: "GetIndexItemInfo",
    items: String(usable.length),
    datasource: MAJESTIC_DATASOURCE,
  };
  usable.forEach((it, i) => { params[`item${i}`] = it; });

  const res = await majesticCall(creds, params);
  if (!res.ok) return { items: [], units: 0, error: res.error };
  const rows = mjTable(res.data, "Results");
  const byItem = new Map<string, MajesticItemStats>();
  for (const r of rows) {
    const item = String(mjPick(r, "Item", "Domain") ?? "").toLowerCase().replace(/^www\./, "");
    if (!item) continue;
    byItem.set(item, {
      item,
      status: mjPick(r, "Status") ? String(mjPick(r, "Status")) : null,
      trustFlow: num(mjPick(r, "TrustFlow")),
      citationFlow: num(mjPick(r, "CitationFlow")),
      refDomains: num(mjPick(r, "RefDomains")),
      backlinks: num(mjPick(r, "ExtBackLinks", "ExtBacklinks")),
      raw: r,
    });
  }
  // An item the index has never seen simply has no row — the same reconciliation every batched
  // call here makes: billed for what came back, not for what was asked.
  return { items: usable.map(it => byItem.get(it.toLowerCase().replace(/^www\./, ""))).filter(Boolean) as MajesticItemStats[], units: rows.length || MAJESTIC_STATS_UNITS };
}

/**
 * The public face of the batched index-item call, for callers outside this module that want
 * TF/CF for a list of domains (the drops TF/CF pass and its MCP mirror). One call answers up
 * to 100 items; `raw` travels on each row so writers can persist exactly what was billed for.
 */
export async function fetchMajesticItemStats(
  creds: MetricsCreds,
  items: string[],
): Promise<{ items: MajesticItemStats[]; units: number; error?: string }> {
  return majesticItemInfo(creds, items);
}

/**
 * Majestic domain metrics. One call, one unit. Majestic has no concept of organic traffic or
 * ad spend, so those stay null rather than zero — same distinction `num()` exists for.
 * TF/CF ride in the payload for callers that want them; `dr` stays null exactly as on the
 * Ahrefs path, because DR comes from the free `/api/dr` endpoint for everyone.
 */
async function majesticDomain(creds: MetricsCreds, domain: string): Promise<MetricsResult<DomainMetric>> {
  const r = await majesticItemInfo(creds, [domain]);
  if (r.error && !r.items.length) return { items: [], units: 0, error: r.error };
  const row = r.items[0];
  if (!row) return { items: [], units: 0, error: "majestic empty" };
  return {
    units: MAJESTIC_STATS_UNITS,
    items: [{
      domain,
      dr: null,
      refDomains: row.refDomains,
      backlinks: row.backlinks,
      orgTraffic: null,
      orgKeywords: null,
      orgCost: null,
      payload: row.raw,
    }],
  };
}

/**
 * Majestic referring domains — the third provider's answer to the profile pull.
 *
 * `GetRefDomains` pages through `From`/`Count` (web adapters cap `Count` at 1000) and bills
 * `1000 + rows` per call, so the pull walks whole pages until one comes back short. Row fields
 * are the official command's: the domain sits in `Domain`, the links **to the queried target**
 * in the dynamic `BackLinks_<target>` column (plain `ExtBackLinks` on this command is the
 * DONOR's own backlink count — quoting it was the bug that read 400 000 links from one blog),
 * first seen in `FirstLinkDate_<target>` with `FirstCrawled` as the fallback. The command has
 * no nofollow data at all, so `dofollowPct` stays null rather than reading 100% fabricated.
 *
 * `TrustFlow` lands in the `dr` slot of {@link RefDomainItem} — the column every consumer of
 * this shape renders — and the UI relabels the column when the active provider is Majestic.
 * `minDr` filters on it client-side: the command has no server-side TF filter, and the
 * completeness contract already treats a filtered run as a deliberate subset (`sawEnd` is only
 * trusted when `minDr === 0`).
 */
async function majesticProfile(
  creds: MetricsCreds,
  domain: string,
  opts: { minDr?: number; stats?: any } = {},
): Promise<MetricsResult<BacklinkProfile> & { sawEnd?: boolean; unitsSpent?: number }> {
  let stats = opts.stats ?? null;
  if (!stats) {
    const s = await fetchBacklinkStats(creds, domain);
    if (!s.ok) return { items: [], units: 0, error: s.error, unitsSpent: 0 };
    stats = s.raw;
  }
  // The stats call this pull was priced from was already spent — by the caller if it was passed
  // in, by the fetch above if not. Either way it belongs on this pull's meter once.
  let unitsSpent = MAJESTIC_STATS_UNITS;

  const refDomains: RefDomainItem[] = [];
  const seen = new Set<string>();
  const minDr = opts.minDr && opts.minDr > 0 ? opts.minDr : 0;

  let sawEnd = false;
  let partialError = "";
  let from = 0;
  let nofollowKnown = 0;
  for (;;) {
    const res = await majesticCall(creds, {
      cmd: "GetRefDomains",
      item: domain,
      datasource: MAJESTIC_DATASOURCE,
      Count: String(MAJESTIC_REFDOMAIN_PAGE_SIZE),
      From: String(from),
    });
    if (!res.ok) {
      if (refDomains.length === 0) return { items: [], units: unitsSpent, error: res.error, unitsSpent };
      partialError = res.error; // keep the pages already paid for, marked incomplete
      break;
    }
    const rows = mjTable(res.data, "Results");
    unitsSpent += MAJESTIC_REFDOMAIN_ANALYSIS_UNITS + rows.length;
    if (!rows.length) { sawEnd = true; break; }

    let added = 0;
    for (const r of rows) {
      const refDomain = String(mjPick(r, "Domain", "RefDomain", "Item") ?? "")
        .toLowerCase().replace(/^www\./, "");
      if (!refDomain.includes(".") || seen.has(refDomain)) continue;
      const tf = num(mjPick(r, "TrustFlow"));
      if (minDr && (tf == null || tf < minDr)) continue;
      seen.add(refDomain);
      // Nofollow is not part of this command's schema; when a field does appear in some future
      // index it is counted, and until then the percentage stays honestly unknown.
      const nofollow = mjPick(r, "NoFollow", "NoFollowLinks");
      const dofollow = nofollow == null ? true : Number(nofollow) === 0;
      if (nofollow != null) nofollowKnown++;
      refDomains.push({
        refDomain,
        dr: tf,
        linksToTarget: num(mjPickPrefix(r, "BackLinks_") ?? mjPick(r, "MatchedLinks", "BackLinks")),
        dofollow,
        firstSeen: String(mjPickPrefix(r, "FirstLinkDate_") ?? mjPick(r, "FirstCrawled", "FirstIndexedDate", "FirstSeen") ?? ""),
        cf: num(mjPick(r, "CitationFlow")),
        topic: String(mjPick(r, "TopicalTrustFlow_Topic_0") ?? ""),
        ip: String(mjPick(r, "IP") ?? ""),
      });
      added++;
    }
    if (rows.length < MAJESTIC_REFDOMAIN_PAGE_SIZE) { sawEnd = true; break; }
    if (added === 0) break; // offset drifting in place — same guard as the Ahrefs loop
    from += MAJESTIC_REFDOMAIN_PAGE_SIZE;
  }

  const total = num(mjPick(stats, "RefDomains"));
  const live = num(mjPick(stats, "ExtBackLinks"));
  const dofollowCount = refDomains.filter(r => r.dofollow).length;

  const result: MetricsResult<BacklinkProfile> & { sawEnd?: boolean; unitsSpent?: number } = {
    units: unitsSpent,
    unitsSpent,
    sawEnd,
    items: [{
      refDomainsTotal: total,
      backlinksTotal: live,
      // Majestic's command carries no nofollow column, so this is null unless the rows
      // themselves brought a countable field — never a fabricated 100%.
      dofollowPct: nofollowKnown > 0 && refDomains.length
        ? Math.round((dofollowCount / refDomains.length) * 100)
        : null,
      refDomains,
    }],
  };
  if (partialError) result.error = partialError;
  return result;
}

// ─── Keys.so ───────────────────────────────────────────────────────────────────
//
// The fourth provider: Yandex/Runet data (its own DR, its own link index). It never stands in
// for Ahrefs — every screen that shows a Keys.so number names Keys.so — and it never feeds a
// Google pipeline (keyword calls answer `provider_unsupported`, guarded by `isKeywordCapable`).
//
// Transport differs from the other three in two ways, both handled only in `keyssoGet`:
// auth is the `X-Keyso-TOKEN` header (never the `auth-token` query param — keys stay out of
// access logs), and HTTP 202 means "report is being built, ask again", which is free and is
// polled with its own back-off rather than pushed through `requestWithRetry`, where it would
// read as a success. Parsing and the retry plan live in `keyssoParse.ts` (pure, unit-tested).
//
// Concurrency is two in flight per key, not three: the gateway documents a 429 but not its
// threshold, and the first live probe tripped it with a burst of six.

const KEYSSO_MAX_IN_FLIGHT = 2;

type KeyssoAnswer = { ok: true; data: any } | { ok: false; status: number; error: string };

async function keyssoGet(creds: MetricsCreds, path: string, params: Record<string, string> = {}): Promise<KeyssoAnswer> {
  const base = (creds.baseUrl || DEFAULT_BASE_URL.keysso).replace(/\/+$/, "");
  const qs = new URLSearchParams(params).toString();
  const url = `${base}${path}${qs ? `?${qs}` : ""}`;
  const headers = { "X-Keyso-TOKEN": creds.apiKey, Accept: "application/json" };
  let pending = 0;
  let failures = 0;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    let call: { finish: (o?: { error?: string }) => void };
    try {
      // The slot covers the request only — a 202 back-off sleeps outside it, so a report being
      // built does not block the key's other reads.
      ({ res, call } = await withSlot(`keysso:${creds.apiKey}`, () =>
        loggedFetch(url, { headers, signal: AbortSignal.timeout(45_000) }, { provider: "keysso", attempt }),
      KEYSSO_MAX_IN_FLIGHT));
    } catch (e: any) {
      const step = keyssoNextStep(599, pending, failures);
      if (step.action !== "wait") return { ok: false, status: 0, error: String(e?.message ?? e) };
      failures++;
      await sleep(step.ms);
      continue;
    }
    const step = keyssoNextStep(res.status, pending, failures);
    if (step.action === "wait") {
      call.finish(step.kind === "pending" ? undefined : { error: `keysso ${res.status}` });
      if (step.kind === "pending") pending++; else failures++;
      await sleep(step.ms + (step.kind === "retry" ? Math.random() * 400 : 0));
      continue;
    }
    if (step.action === "give_up") {
      call.finish({ error: step.reason });
      return { ok: false, status: 202, error: step.reason };
    }
    if (!res.ok) {
      call.finish({ error: `keysso ${res.status}` });
      return { ok: false, status: res.status, error: keyssoErrorText(res.status, await res.text().catch(() => "")) };
    }
    call.finish();
    const data = await res.json().catch(() => null);
    if (data == null) return { ok: false, status: res.status, error: `keysso ${res.status}: response is not JSON` };
    return { ok: true, data };
  }
}

/** Free `/limits/all`: the GroupBuySEO balance, shaped like the official limits object. */
async function keyssoSubscription(creds: MetricsCreds): Promise<SubscriptionResult> {
  const base = (creds.baseUrl || DEFAULT_BASE_URL.keysso).replace(/\/+$/, "");
  const cacheKey = `keysso|${creds.apiKey}|${base}`;
  const hit = subscriptionCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SUBSCRIPTION_TTL_MS) return { info: hit.info, status: 200 };
  const r = await keyssoGet(creds, "/limits/all");
  // 402 here is the gateway refusing even the free call on an empty balance — the answer the
  // settings screen needs is "out of credits", which the status alone already says.
  if (!r.ok) return { info: null, status: r.status, error: r.error };
  const info: SubscriptionInfo = {
    unitsLimitApiKey: null, unitsUsageApiKey: null,
    unitsLimitWorkspace: null, unitsUsageWorkspace: null,
    usageResetDate: "", apiKeyExpirationDate: "",
    fetchedAt: new Date().toISOString(),
    unitsRemaining: keyssoRemainingCredits(r.data),
  };
  subscriptionCache.set(cacheKey, { at: Date.now(), info });
  return { info, status: 200 };
}

/**
 * Referring-domain and backlink totals from the `total` of two one-row pages — two credits,
 * because billing is per request. The gateway applies `filter=status=1` (live links) to the
 * links family by default, so both are live counts, the same meaning Ahrefs' `live*` carry.
 */
async function keyssoTotals(creds: MetricsCreds, domain: string) {
  const one = { domain, per_page: "1", page: "1" };
  const [rd, bl] = await Promise.all([
    keyssoGet(creds, "/report/simple/links/backlinks-domains", one),
    keyssoGet(creds, "/report/simple/links/backlinks", one),
  ]);
  return {
    refDomains: rd.ok ? parseKeyssoEnvelope(rd.data).total : null,
    backlinks: bl.ok ? parseKeyssoEnvelope(bl.data).total : null,
    billed: (rd.ok ? 1 : 0) + (bl.ok ? 1 : 0),
    error: !rd.ok ? rd.error : !bl.ok ? bl.error : null,
    ok: rd.ok || bl.ok,
  };
}

async function keyssoBacklinkStats(
  creds: MetricsCreds, domain: string,
): Promise<{ ok: true; raw: any; totals: BacklinkStatsTotals } | { ok: false; error: string }> {
  const t = await keyssoTotals(creds, domain);
  if (!t.ok) return { ok: false, error: t.error ?? "keysso empty" };
  return {
    ok: true,
    raw: { refdomains: t.refDomains, backlinks: t.backlinks },
    totals: { refDomainsTotal: t.refDomains, backlinksTotal: t.backlinks },
  };
}

/**
 * Keys.so domain card: `domain_dashboard` for DR (plus visibility / top-50 kept raw in the
 * payload) and the two totals reads — three credits. `dr` here is Keys.so's DR, stored under
 * provider `keysso` in the cache; it is never shown in an Ahrefs DR slot.
 */
async function keyssoDomain(creds: MetricsCreds, domain: string): Promise<MetricsResult<DomainMetric>> {
  const [dash, totals] = await Promise.all([
    keyssoGet(creds, "/report/simple/domain_dashboard", { domain, base: "msk" }),
    keyssoTotals(creds, domain),
  ]);
  if (!dash.ok && !totals.ok) return { items: [], units: 0, error: dash.error };
  const d = dash.ok ? mapKeyssoDashboard(dash.data) : null;
  return {
    // Billed per answered read; `domainUnits("keysso")` (3) is the reservation it reconciles.
    units: (dash.ok ? 1 : 0) + totals.billed,
    items: [{
      domain,
      dr: d?.dr ?? null,
      refDomains: totals.refDomains,
      backlinks: totals.backlinks,
      orgTraffic: null,
      orgKeywords: null,
      orgCost: null,
      payload: { source: "keysso", base: "msk", vis: d?.vis ?? null, it50: d?.it50 ?? null, dashboard: d?.raw ?? null },
    }],
  };
}

/** Hard stop for one pull: 2 000 pages × 100 rows. Far past any real profile, short of a loop. */
const KEYSSO_MAX_PAGES = 2000;

/**
 * Keys.so referring domains. Pages with `page`/`per_page` and stops on the envelope's
 * `last_page` (a short page only ends the pull when the envelope says nothing), so a gateway
 * that quietly caps `per_page` costs extra pages, never missing rows. One credit per page.
 * There is no server-side DR filter: `minDr` filters here, and a filtered run is a deliberate
 * subset that never proves an absent donor lost (the route already treats it so).
 */
async function keyssoProfile(
  creds: MetricsCreds,
  domain: string,
  opts: { minDr?: number; stats?: any } = {},
): Promise<MetricsResult<BacklinkProfile> & { sawEnd?: boolean; unitsSpent?: number }> {
  let stats = opts.stats ?? null;
  if (!stats) {
    const s = await keyssoBacklinkStats(creds, domain);
    if (!s.ok) return { items: [], units: 0, error: s.error, unitsSpent: 0 };
    stats = s.raw;
  }
  let unitsSpent = KEYSSO_STATS_UNITS;
  const minDr = opts.minDr && opts.minDr > 0 ? opts.minDr : 0;
  const refDomains: RefDomainItem[] = [];
  const seen = new Set<string>();
  let followKnown = 0;
  let sawEnd = false;
  let partialError = "";

  for (let page = 1; page <= KEYSSO_MAX_PAGES; page++) {
    const r = await keyssoGet(creds, "/report/simple/links/backlinks-domains", {
      domain, page: String(page), per_page: String(KEYSSO_REFDOMAIN_PAGE_SIZE),
    });
    if (!r.ok) {
      if (refDomains.length === 0 && page === 1) return { items: [], units: unitsSpent, error: r.error, unitsSpent };
      partialError = r.error; // keep the pages already paid for, marked incomplete
      break;
    }
    unitsSpent += 1;
    const env = parseKeyssoEnvelope(r.data);
    if (!env.rows.length) { sawEnd = true; break; }

    let fresh = 0;
    for (const raw of env.rows) {
      const row = mapKeyssoRefDomain(raw);
      if (!row || seen.has(row.refDomain)) continue;
      seen.add(row.refDomain);
      fresh++;
      if (minDr && (row.dr == null || row.dr < minDr)) continue;
      if (row.nofollow != null) followKnown++;
      refDomains.push({
        refDomain: row.refDomain,
        dr: row.dr,
        linksToTarget: row.linksToTarget,
        dofollow: row.nofollow !== true,
        firstSeen: row.firstSeen,
        ip: row.ip,
      });
    }
    const last = env.lastPage != null
      ? page >= env.lastPage
      : env.rows.length < KEYSSO_REFDOMAIN_PAGE_SIZE;
    if (last) { sawEnd = true; break; }
    if (fresh === 0) break; // the page repeated the previous one — same drift guard as the others
  }

  const dofollowCount = refDomains.filter(r => r.dofollow).length;
  const result: MetricsResult<BacklinkProfile> & { sawEnd?: boolean; unitsSpent?: number } = {
    units: unitsSpent,
    unitsSpent,
    sawEnd,
    items: [{
      refDomainsTotal: num(stats?.refdomains),
      backlinksTotal: num(stats?.backlinks),
      // Only when the rows carried a follow flag — never a fabricated 100%.
      dofollowPct: followKnown > 0 && refDomains.length
        ? Math.round((dofollowCount / refDomains.length) * 100)
        : null,
      refDomains,
    }],
  };
  if (partialError) result.error = partialError;
  return result;
}

/** Per-link backlink page size for the full export; one credit per page whatever its size. */
export const KEYSSO_BACKLINK_PAGE_SIZE = 100;

/**
 * One page of a domain's live backlinks from Keys.so, already restated in the all-backlinks row
 * shape the SiteBacklink writer expects (see `keyssoBacklinkToExportRow`). `total` is the live
 * backlink count — page 1 with `perPage = 1` is the one-credit stats call that prices an export.
 */
export async function fetchKeyssoBacklinksPage(
  creds: MetricsCreds, domain: string, page: number, perPage = KEYSSO_BACKLINK_PAGE_SIZE,
): Promise<{ rows: Record<string, unknown>[]; total: number | null; lastPage: number | null; units: number; error?: string }> {
  const r = await keyssoGet(creds, "/report/simple/links/backlinks", {
    domain, page: String(page), per_page: String(perPage),
  });
  if (!r.ok) return { rows: [], total: null, lastPage: null, units: 0, error: r.error };
  const env = parseKeyssoEnvelope(r.data);
  return {
    rows: env.rows.map(keyssoBacklinkToExportRow).filter((x): x is Record<string, unknown> => !!x),
    total: env.total, lastPage: env.lastPage, units: 1,
  };
}

/** Yandex Direct snapshot: one page of ads and one page of the queries they show on. */
export const KEYSSO_DIRECT_UNITS = 2;

export interface YandexDirectReport {
  adsTotal: number | null;
  ads: KeyssoDirectAd[];
  keywordsTotal: number | null;
  keywords: KeyssoDirectKeyword[];
  fetchedAt: string;
}

/** A sorted read that falls back to unsorted when the gateway rejects the sort field. */
async function keyssoGetSorted(creds: MetricsCreds, path: string, params: Record<string, string>, sort: string) {
  const r = await keyssoGet(creds, path, { ...params, sort });
  if (!r.ok && r.status >= 400 && r.status < 500 && ![401, 402, 403, 429].includes(r.status)) {
    return keyssoGet(creds, path, params);
  }
  return r;
}

/**
 * How a domain advertises in Yandex Direct (search, in the user's Yandex region): its top ads by reach and the
 * queries its ads show on, by exact Wordstat frequency. Two credits. Any domain — like the
 * Google half of the Ads tab, the interesting lookups are competitors.
 */
export async function fetchYandexDirectReport(
  creds: MetricsCreds, domain: string,
): Promise<{ ok: true; report: YandexDirectReport; units: number } | { ok: false; error: string; units: number }> {
  if (creds.provider !== "keysso" || !creds.apiKey) return { ok: false, error: "no_key", units: 0 };
  const base = { domain, base: parseKeyssoBase(creds.keyssoBase), page: "1", per_page: "20" };
  const [ads, kws] = await Promise.all([
    keyssoGetSorted(creds, "/report/simple/context/ads", base, "keyscnt|desc"),
    keyssoGetSorted(creds, "/report/simple/context/keywords", base, "wsk|desc"),
  ]);
  const units = (ads.ok ? 1 : 0) + (kws.ok ? 1 : 0);
  if (!ads.ok && !kws.ok) return { ok: false, error: ads.error, units };
  const aenv = ads.ok ? parseKeyssoEnvelope(ads.data) : null;
  const kenv = kws.ok ? parseKeyssoEnvelope(kws.data) : null;
  return {
    ok: true,
    units,
    report: {
      adsTotal: aenv?.total ?? null,
      ads: (aenv?.rows ?? []).map(mapKeyssoDirectAd).filter((r): r is KeyssoDirectAd => !!r),
      keywordsTotal: kenv?.total ?? null,
      keywords: (kenv?.rows ?? []).map(mapKeyssoDirectKeyword).filter((r): r is KeyssoDirectKeyword => !!r),
      fetchedAt: new Date().toISOString(),
    },
  };
}

// ─── Keys.so organic (the Yandex market of the competitor gap) ─────────────────
//
// Only reachable with the gap's `yandex` market (the route forces provider keysso there), so
// Yandex positions are stored under their own market key and never join a Google one. Volume
// is Wordstat's exact-phrase `wsk`; Keys.so has no KD, so difficulty stays null rather than
// borrowing its `kei` (a different index).

async function keyssoCompetitors(
  creds: MetricsCreds, domain: string, opts: { limit?: number },
): Promise<MetricsResult<CompetitorItem>> {
  const limit = Math.max(5, Math.min(100, opts.limit ?? 20));
  const r = await keyssoGetSorted(creds, "/report/simple/organic/concurents",
    { domain, base: parseKeyssoBase(creds.keyssoBase), page: "1", per_page: String(limit) }, "cnt|desc");
  if (!r.ok) return { items: [], units: 0, error: r.error };
  const items = parseKeyssoEnvelope(r.data).rows
    .map(x => ({ domain: String(x.name ?? "").toLowerCase().replace(/^www\./, ""), sharedKeywords: num(x.cnt), traffic: null }))
    .filter(x => x.domain.includes(".") && x.domain !== domain);
  return { items, units: 1 };
}

async function keyssoOrganicKeywords(
  creds: MetricsCreds, domain: string, opts: { limit?: number; maxPosition?: number },
): Promise<MetricsResult<OrganicKeywordItem>> {
  const limit = Math.max(10, Math.min(1000, opts.limit ?? 200));
  const maxPos = Math.max(1, Math.min(100, opts.maxPosition ?? 100));
  const items: OrganicKeywordItem[] = [];
  let units = 0;
  // Best positions first, so `limit` keeps the rows that matter and the position cut can stop early.
  for (let page = 1; items.length < limit && page <= Math.ceil(limit / 100); page++) {
    const r = await keyssoGetSorted(creds, "/report/simple/organic/keywords",
      { domain, base: parseKeyssoBase(creds.keyssoBase), page: String(page), per_page: "100" }, "pos|asc");
    if (!r.ok) {
      if (!items.length) return { items: [], units, error: r.error };
      break;
    }
    units++;
    const env = parseKeyssoEnvelope(r.data);
    let pastCut = false;
    for (const x of env.rows) {
      const position = num(x.pos);
      if (position != null && position > maxPos) { pastCut = true; continue; }
      const keyword = String(x.word ?? "").trim().toLowerCase();
      if (!keyword) continue;
      const path = String(x.url ?? "");
      items.push({
        keyword, position, volume: num(x.wsk), difficulty: null,
        url: /^https?:\/\//.test(path) ? path : `https://${domain}${path.startsWith("/") ? path : `/${path}`}`,
      });
      if (items.length >= limit) break;
    }
    if (pastCut || !env.rows.length || (env.lastPage != null && page >= env.lastPage)) break;
  }
  return { items, units };
}

/**
 * Yandex keyword research from one seed: the seed's own Wordstat figures (`keyword_dashboard`,
 * 1 credit) and up to `limit` similar phrases by exact frequency (`similarkeys`, a credit per
 * 100). The seed leads the list. Region = `creds.keyssoBase` (Moscow by default).
 */
export async function fetchYandexKeywords(
  creds: MetricsCreds, seed: string, limit: number,
): Promise<{ rows: KeyssoKeyword[]; units: number; error?: string }> {
  if (creds.provider !== "keysso" || !creds.apiKey) return { rows: [], units: 0, error: "no_key" };
  const rows: KeyssoKeyword[] = [];
  const seen = new Set<string>();
  let units = 0;
  const region = parseKeyssoBase(creds.keyssoBase);
  const dash = await keyssoGet(creds, "/report/simple/keyword_dashboard", { keyword: seed, base: region });
  if (dash.ok) {
    units++;
    const k = mapKeyssoKeyword(dash.data ?? {});
    if (k) { rows.push(k); seen.add(k.keyword); }
  }
  let lastError = dash.ok ? "" : dash.error;
  for (let page = 1; page <= Math.ceil(limit / 100) && rows.length < limit + 1; page++) {
    const r = await keyssoGetSorted(creds, "/report/simple/similarkeys",
      { keyword: seed, base: region, page: String(page), per_page: "100" }, "wsk|desc");
    if (!r.ok) { lastError = r.error; break; }
    units++;
    const env = parseKeyssoEnvelope(r.data);
    for (const x of env.rows) {
      const k = mapKeyssoKeyword(x);
      if (!k || seen.has(k.keyword)) continue;
      seen.add(k.keyword);
      rows.push(k);
    }
    if (!env.rows.length || (env.lastPage != null && page >= env.lastPage)) break;
  }
  return { rows: rows.slice(0, limit + 1), units, ...(rows.length ? {} : { error: lastError || "empty" }) };
}

/** What one Yandex AI-answers refresh costs: the answers page and the competitors page. */
export const KEYSSO_AI_UNITS = 2;

export interface YandexAiReport {
  /** Queries whose Yandex AI answer cites the site (envelope `total`). */
  total: number | null;
  answers: KeyssoAiAnswer[];
  competitorsTotal: number | null;
  competitors: KeyssoAiCompetitor[];
  fetchedAt: string;
}

/**
 * Yandex AI-answer visibility for one domain (Moscow base — the only one these reports serve):
 * the top 100 queries whose AI answer cites the site, by exact-phrase Wordstat frequency, plus
 * the ten domains most often cited beside it. Two credits. If the gateway rejects the sort,
 * the page is re-asked unsorted rather than failing — the order is a nicety, the rows are not.
 */
export async function fetchYandexAiReport(
  creds: MetricsCreds, domain: string,
): Promise<{ ok: true; report: YandexAiReport; units: number } | { ok: false; error: string; units: number }> {
  if (creds.provider !== "keysso" || !creds.apiKey) return { ok: false, error: "no_key", units: 0 };
  const base = { domain, base: "msk", page: "1" };
  let answers = await keyssoGet(creds, "/report/simple/organic/ai-answers", { ...base, per_page: "100", sort: "wsk|desc" });
  if (!answers.ok && answers.status >= 400 && answers.status < 500 && ![401, 402, 403, 429].includes(answers.status)) {
    answers = await keyssoGet(creds, "/report/simple/organic/ai-answers", { ...base, per_page: "100" });
  }
  const comps = await keyssoGet(creds, "/report/simple/organic/ai-concurents", { ...base, per_page: "10" });
  const units = (answers.ok ? 1 : 0) + (comps.ok ? 1 : 0);
  if (!answers.ok) return { ok: false, error: answers.error, units };
  const env = parseKeyssoEnvelope(answers.data);
  const cenv = comps.ok ? parseKeyssoEnvelope(comps.data) : null;
  return {
    ok: true,
    units,
    report: {
      total: env.total,
      answers: env.rows.map(r => mapKeyssoAiAnswer(r, domain)).filter((r): r is KeyssoAiAnswer => !!r),
      competitorsTotal: cenv?.total ?? null,
      competitors: (cenv?.rows ?? []).map(mapKeyssoAiCompetitor)
        .filter((r): r is KeyssoAiCompetitor => !!r && r.domain !== domain),
      fetchedAt: new Date().toISOString(),
    },
  };
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

export async function fetchOrganicCompetitors(
  creds: MetricsCreds,
  domain: string,
  opts: { limit?: number; country: string },
): Promise<MetricsResult<CompetitorItem>> {
  if (!creds.apiKey) return { items: [], units: 0, error: "no_key" };
  if (!normCountry(opts.country)) return { items: [], units: 0, error: "no_country" };
  // Majestic has no organic-search data at all — the honest answer is the same one Semrush-only
  // users got before their path existed, not a request its key cannot answer.
  if (creds.provider === "keysso") return keyssoCompetitors(creds, domain, opts);
  if (!isKeywordCapable(creds.provider)) return { items: [], units: 0, error: "provider_unsupported" };
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
      creds.apiKey, creds.provider,
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
    const res = await requestWithRetry(`${base}/?${params}`, { headers: { Accept: "text/plain" } }, creds.apiKey, creds.provider);
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

/** The keywords a domain ranks for — run against a competitor, this is one half of a gap. */
export async function fetchOrganicKeywords(
  creds: MetricsCreds,
  domain: string,
  opts: { limit?: number; country: string; withDifficulty?: boolean; maxPosition?: number },
): Promise<MetricsResult<OrganicKeywordItem>> {
  if (!creds.apiKey) return { items: [], units: 0, error: "no_key" };
  if (!normCountry(opts.country)) return { items: [], units: 0, error: "no_country" };
  if (creds.provider === "keysso") return keyssoOrganicKeywords(creds, domain, opts);
  if (!isKeywordCapable(creds.provider)) return { items: [], units: 0, error: "provider_unsupported" };
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
      creds.apiKey, creds.provider,
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
    const res = await requestWithRetry(`${base}/?${params}`, { headers: { Accept: "text/plain" } }, creds.apiKey, creds.provider);
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
    creds.apiKey, creds.provider,
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

  const res = await requestWithRetry(`${base}/?${params}`, { headers: { Accept: "text/plain" } }, creds.apiKey, creds.provider);
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
  if (!isKeywordCapable(creds.provider)) return { items: [], units: 0, error: "provider_unsupported" };
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
  if (creds.provider !== "ahrefs") return { items: [], units: 0, error: "provider_unsupported" };

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
      creds.apiKey, creds.provider,
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

  const res = await requestWithRetry(`${base}/?${params}`, { headers: { Accept: "text/plain" } }, creds.apiKey, creds.provider);
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

  const res = await requestWithRetry(`${base}/?${params}`, { headers: { Accept: "text/plain" } }, creds.apiKey, creds.provider);
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
  if (!isKeywordCapable(creds.provider)) return { items: [], units: 0, error: "provider_unsupported" };
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
      : creds.provider === "majestic"
        ? await majesticDomain(creds, domain)
        : creds.provider === "keysso"
          ? await keyssoDomain(creds, domain)
          : await ahrefsDomain(creds, domain);
  } catch (e: any) {
    return { items: [], units: 0, error: String(e?.message ?? e) };
  }
}
