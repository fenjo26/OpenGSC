// What a metrics request costs, before anything is sent.
//
// This is the pure half of `metrics.ts`: types, the published gateway rates, and the estimators
// that price a request from its endpoint and field list. It has no imports and makes no calls.
//
// It is a separate file for one concrete reason. `metrics.ts` now opens its requests through the
// provider log, which reaches the Prisma client — and three browser modules (`metricsClient.ts`,
// the Backlink profile, the competitor gap page) quote prices before a button is pressed. With
// the prices living in `metrics.ts`, importing a price pulled the whole server chain into the
// browser bundle: Prisma, then better-sqlite3, then `require("fs")`, which is a build failure and
// would have been a shipped database driver in the browser if it were not. Prices are shared
// knowledge between the two sides; sockets are not.
//
// So: anything here must stay callable in a browser. If a function needs the network, it belongs
// in `metrics.ts`, which re-exports this whole module so every existing server-side import keeps
// working unchanged.

export type MetricsProvider = "ahrefs" | "semrush" | "majestic";

/**
 * Providers that can serve keyword-side calls (volumes, difficulty, ideas, organic rows).
 * Majestic is a backlink-intelligence index — it has no keyword data at all — so every
 * keyword-side surface resolves off it onto whichever of these actually has a key.
 */
export const KEYWORD_CAPABLE_PROVIDERS: MetricsProvider[] = ["ahrefs", "semrush"];

export interface MetricsCreds {
  provider: MetricsProvider;
  apiKey: string;
  /** Optional host override — an official client pointed at a different gateway. Path is unchanged. */
  baseUrl?: string;
}

export const DEFAULT_BASE_URL: Record<MetricsProvider, string> = {
  ahrefs: "https://api.ahrefs.com",
  semrush: "https://api.semrush.com",
  // The official Majestic JSON API. Same wire protocol as the reseller gateway: host plus
  // `/api/json`, `app_api_key` query param, `cmd`. Only the key decides which one answers.
  majestic: "https://api.majestic.com",
};

/**
 * The one provider parse for every route and tool that takes `provider` from a request body.
 *
 * The old per-route ternaries (`b.provider === "semrush" ? "semrush" : "ahrefs"`) predates the
 * third provider and would have coerced a Majestic key into an Ahrefs request — a 401 that
 * looks like a broken key while the screen says "Connected". Unknown values still fall back to
 * ahrefs, which keeps old clients (and hand-rolled curl calls) working unchanged.
 */
export function parseMetricsProvider(v: unknown): MetricsProvider {
  return v === "semrush" || v === "majestic" ? v : "ahrefs";
}

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
  // Raised 2026-09 at the gateway (was 0.000025). Still the reseller's published rate, only
  // now the expensive one — which is exactly why the majestic column below exists.
  ahrefs: 0.0001,
  semrush: 0.00006,
  majestic: 0.000002,
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

/**
 * Tier suffixes that do not change a field's price class: `volume_prev` bills exactly as
 * `volume`, `traffic_merged` as `traffic`. Without stripping them, every `_prev`/`_merged`
 * variant fell through to the 1-unit default and the estimate silently undercharged by 9 units
 * a row on precisely the endpoints whose history columns are the expensive ones.
 */
const TIER_SUFFIX = /_(?:prev|merged)$/;

/**
 * Field prices that hold on every endpoint, consulted when the per-endpoint table above has no
 * entry. Same gateway rate card, restated globally: AI-citation columns 15; traffic / volume /
 * difficulty / value 10; ref-domain counters 5; everything else 1. Per-endpoint entries keep
 * precedence, so a price documented for one endpoint's column is never shadowed by this table.
 */
const AHREFS_PREMIUM_GLOBAL: Record<string, number> = {
  // 15 — AI citation (the gateway's per-engine brand-visibility columns)
  chatgpt: 15, gemini: 15, perplexity: 15, copilot: 15, grok: 15,
  // 10 — demand and traffic
  volume: 10, difficulty: 10, value: 10, traffic: 10,
  // 5 — ref-domain counters
  refdomains: 5, refdomains_source: 5, refdomains_source_domain: 5, refdomains_target_domain: 5,
  dofollow_refdomains: 5, class_c: 5, all_positions: 5,
};

/** Cost of one row for a given endpoint and field selection. */
export function perRowCost(endpoint: string, select: string[]): number {
  const premium = AHREFS_PREMIUM_FIELDS[endpoint] ?? {};
  return select.reduce((sum, f) => {
    const direct = premium[f] ?? AHREFS_PREMIUM_GLOBAL[f];
    if (direct != null) return sum + direct;
    const base = f.replace(TIER_SUFFIX, "");
    return sum + (premium[base] ?? AHREFS_PREMIUM_GLOBAL[base] ?? 1);
  }, 0);
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

// ─── Prices for calls whose fetchers live in metrics.ts ────────────────────────
//
// Each of these used to sit beside the request it prices, which read well until a browser had to
// quote the price without being handed a database driver. The field lists come along because the
// price IS the field list; `metrics.ts` imports them back for the requests themselves.

export interface SubscriptionInfo {
  unitsLimitApiKey: number | null;
  unitsUsageApiKey: number | null;
  unitsLimitWorkspace: number | null;
  unitsUsageWorkspace: number | null;
  /** YYYY-MM-DD, empty when the gateway did not say. */
  usageResetDate: string;
  apiKeyExpirationDate: string;
  /** When this answer was obtained — the "updated HH:MM" a balance placard shows. */
  fetchedAt: string;
}

/**
 * The HTTP status inside an error string this module produced ("ahrefs 502: …"), or null.
 * The fetch layer turns gateway refusals into text errors long before a route can branch on
 * them; this lets a caller distinguish "key rejected" from "gateway down" without re-fetching.
 */
export function gatewayStatusFromError(error: string | null | undefined): number | null {
  const m = /^(?:ahrefs|semrush|majestic) (\d{3})/.exec(String(error ?? "").trim());
  return m ? Number(m[1]) : null;
}

/**
 * Cost of a full profile pull of `domains` referring domains, so the button can price itself the
 * same way the server will. Two floored requests on top of the rows: the stats call the price is
 * computed from, and one floor of slack for the short tail page or the one-per-host-per-day
 * offset probe. Reconciled down to what the gateway actually billed after the pull.
 */
export function estimateProfileUnits(domains: number): number {
  return AHREFS_UNIT_FLOOR
    + estimateUnits("site-explorer/refdomains", REFDOMAIN_FIELDS, Math.max(1, domains))
    + AHREFS_UNIT_FLOOR;
}

// ─── Majestic ───────────────────────────────────────────────────────────────────
//
// Majestic bills three upstream resource pools (index-item, analysis, retrieval) that the
// gateway collapses into one `FullCost` figure, charged against the same credit ledger at
// `UNIT_PRICE_USD.majestic`. The published formulas, kept as data so a gateway repricing is a
// one-line edit the same way the Ahrefs field table is:
//
//   GetIndexItemInfo   1 × items            (batch up to 100)
//   GetRefDomains      1000 + rows          (web adapters cap Count at 1000)
//   GetBackLinkData    5000 + rows          (not used here — the refdomain view is the product)
//
// Non-OK bodies are not charged, so a failed page costs nothing and the reconciliation that
// releases unused units on the Ahrefs path applies unchanged.

/** The fixed analysis cost of one GetRefDomains call, before its retrieval rows. */
export const MAJESTIC_REFDOMAIN_ANALYSIS_UNITS = 1000;

/** Web adapters cap `Count` at 1000 — the Majestic counterpart of REFDOMAIN_PAGE_SIZE. */
export const MAJESTIC_REFDOMAIN_PAGE_SIZE = 1000;

/** GetIndexItemInfo costs one index-item unit per requested item; the profile stats call asks for one. */
export const MAJESTIC_STATS_UNITS = 1;

/** Total reserve for a pull of `domains` referring domains: stats + analysis per page + a row each. */
export function estimateMajesticProfileUnits(domains: number): number {
  const rows = Math.max(1, domains);
  const pages = Math.ceil(rows / MAJESTIC_REFDOMAIN_PAGE_SIZE);
  return MAJESTIC_STATS_UNITS + pages * MAJESTIC_REFDOMAIN_ANALYSIS_UNITS + rows;
}

// ─── Semrush Backlinks (the /analytics/v1/ reports on the gateway) ─────────────

/** `backlinks_overview` is the stats call: 40 units flat per request. */
export const SEMRUSH_BACKLINKS_OVERVIEW_UNITS = 40;

/** Referring domains and backlink rows bill 40 units per line returned. */
export const SEMRUSH_BACKLINKS_UNITS_PER_ROW = 40;

/**
 * Reserve for a Semrush referring-domain pull: the flat overview call plus every row the
 * profile has. At the reseller's Semrush rate this is by far the most expensive way to see a
 * link profile (≈10× Ahrefs, ≈1000× Majestic per row) — the estimate exists so the button can
 * say so before it is pressed, and the monthly cap is the real guard.
 */
export function estimateSemrushProfileUnits(domains: number): number {
  return SEMRUSH_BACKLINKS_OVERVIEW_UNITS + SEMRUSH_BACKLINKS_UNITS_PER_ROW * Math.max(1, domains);
}

/**
 * What one domain-metrics fetch costs, by provider. Replaces the bare `DOMAIN_UNITS` constant in
 * the reservation/reconciliation math, which had been charging Semrush's 10-unit report at the
 * Ahrefs rate — a 10× overcount our meter held even though the gateway only took 10.
 */
export function domainUnits(provider: MetricsProvider): number {
  if (provider === "majestic") return MAJESTIC_STATS_UNITS;
  if (provider === "semrush") return 10; // `domain_ranks`: 10 units per line, one line per domain
  return DOMAIN_UNITS;
}

/** Two floored Ahrefs calls (metrics + backlinks-stats); see ahrefsDomain in metrics.ts. */
export const DOMAIN_UNITS = AHREFS_UNIT_FLOOR * 2;

/**
 * Every field here costs 1 unit. The tempting ones — `traffic_domain` (10) and
 * `dofollow_refdomains` (5) — are left out deliberately: they would triple the price of a
 * 100-row pull to show numbers that do not change which links you care about.
 */
export const REFDOMAIN_FIELDS = ["domain", "domain_rating", "links_to_target", "dofollow_links", "first_seen"];

/**
 * `traffic` and `value` cost 10 units each here. `keywords_common` is 1, and it is the field
 * that actually orders the list usefully — a competitor sharing 4 000 keywords with you is
 * more relevant than one with more traffic and 12 keywords in common.
 */
export const COMPETITOR_FIELDS = ["competitor_domain", "keywords_common", "keywords_competitor"];

export function estimateCompetitorUnits(limit: number): number {
  return estimateUnits("site-explorer/organic-competitors", COMPETITOR_FIELDS, limit);
}

// `volume` and `keyword_difficulty` are 10 units each. KD is optional for the same reason it is
// optional everywhere else: it roughly doubles the bill for a column you may not sort by.
export const ORGANIC_KEYWORD_FIELDS = ["keyword", "best_position", "best_position_url", "volume"];

export function estimateOrganicKeywordUnits(limit: number, withDifficulty: boolean): number {
  const select = withDifficulty
    ? [...ORGANIC_KEYWORD_FIELDS, "keyword_difficulty"]
    : ORGANIC_KEYWORD_FIELDS;
  return estimateUnits("site-explorer/organic-keywords", select, limit);
}
