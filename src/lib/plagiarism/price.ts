// Per-query prices for the SERP providers the plagiarism check and the site: index check run
// on. Both features spend the user's own key one quoted query at a time, and CONTRACT.md §0.5
// requires the price to be known and shown BEFORE the run — which means a price table has to
// exist somewhere before any call is made.
//
// Estimates only, and honest about being estimates: the real charge lands on the provider's
// dashboard, DataForSEO returns its own cost per call, and a provider absent from this table is
// priced `null` (unknown), never "$0.00" — free is a fact this table asserts, not a default.

/**
 * USD per single SERP query (num: 10). `null` = no per-request cost (self-hosted) or unknown.
 *
 *   serper        $0.30 / 1 000 queries — their published as-you-go rate for a plain search.
 *   dataforseo    Live Advanced Google organic ≈ $0.002 per task at depth 10.
 *   scrapingrobot ≈ $0.0009 — $45 / 50 000 credits as-you-go.
 *   aparser       the user's own machine and proxies; nothing is billed per request.
 */
export const SERP_QUERY_COST_USD: Readonly<Record<string, number | null>> = {
  serper: 0.0003,
  dataforseo: 0.002,
  scrapingrobot: 0.0009,
  aparser: null,
};

/** Providers with no per-request cost: self-hosted, the user's own hardware and proxies. */
export const FREE_SERP_PROVIDERS = new Set(["aparser"]);

export interface SerpCostEstimate {
  /** Total estimated cost, or null when the provider's price is unknown/self-hosted. */
  costUsd: number | null;
  /** True only for self-hosted providers — "free" is a property of the provider, not of a $0.00 bill. */
  free: boolean;
  /** True when this provider's price is simply not in the table (shown as "unknown", never as free). */
  unknownPrice: boolean;
}

export function estimateSerpQueryCost(provider: string, queries: number): SerpCostEstimate {
  const n = Math.max(0, Math.floor(queries));
  if (FREE_SERP_PROVIDERS.has(provider)) return { costUsd: null, free: true, unknownPrice: false };
  const per = SERP_QUERY_COST_USD[provider];
  if (per == null) return { costUsd: null, free: false, unknownPrice: true };
  return { costUsd: Math.round(n * per * 1e6) / 1e6, free: false, unknownPrice: false };
}

/** Same fixed rate the demand routes use: 1 unit = $0.001, so caps and ledgers stay comparable. */
export const UNITS_PER_USD = 1000;

export function usdToUnits(usd: number): number {
  return Math.max(1, Math.round(usd * UNITS_PER_USD));
}
