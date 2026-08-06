// Keyword discovery via DataForSEO — the half of the picture Search Console cannot show.
//
// GSC answers "where do I already appear". This module answers "what does the market ask for",
// which is a different question and needs a different source. It reuses the credential already
// configured for SERP (`seoKey_dataforseo`), so nothing new has to be connected.
//
// Four things here are load-bearing:
//
// 1. **Three discovery endpoints, three different questions.** `related` returns semantic
//    neighbours of the seed, `suggestions` returns the long tail that literally contains it,
//    `ideas` returns terms that mean the same thing without sharing a word. Picking one and
//    calling it "keyword research" gives a narrow slice — which is why `auto` exists below.
//
// 2. **`auto` is a fallback chain, not a merge.** Each source is a separately billed call.
//    Running all three costs three times as much for a result that is mostly duplicates, so
//    auto stops at the first source that returns enough non-seed rows.
//
// 3. **Labs covers ~94 countries, Google Ads covers ~217.** A seed in an uncovered country is
//    not an error, it is a routing decision — and rows that come back from Google Ads carry no
//    keyword difficulty and no intent. The caller must be able to tell the user that, so the
//    source travels with the result instead of being swallowed.
//
// 4. **`include_clickstream_data` doubles the price** and only refines volume numbers. Off by
//    default, opt-in per call, and the price estimate accounts for it.
//
// Pricing (DataForSEO Labs, live endpoints): $0.01 per task + $0.0001 per returned row.
// Google Ads live endpoints are flat $0.075 regardless of row count.

const DFS_BASE = "https://api.dataforseo.com";
const DFS_TIMEOUT_MS = 60_000;

// ─── Locations ─────────────────────────────────────────────────────────────────

/**
 * Country (gl) → DataForSEO location_code. Superset of the table in `keywords.ts`, kept here
 * because this module also needs to know which of them Labs actually supports.
 *
 * Every code is ISO 3166-1 numeric + 2000, which is how DataForSEO derives country locations.
 * That rule is what makes this table auditable — a wrong entry is visible without a lookup.
 */
export const DEMAND_LOC: Record<string, number> = {
  us: 2840, gb: 2826, ca: 2124, au: 2036, de: 2276, fr: 2250, nl: 2528, it: 2380,
  es: 2724, pt: 2620, gr: 2300, pl: 2616, cz: 2203, ro: 2642, bg: 2100, tr: 2792,
  ua: 2804, ru: 2643, ae: 2784, in: 2356, br: 2076, mx: 2484, se: 2752, no: 2578,
  dk: 2208, fi: 2246, ch: 2756, at: 2040, be: 2056, ie: 2372, sg: 2702, jp: 2392,
  kz: 2398, by: 2112, rs: 2688, hr: 2191, sk: 2703, hu: 2348, lt: 2440, lv: 2428,
  ee: 2233, is: 2352, il: 2376, za: 2710, nz: 2554, kr: 2410, th: 2764, vn: 2704,
  id: 2360, ph: 2608, my: 2458, ar: 2032, cl: 2152, co: 2170, pe: 2604, eg: 2818,
  // Western Balkans. Added because they were the concrete case that exposed the silent
  // fallback below: a portfolio of Bosnian sites was being researched against US demand,
  // and nothing anywhere said so.
  ba: 2070, me: 2499, mk: 2807, al: 2008, si: 2705,
};

/**
 * Countries DataForSEO Labs does not cover. They are served by the Google Ads endpoints
 * instead, which know more countries but return neither difficulty nor intent.
 *
 * Kept as an explicit deny-list rather than an allow-list: an unknown country falls through to
 * Labs and gets Labs' own error message, which is more informative than anything invented here.
 */
const GOOGLE_ADS_ONLY = new Set(["is", "by", "kz", "eg"]);

export type DemandProvider = "labs" | "google_ads";

/** Which data source serves this country. There is no user-facing choice — coverage decides. */
export function providerFor(gl: string): DemandProvider {
  return GOOGLE_ADS_ONLY.has((gl || "us").toLowerCase()) ? "google_ads" : "labs";
}

/** Whether a market can be researched at all. Callers guard with this before spending money. */
export function isSupportedCountry(gl: string): boolean {
  return !!DEMAND_LOC[(gl || "").trim().toLowerCase()];
}

/**
 * Thrown instead of silently substituting the United States.
 *
 * The old behaviour — `?? 2840` — meant an unrecognised market returned US volumes with no
 * signal of any kind: no error, no flag, no differently-shaped response. Numbers for the wrong
 * country are indistinguishable from correct ones on screen, and they get acted upon. Every
 * exported entry point below now refuses such a request before it is billed.
 */
export class UnknownCountryError extends Error {
  constructor(public readonly gl: string) {
    super(`unsupported_country:${gl}`);
    this.name = "UnknownCountryError";
  }
}

export function locationCode(gl: string): number {
  const code = DEMAND_LOC[(gl || "").trim().toLowerCase()];
  if (!code) throw new UnknownCountryError(gl);
  return code;
}

// ─── Cost model ────────────────────────────────────────────────────────────────

const LABS_TASK_COST = 0.01;
const LABS_ROW_COST = 0.0001;
const GOOGLE_ADS_CALL_COST = 0.075;

/**
 * Price of one discovery call in USD, computed before it is sent — the same contract
 * `estimateUnits()` has in `metrics.ts`, so the UI can show a number next to the button.
 *
 * `rows` is the requested limit, not the delivered count. DataForSEO bills what it returns, so
 * a seed with little demand costs less than this; the estimate is deliberately the ceiling.
 */
export function estimateDemandCost(
  provider: DemandProvider,
  rows: number,
  clickstream = false,
): number {
  if (provider === "google_ads") return GOOGLE_ADS_CALL_COST;
  const base = LABS_TASK_COST + LABS_ROW_COST * Math.max(1, rows);
  return clickstream ? base * 2 : base;
}

/**
 * Cost of hydrating a known keyword list with metrics. Labs batches up to 700 per request, so
 * the count matters in steps of 700, not per keyword.
 */
export function estimateOverviewCost(count: number, clickstream = false): number {
  const batches = Math.ceil(Math.max(1, count) / KEYWORD_BATCH);
  const base = batches * (LABS_TASK_COST + LABS_ROW_COST * Math.max(1, count));
  return clickstream ? base * 2 : base;
}

/** DataForSEO's documented ceiling for batch metric endpoints. */
export const KEYWORD_BATCH = 700;

// ─── Types ─────────────────────────────────────────────────────────────────────

export type KeywordIntent =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational"
  | "unknown";

export interface MonthlyPoint {
  year: number;
  month: number;
  volume: number;
}

export interface DemandRow {
  keyword: string;
  volume: number | null;
  /**
   * Worldwide volume, when the provider reports it separately from the local one. Ahrefs and
   * Semrush do; DataForSEO does not (null there). Matters for brand and niche terms whose local
   * volume is zero — a 0 next to "global 250" tells the writer the term is not dead, just not in
   * this country, whereas a bare 0 reads as "ignore".
   */
  globalVolume: number | null;
  /** 0-100. Always null on Google-Ads-sourced rows — the endpoint does not return it. */
  difficulty: number | null;
  cpc: number | null;
  /** 0..1 ratio. */
  competition: number | null;
  competitionLevel: string | null;
  /** Always "unknown" on Google-Ads-sourced rows. */
  intent: KeywordIntent;
  /** Last 12 months where available — what makes a shrinking market visible. */
  trend: MonthlyPoint[];
}

export type DemandSource = "related" | "suggestions" | "ideas";
export type DemandMode = "auto" | DemandSource;

export interface DemandResult {
  rows: DemandRow[];
  /** Where the rows actually came from — "google_ads" is never requestable, only routed to. */
  source: DemandSource | "google_ads";
  /** True when `auto` had to move past its first choice. Worth surfacing: it means the seed is thin. */
  usedFallback: boolean;
  /** USD actually implied by the calls that were made. */
  cost: number;
  error?: string;
}

// ─── Transport ─────────────────────────────────────────────────────────────────

/** DataForSEO accepts either `login:password` or a pre-encoded Base64 token. Both are common. */
function dfsAuth(cred: string): string {
  const c = (cred || "").trim();
  return c.includes(":") ? Buffer.from(c).toString("base64") : c;
}

interface DfsCall<T> {
  items: T[];
  error?: string;
}

/**
 * One POST to a DataForSEO v3 endpoint, with the three-level status check the API requires:
 * HTTP status, envelope `status_code`, and the per-task `status_code`. A task can fail inside a
 * 200 response — checking only the HTTP status silently turns an error into an empty result.
 */
async function dfsPost<T = any>(
  credential: string,
  path: string,
  body: unknown,
  pick: (task: any) => T[],
): Promise<DfsCall<T>> {
  let res: Response;
  try {
    res = await fetch(`${DFS_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${dfsAuth(credential)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DFS_TIMEOUT_MS),
    });
  } catch (e: any) {
    const reason = e?.cause?.code || e?.cause?.message || e?.message || "fetch failed";
    return { items: [], error: `сеть DataForSEO: ${reason}` };
  }

  if (!res.ok) {
    return { items: [], error: `dataforseo ${res.status}: ${(await res.text()).slice(0, 200)}` };
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    return { items: [], error: "dataforseo: ответ не JSON" };
  }

  if (data?.status_code && data.status_code !== 20000) {
    return { items: [], error: `dataforseo ${data.status_code}: ${data.status_message}` };
  }
  const task = data?.tasks?.[0];
  if (task?.status_code && task.status_code !== 20000) {
    return { items: [], error: `dataforseo task ${task.status_code}: ${task.status_message}` };
  }

  return { items: pick(task) ?? [] };
}

// ─── Normalization ─────────────────────────────────────────────────────────────

export const normalizeKw = (k: string) => k.trim().toLowerCase();

/**
 * DataForSEO reports intent as `main_intent` with its own vocabulary. Mapped to a closed enum so
 * the UI can colour it without a lookup table of every string the API has ever returned.
 */
function normalizeIntent(raw: unknown): KeywordIntent {
  const v = String(raw ?? "").toLowerCase();
  if (v === "informational" || v === "commercial" || v === "transactional" || v === "navigational") {
    return v;
  }
  return "unknown";
}

function toTrend(entries: any[] | null | undefined): MonthlyPoint[] {
  return (entries ?? [])
    .map((e) => ({
      year: Number(e?.year ?? 0),
      month: Number(e?.month ?? 0),
      volume: Number(e?.search_volume ?? 0),
    }))
    .filter((p) => p.year > 0)
    .slice(-12);
}

/**
 * Labs items arrive in two shapes: `related_keywords` nests everything under `keyword_data`,
 * while `keyword_suggestions` and `keyword_ideas` put it at the top level. One mapper handles
 * both by unwrapping first — the alternative is three near-identical mappers that drift apart.
 */
function mapLabsRow(raw: any): DemandRow | null {
  const kd = raw?.keyword_data ?? raw;
  const keyword = String(kd?.keyword ?? "").trim();
  if (!keyword) return null;

  const info = kd?.keyword_info ?? {};
  // The clickstream block only exists when the caller opted in; it refines volume and nothing else.
  const clickstream = kd?.keyword_info_normalized_with_clickstream;
  const props = kd?.keyword_properties ?? {};
  const intentInfo = kd?.search_intent_info ?? {};

  return {
    keyword,
    volume: clickstream?.search_volume ?? info?.search_volume ?? null,
    globalVolume: null,
    difficulty: props?.keyword_difficulty ?? info?.keyword_difficulty ?? null,
    cpc: info?.cpc ?? null,
    competition: info?.competition ?? null,
    competitionLevel: info?.competition_level ?? null,
    intent: normalizeIntent(intentInfo?.main_intent),
    trend: toTrend(clickstream?.monthly_searches ?? info?.monthly_searches),
  };
}

/** Google Ads rows are flat and carry no difficulty or intent — that absence is meaningful, not a bug. */
function mapAdsRow(raw: any): DemandRow | null {
  const keyword = String(raw?.keyword ?? "").trim();
  if (!keyword) return null;
  return {
    keyword,
    volume: raw?.search_volume ?? null,
    globalVolume: null,
    difficulty: null,
    cpc: raw?.cpc ?? null,
    competition: raw?.competition_index == null ? null : Number(raw.competition_index) / 100,
    competitionLevel: raw?.competition ?? null,
    intent: "unknown",
    trend: toTrend(raw?.monthly_searches),
  };
}

function dedupe(rows: DemandRow[]): DemandRow[] {
  const seen = new Set<string>();
  const out: DemandRow[] = [];
  for (const r of rows) {
    const key = normalizeKw(r.keyword);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  out.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  return out;
}

// ─── Discovery endpoints ───────────────────────────────────────────────────────

interface DiscoverOpts {
  gl?: string;
  hl?: string;
  limit?: number;
  clickstream?: boolean;
  /** `related` walks the keyword graph; deeper means broader and slower. DataForSEO caps it at 4. */
  depth?: number;
}

async function fetchRelated(cred: string, seed: string, o: DiscoverOpts): Promise<DfsCall<DemandRow>> {
  const r = await dfsPost(
    cred,
    "/v3/dataforseo_labs/google/related_keywords/live",
    [{
      keyword: seed,
      location_code: locationCode(o.gl || "us"),
      language_code: o.hl || "en",
      limit: o.limit ?? 150,
      depth: Math.min(4, Math.max(1, o.depth ?? 2)),
      include_seed_keyword: true,
      include_clickstream_data: o.clickstream ?? false,
      include_serp_info: false,
    }],
    (task) => task?.result?.[0]?.items ?? [],
  );
  return { items: r.items.map(mapLabsRow).filter(Boolean) as DemandRow[], error: r.error };
}

async function fetchSuggestions(cred: string, seed: string, o: DiscoverOpts): Promise<DfsCall<DemandRow>> {
  const r = await dfsPost(
    cred,
    "/v3/dataforseo_labs/google/keyword_suggestions/live",
    [{
      keyword: seed,
      location_code: locationCode(o.gl || "us"),
      language_code: o.hl || "en",
      limit: o.limit ?? 150,
      include_seed_keyword: true,
      include_clickstream_data: o.clickstream ?? false,
      include_serp_info: false,
      ignore_synonyms: false,
      exact_match: false,
    }],
    (task) => task?.result?.[0]?.items ?? [],
  );
  return { items: r.items.map(mapLabsRow).filter(Boolean) as DemandRow[], error: r.error };
}

async function fetchIdeas(cred: string, seed: string, o: DiscoverOpts): Promise<DfsCall<DemandRow>> {
  const r = await dfsPost(
    cred,
    "/v3/dataforseo_labs/google/keyword_ideas/live",
    [{
      keywords: [seed],
      location_code: locationCode(o.gl || "us"),
      language_code: o.hl || "en",
      limit: o.limit ?? 150,
      include_clickstream_data: o.clickstream ?? false,
      include_serp_info: false,
      ignore_synonyms: false,
      closely_variants: false,
    }],
    (task) => task?.result?.[0]?.items ?? [],
  );
  return { items: r.items.map(mapLabsRow).filter(Boolean) as DemandRow[], error: r.error };
}

/** The single source for countries Labs does not cover. Flat-priced, so `limit` only truncates. */
async function fetchAdsIdeas(cred: string, seed: string, o: DiscoverOpts): Promise<DfsCall<DemandRow>> {
  const r = await dfsPost(
    cred,
    "/v3/keywords_data/google_ads/keywords_for_keywords/live",
    [{
      keywords: [seed],
      location_code: locationCode(o.gl || "us"),
      language_code: o.hl || "en",
      sort_by: "search_volume",
    }],
    // keywords_data returns rows directly in `result`, without the `items` wrapper Labs uses.
    (task) => task?.result ?? [],
  );
  const rows = (r.items.map(mapAdsRow).filter(Boolean) as DemandRow[]).slice(0, o.limit ?? 150);
  return { items: rows, error: r.error };
}

// ─── Public surface ────────────────────────────────────────────────────────────

/** A source has done its job if it found this many terms that are not just the seed echoed back. */
const MIN_NON_SEED = 5;

function nonSeedCount(rows: DemandRow[], seed: string): number {
  const s = normalizeKw(seed);
  return rows.filter((r) => normalizeKw(r.keyword) !== s).length;
}

/**
 * Discover keywords for one seed.
 *
 * `mode: "auto"` walks related → suggestions → ideas and stops at the first source that returns
 * at least {@link MIN_NON_SEED} rows beyond the seed itself. It does not merge them: every source
 * is a separate charge, and the overlap between them is large enough that paying three times
 * mostly buys duplicates. An explicit mode calls exactly one endpoint.
 *
 * Country routing is not a preference. A Google-Ads-only country ignores `mode` entirely, because
 * only one endpoint exists there — the returned `source` says so, and the rows carry no
 * difficulty or intent. Callers must show that rather than rendering empty columns.
 */
export async function discoverKeywords(
  credential: string,
  seed: string,
  opts: DiscoverOpts & { mode?: DemandMode } = {},
): Promise<DemandResult> {
  const empty: DemandResult = { rows: [], source: "related", usedFallback: false, cost: 0 };
  if (!credential) return { ...empty, error: "no_key" };
  if (!seed.trim()) return { ...empty, error: "no_seed" };

  const gl = (opts.gl || "us").toLowerCase();
  // Checked before anything is billed: a request for an unmapped market cannot be answered, and
  // answering it with US data would be worse than answering it at all.
  if (!isSupportedCountry(gl)) return { ...empty, error: `unsupported_country:${gl}` };
  const limit = Math.max(10, Math.min(1000, opts.limit ?? 150));
  const provider = providerFor(gl);

  if (provider === "google_ads") {
    const r = await fetchAdsIdeas(credential, seed, { ...opts, gl, limit });
    return {
      rows: dedupe(r.items),
      source: "google_ads",
      usedFallback: false,
      cost: r.error ? 0 : GOOGLE_ADS_CALL_COST,
      error: r.error,
    };
  }

  const fetchers: Record<DemandSource, (c: string, s: string, o: DiscoverOpts) => Promise<DfsCall<DemandRow>>> = {
    related: fetchRelated,
    suggestions: fetchSuggestions,
    ideas: fetchIdeas,
  };

  const mode = opts.mode ?? "auto";
  const chain: DemandSource[] = mode === "auto" ? ["related", "suggestions", "ideas"] : [mode];

  let cost = 0;
  let lastError: string | undefined;

  for (let i = 0; i < chain.length; i++) {
    const source = chain[i];
    const r = await fetchers[source](credential, seed, { ...opts, gl, limit });

    if (r.error) {
      lastError = r.error;
      // A failed call still consumed a round-trip but is not billed as a completed task; keep
      // walking the chain in auto mode, since the next endpoint may well succeed.
      if (mode !== "auto") break;
      continue;
    }

    cost += estimateDemandCost("labs", r.items.length || 1, opts.clickstream);

    if (mode !== "auto" || hasEnough(r.items, seed) || i === chain.length - 1) {
      return {
        rows: dedupe(r.items),
        source,
        usedFallback: i > 0,
        cost,
        error: r.items.length ? undefined : lastError,
      };
    }
  }

  return { ...empty, cost, error: lastError ?? "empty" };
}

function hasEnough(rows: DemandRow[], seed: string): boolean {
  return nonSeedCount(rows, seed) >= MIN_NON_SEED;
}

// ─── Domain overview ───────────────────────────────────────────────────────────
//
// The same question as keyword discovery asked from the other end: instead of "what does this
// market search for", it is "what does this domain already own". Three Labs endpoints, and the
// split between them is not arbitrary —
//
//   domain_rank_overview → the summary: how many keywords, how much estimated traffic, and how
//                          those keywords are distributed across the first pages
//   ranked_keywords      → the keywords themselves, ordered by the traffic they actually bring
//   relevant_pages       → the same domain grouped by URL, which answers "which page carries it"
//
// Deliberately no `serp_competitors` here. It takes a keyword list rather than a domain, so it
// would mean a second billed call on top of ranked_keywords — and competitor discovery already
// exists in the Competitors screen against Ahrefs. Two ways to buy the same list is a worse
// product than one.

export interface DomainSummary {
  domain: string;
  /** Estimated organic traffic per month, DataForSEO's own model. */
  organicTraffic: number | null;
  organicKeywords: number | null;
  /** Keywords by position band — the shape of a domain's visibility, not just its size. */
  positions: { top3: number; top10: number; top20: number; top100: number };
}

export interface DomainKeyword {
  keyword: string;
  position: number | null;
  url: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  /** Estimated traffic this one keyword sends to that URL. The reason the list is ordered this way. */
  traffic: number | null;
}

export interface DomainPage {
  url: string;
  keywords: number | null;
  traffic: number | null;
}

export interface DomainOverview {
  summary: DomainSummary;
  keywords: DomainKeyword[];
  pages: DomainPage[];
  cost: number;
  error?: string;
}

/** Strip scheme, `sc-domain:`, `www.` and any path — Labs wants a bare host. */
export const normDomain = (d: string) =>
  d.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^sc-domain:/, "")
    .replace(/^www\./, "")
    .split("/")[0];

/** All three domain calls are ordinary Labs tasks, priced per returned row like the rest. */
export function estimateDomainCost(keywordRows: number, pageRows: number): number {
  return (
    (LABS_TASK_COST + LABS_ROW_COST) +                            // rank overview, one row
    (LABS_TASK_COST + LABS_ROW_COST * Math.max(1, keywordRows)) + // ranked keywords
    (LABS_TASK_COST + LABS_ROW_COST * Math.max(1, pageRows))      // relevant pages
  );
}

function mapDomainKeyword(raw: any): DomainKeyword | null {
  const kd = raw?.keyword_data ?? {};
  const keyword = String(kd?.keyword ?? raw?.keyword ?? "").trim();
  if (!keyword) return null;

  const info = kd?.keyword_info ?? {};
  const props = kd?.keyword_properties ?? {};
  const ranked = raw?.ranked_serp_element ?? {};
  // The SERP element carries the ranking data twice at different nesting depths depending on the
  // item type; reading both is cheaper than branching on a type enum that may grow.
  const serp = ranked?.serp_item ?? {};

  return {
    keyword,
    position: serp?.rank_absolute ?? ranked?.rank_absolute ?? null,
    url: String(serp?.url ?? ranked?.url ?? ""),
    volume: info?.search_volume ?? null,
    difficulty: props?.keyword_difficulty ?? info?.keyword_difficulty ?? null,
    cpc: info?.cpc ?? null,
    traffic: serp?.etv ?? ranked?.etv ?? null,
  };
}

/**
 * Everything known about one domain's organic presence, in one call from the caller's side.
 *
 * Labs only. Google Ads has no equivalent — it prices keywords, it does not know who ranks for
 * them — so a Google-Ads-only country returns an explicit refusal rather than an empty result
 * that would read as "this domain ranks for nothing".
 */
export async function domainOverview(
  credential: string,
  target: string,
  opts: { gl?: string; hl?: string; keywordLimit?: number; pageLimit?: number } = {},
): Promise<DomainOverview> {
  const blank: DomainOverview = {
    summary: { domain: "", organicTraffic: null, organicKeywords: null, positions: { top3: 0, top10: 0, top20: 0, top100: 0 } },
    keywords: [], pages: [], cost: 0,
  };

  const domain = normDomain(target);
  if (!credential) return { ...blank, error: "no_key" };
  if (!domain.includes(".")) return { ...blank, error: "bad_domain" };

  const gl = (opts.gl || "us").toLowerCase();
  if (!isSupportedCountry(gl)) return { ...blank, error: `unsupported_country:${gl}` };
  if (providerFor(gl) === "google_ads") return { ...blank, error: "labs_only" };

  const hl = opts.hl || "en";
  const loc = locationCode(gl);
  const keywordLimit = Math.max(10, Math.min(1000, opts.keywordLimit ?? 200));
  const pageLimit = Math.max(10, Math.min(500, opts.pageLimit ?? 50));

  let cost = 0;

  const overview = await dfsPost(
    credential,
    "/v3/dataforseo_labs/google/domain_rank_overview/live",
    [{ target: domain, location_code: loc, language_code: hl, limit: 1 }],
    (task) => task?.result?.[0]?.items ?? [],
  );
  if (overview.error) return { ...blank, summary: { ...blank.summary, domain }, error: overview.error };
  cost += LABS_TASK_COST + LABS_ROW_COST;

  const organic = (overview.items[0] as any)?.metrics?.organic ?? {};
  const summary: DomainSummary = {
    domain,
    organicTraffic: organic?.etv == null ? null : Math.round(organic.etv),
    organicKeywords: organic?.count == null ? null : Math.round(organic.count),
    positions: {
      top3: Number(organic?.pos_1 ?? 0) + Number(organic?.pos_2_3 ?? 0),
      top10: Number(organic?.pos_4_10 ?? 0),
      top20: Number(organic?.pos_11_20 ?? 0),
      top100:
        Number(organic?.pos_21_30 ?? 0) + Number(organic?.pos_31_40 ?? 0) +
        Number(organic?.pos_41_50 ?? 0) + Number(organic?.pos_51_60 ?? 0) +
        Number(organic?.pos_61_70 ?? 0) + Number(organic?.pos_71_80 ?? 0) +
        Number(organic?.pos_81_90 ?? 0) + Number(organic?.pos_91_100 ?? 0),
    },
  };

  // A domain with no organic footprint is a complete answer, and the two remaining calls would
  // each cost a task fee to return nothing. Stop here.
  if (!summary.organicKeywords) return { ...blank, summary, cost };

  const ranked = await dfsPost(
    credential,
    "/v3/dataforseo_labs/google/ranked_keywords/live",
    [{
      target: domain,
      location_code: loc,
      language_code: hl,
      limit: keywordLimit,
      // Ordered by the traffic each keyword actually brings, not by its position: rank 1 on a
      // term nobody searches is not the top row of a useful list.
      order_by: ["ranked_serp_element.serp_item.etv,desc"],
      item_types: ["organic"],
      include_subdomains: true,
    }],
    (task) => task?.result?.[0]?.items ?? [],
  );
  if (!ranked.error) cost += LABS_TASK_COST + LABS_ROW_COST * Math.max(1, ranked.items.length);

  const pages = await dfsPost(
    credential,
    "/v3/dataforseo_labs/google/relevant_pages/live",
    [{ target: domain, location_code: loc, language_code: hl, limit: pageLimit }],
    (task) => task?.result?.[0]?.items ?? [],
  );
  if (!pages.error) cost += LABS_TASK_COST + LABS_ROW_COST * Math.max(1, pages.items.length);

  return {
    summary,
    keywords: (ranked.items.map(mapDomainKeyword).filter(Boolean) as DomainKeyword[]),
    pages: pages.items.map((p: any) => ({
      url: String(p?.page_address ?? ""),
      keywords: p?.metrics?.organic?.count ?? null,
      traffic: p?.metrics?.organic?.etv == null ? null : Math.round(p.metrics.organic.etv),
    })).filter((p: DomainPage) => p.url),
    cost,
    // A partial answer is still worth returning — the summary alone answers "is this domain
    // worth studying" — so a failure in either detail call is reported, not thrown.
    error: ranked.error || pages.error,
  };
}

/**
 * Hydrate a known keyword list with volume / difficulty / CPC / intent / trend.
 *
 * This is the endpoint behind "refresh weights" on a list the user already has — the discovery
 * endpoints above are for finding terms, this one is for pricing terms. Batched at
 * {@link KEYWORD_BATCH} because that is the API's ceiling and because per-keyword calls would
 * multiply the flat per-task fee by the length of the list.
 */
export async function keywordOverview(
  credential: string,
  keywords: string[],
  opts: { gl?: string; hl?: string; clickstream?: boolean } = {},
): Promise<{ rows: DemandRow[]; cost: number; error?: string }> {
  if (!credential) return { rows: [], cost: 0, error: "no_key" };

  const unique = [...new Set(keywords.map(normalizeKw).filter(Boolean))];
  if (!unique.length) return { rows: [], cost: 0 };

  const gl = (opts.gl || "us").toLowerCase();
  if (!isSupportedCountry(gl)) return { rows: [], cost: 0, error: `unsupported_country:${gl}` };

  // Google-Ads-only countries answer this question through `search_volume` instead, which returns
  // volume and CPC but neither difficulty nor intent.
  if (providerFor(gl) === "google_ads") {
    const out: DemandRow[] = [];
    let cost = 0;
    for (let i = 0; i < unique.length; i += 1000) {
      const batch = unique.slice(i, i + 1000);
      const r = await dfsPost(
        credential,
        "/v3/keywords_data/google_ads/search_volume/live",
        [{ keywords: batch, location_code: locationCode(gl), language_code: opts.hl || "en" }],
        (task) => task?.result ?? [],
      );
      if (r.error) return { rows: out, cost, error: r.error };
      cost += GOOGLE_ADS_CALL_COST;
      out.push(...(r.items.map(mapAdsRow).filter(Boolean) as DemandRow[]));
    }
    return { rows: dedupe(out), cost };
  }

  const out: DemandRow[] = [];
  let cost = 0;
  for (let i = 0; i < unique.length; i += KEYWORD_BATCH) {
    const batch = unique.slice(i, i + KEYWORD_BATCH);
    const r = await dfsPost(
      credential,
      "/v3/dataforseo_labs/google/keyword_overview/live",
      [{
        keywords: batch,
        location_code: locationCode(gl),
        language_code: opts.hl || "en",
        include_clickstream_data: opts.clickstream ?? false,
      }],
      (task) => task?.result?.[0]?.items ?? [],
    );
    if (r.error) return { rows: out, cost, error: r.error };
    cost += estimateOverviewCost(batch.length, opts.clickstream);
    out.push(...(r.items.map(mapLabsRow).filter(Boolean) as DemandRow[]));
  }

  return { rows: dedupe(out), cost };
}
