// GoAnyAPI — one client for the SEO datasets this app can actually use.
//
// Proposed in issue #4 by the vendor. Nine GET endpoints, one target per call, no batching and
// no pagination, `Authorization: Bearer`, everything wrapped in `{code, message, data}`. Five of
// them map onto something OpenGSC already does or visibly lacks; the rest are deliberately not
// here, and the reasons are worth keeping next to the code rather than in a closed issue:
//
//   • keyword-generator returns BUCKETS, not numbers — `volumeLabel: "MoreThanHundredThousand"`,
//     `difficultyLabel: "Hard"`. `DemandRow` is numeric and the keyword cache is shared across
//     providers, so turning a bucket into a number would serve an invented figure to an Ahrefs
//     user as if it had been measured. `keywordSource.ts` exists to prevent exactly that.
//   • adsense / transparency / ads-statistics are ad intelligence. There is nowhere in a search
//     console tool for them to live.
//
// And one limit that shapes how the SERP half is wired: this data is CACHED. Their own example
// carries `lastUpdate` several days behind with `source: "Serps"`, and the endpoint takes only
// `keyword` + `country` — no language, no depth, no device. That is fine for "who ranks here and
// how strong are they", and wrong for a rank tracker, which needs today's position to depth 50+.
// `lastUpdate` is therefore surfaced on every SERP response instead of being dropped, and
// `lib/rank.ts` refuses this provider outright.

const BASE = "https://goanyapi.com/api/v1";

/**
 * Every call reports what it spent and what is left.
 *
 * `remaining` comes from the provider's own `remainingCredits`, which means the balance is known
 * after any call without a separate billing request — worth carrying through the whole stack, so
 * a UI can warn before the wallet empties rather than after a 402.
 */
export interface GoAnyResult<T> {
  data: T | null;
  /** Credits this call cost, as reported by the provider (not guessed from a price table). */
  credits: number;
  remaining: number | null;
  /** Normalised: `no_key`, `bad_key`, `insufficient_credits`, `rate_limited`, or `goanyapi <status>: …`. */
  error?: string;
}

const fail = <T>(error: string): GoAnyResult<T> => ({ data: null, credits: 0, remaining: null, error });

/**
 * The reason each failure keeps its own name.
 *
 * A gateway has four failure modes a user can act on and they need different actions: a missing
 * key is a settings problem, a rejected key is a different settings problem, an empty wallet is a
 * billing problem, and a rate limit is a wait. Collapsing them into one string is how this
 * codebase previously produced `parse_failed` for a response that never contained JSON — the
 * label survived three layers and sent people looking for the wrong bug.
 */
function classify(status: number, bodyText: string): string {
  if (status === 401 || status === 403) return "bad_key";
  if (status === 402) return "insufficient_credits";
  if (status === 429) return "rate_limited";
  let msg = bodyText;
  try {
    const j = JSON.parse(bodyText);
    msg = j?.message || j?.error?.message || j?.error || bodyText;
  } catch { /* not JSON — keep the raw body */ }
  return `goanyapi ${status}: ${String(msg || "").slice(0, 200)}`;
}

/**
 * One GET, envelope unwrapped.
 *
 * A 429 is retried once against `Retry-After`, because the documented ceiling is about 5 requests
 * a second and the traffic/DR paths fan out over a list of domains — hitting it is routine rather
 * than exceptional. Nothing else is retried: a 402 retried is a 402, and a 400 retried is a 400.
 */
async function get<T>(
  apiKey: string, path: string, params: Record<string, string>, attempt = 0,
): Promise<GoAnyResult<T>> {
  if (!apiKey.trim()) return fail<T>("no_key");
  const qs = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await fetch(`${BASE}/${path}?${qs}`, {
      headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    return fail<T>(`goanyapi network: ${e?.cause?.code || e?.message || "fetch failed"}`);
  }

  if (res.status === 429 && attempt === 0) {
    const wait = Math.min(10, Math.max(1, parseInt(res.headers.get("Retry-After") || "2", 10) || 2));
    await new Promise(r => setTimeout(r, wait * 1000));
    return get<T>(apiKey, path, params, 1);
  }
  if (!res.ok) return fail<T>(classify(res.status, await res.text().catch(() => "")));

  let body: any;
  try { body = await res.json(); } catch { return fail<T>("goanyapi: non-JSON response"); }

  // A 200 with `code !== "ok"` is their in-band error channel. Treating it as success is how a
  // failure becomes an empty result three layers away.
  if (body?.code && body.code !== "ok") {
    return fail<T>(`goanyapi ${body.code}: ${String(body.message ?? "").slice(0, 200)}`);
  }
  const d = body?.data;
  if (!d) return fail<T>("goanyapi: empty data");

  return {
    data: d as T,
    credits: Number(d.costCredits ?? 0) || 0,
    remaining: Number.isFinite(Number(d.remainingCredits)) ? Number(d.remainingCredits) : null,
  };
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

// ─── SERP ──────────────────────────────────────────────────────────────────────

/**
 * A result row as this provider returns it: organic rows carry a metrics block no other SERP
 * source in this app supplies, and non-organic rows (`questions`, `ai_overview`) sit in the same
 * array rather than in sibling fields.
 */
export interface GoAnySerpRow {
  type: string;
  position: number;
  title?: string;
  url?: string;
  displayUrl?: string;
  metrics?: {
    domainRating?: number; urlRating?: number; traffic?: number;
    keywords?: number; topKeyword?: string; topVolume?: number; httpCode?: number;
  };
  questions?: { title?: string }[];
}

export interface GoAnySerp {
  keyword: string;
  country: string;
  /** When the provider last refreshed this SERP. Not decoration — see the header. */
  lastUpdate: string | null;
  rows: GoAnySerpRow[];
}

export async function goanySerp(apiKey: string, keyword: string, country = "us"): Promise<GoAnyResult<GoAnySerp>> {
  const r = await get<any>(apiKey, "serp", { keyword, country: country.toLowerCase() });
  if (!r.data) return { ...r, data: null };
  return {
    ...r,
    data: {
      keyword: String(r.data.keyword ?? keyword),
      country: String(r.data.country ?? country),
      lastUpdate: r.data.lastUpdate ? String(r.data.lastUpdate) : null,
      rows: Array.isArray(r.data?.serp?.results) ? r.data.serp.results : [],
    },
  };
}

// ─── Keyword difficulty ────────────────────────────────────────────────────────

export interface GoAnyKd {
  keyword: string;
  /** 0–100. */
  difficulty: number | null;
  /** Their own metric: roughly how many referring domains the top of this SERP is short by. */
  shortage: number | null;
  lastUpdate: string | null;
  rows: GoAnySerpRow[];
}

/**
 * Note what is NOT here: search volume for the queried keyword.
 *
 * The response carries `topVolume` per ranking page — the volume of that page's own best keyword,
 * which is a different number and routinely much larger. Reading it as the keyword's volume would
 * be the invented-data failure again, so `enrichKeywords` gets difficulty from this provider and
 * leaves volume null rather than filling it with something plausible.
 */
export async function goanyKeywordDifficulty(apiKey: string, keyword: string, country = "us"): Promise<GoAnyResult<GoAnyKd>> {
  const r = await get<any>(apiKey, "keyword-difficulty", { keyword, country: country.toLowerCase() });
  if (!r.data) return { ...r, data: null };
  return {
    ...r,
    data: {
      keyword: String(r.data.keyword ?? keyword),
      difficulty: num(r.data.difficulty),
      shortage: num(r.data.shortage),
      lastUpdate: r.data.lastUpdate ? String(r.data.lastUpdate) : null,
      rows: Array.isArray(r.data?.serp?.results) ? r.data.serp.results : [],
    },
  };
}

// ─── Domain Rating ─────────────────────────────────────────────────────────────

export interface GoAnyDr { domain: string; dr: number | null; ahrefsRank: number | null }

/**
 * A second source for a number this app already gets free.
 *
 * `/api/dr` reads Ahrefs' own public `domain-rating-free` endpoint, which costs nothing and comes
 * with a licence that requires the "Domain Rating by Ahrefs" credit. This path costs 2 credits
 * for the same figure — the response literally returns `domain_rating` and `ahrefs_rank` — so it
 * is wired as a FALLBACK, used only when no Ahrefs DR key is configured. Paying for the free
 * number would be the wrong default, and silently swapping the source under a licence-bound
 * attribution would be worse.
 */
export async function goanyDr(apiKey: string, domain: string): Promise<GoAnyResult<GoAnyDr>> {
  const r = await get<any>(apiKey, "dr", { domain });
  if (!r.data) return { ...r, data: null };
  return {
    ...r,
    data: {
      domain: String(r.data.domain ?? domain),
      dr: num(r.data.domain_rating),
      ahrefsRank: num(r.data.ahrefs_rank),
    },
  };
}

// ─── Traffic ───────────────────────────────────────────────────────────────────

export interface TrafficMonth { month: string; visits: number }
export interface TrafficCountry { code: string; share: number }
export interface TrafficKeyword { keyword: string; volume: number | null; cpc: number | null; estimatedValue: number | null }

/**
 * Channel shares, summing to ~1.
 *
 * `genAI` is the reason this endpoint is worth wiring at all. OpenGSC already tracks whether a
 * site is cited in AI answers (the AEO module) and has never been able to say whether that
 * visibility turns into sessions. This is the other half of that sentence.
 */
export interface TrafficSources {
  direct: number | null; search: number | null; searchPaid: number | null;
  social: number | null; socialPaid: number | null; referrals: number | null;
  mail: number | null; displayAds: number | null; affiliate: number | null;
  genAI: number | null;
}

export interface DomainTraffic {
  domain: string;
  siteName: string | null;
  title: string | null;
  description: string | null;
  /** The month `visits` and the engagement figures describe, as `YYYY-MM`. */
  period: string | null;
  visits: number | null;
  bounceRate: number | null;
  timeOnSite: number | null;
  pagesPerVisit: number | null;
  globalRank: number | null;
  countryCode: string | null;
  countryRank: number | null;
  monthly: TrafficMonth[];
  sources: TrafficSources;
  topCountries: TrafficCountry[];
  topKeywords: TrafficKeyword[];
}

// Their engagement block is spelled `Engagments`. Both spellings are read because a vendor fixing
// a typo should not silently blank out this card — the misspelling is what ships today, and the
// correction is the likelier future than a rename.
const engagementBlock = (d: any): any => d?.Engagments ?? d?.Engagements ?? {};

function sources(raw: any): TrafficSources {
  const s = raw ?? {};
  return {
    direct: num(s.Direct), search: num(s.Search), searchPaid: num(s.SearchPaid),
    social: num(s.Social), socialPaid: num(s.SocialPaid), referrals: num(s.Referrals),
    mail: num(s.Mail), displayAds: num(s.DisplayAds), affiliate: num(s.Affiliate),
    genAI: num(s.GenAI),
  };
}

export async function goanyTraffic(apiKey: string, domain: string): Promise<GoAnyResult<DomainTraffic>> {
  const r = await get<any>(apiKey, "traffic", { domain });
  if (!r.data) return { ...r, data: null };
  const d = r.data;
  const eng = engagementBlock(d);

  // `EstimatedMonthlyVisits` is an object keyed by date, not an array, so ordering is ours to
  // impose — chronological, because everything downstream draws it as a trend.
  const monthly: TrafficMonth[] = Object.entries(d.EstimatedMonthlyVisits ?? {})
    .map(([k, v]) => ({ month: String(k).slice(0, 7), visits: Number(v) || 0 }))
    .filter(m => /^\d{4}-\d{2}$/.test(m.month))
    .sort((a, b) => a.month.localeCompare(b.month));

  const month = num(eng.Month), year = num(eng.Year);
  const period = year && month ? `${year}-${String(month).padStart(2, "0")}` : (monthly.at(-1)?.month ?? null);

  return {
    ...r,
    data: {
      domain: String(d?.query?.domain ?? domain),
      siteName: d.SiteName ? String(d.SiteName) : null,
      title: d.Title ? String(d.Title) : null,
      description: d.Description ? String(d.Description) : null,
      period,
      // Engagement numbers arrive as strings. Reading `Visits` from here rather than from the
      // monthly map keeps every figure on this card describing the same month.
      visits: num(eng.Visits) ?? monthly.at(-1)?.visits ?? null,
      bounceRate: num(eng.BounceRate),
      timeOnSite: num(eng.TimeOnSite),
      pagesPerVisit: num(eng.PagePerVisit),
      globalRank: num(d?.GlobalRank?.Rank),
      countryCode: d?.CountryRank?.CountryCode ? String(d.CountryRank.CountryCode) : null,
      countryRank: num(d?.CountryRank?.Rank),
      monthly,
      sources: sources(d.TrafficSources),
      topCountries: (Array.isArray(d.TopCountryShares) ? d.TopCountryShares : [])
        .map((c: any) => ({ code: String(c?.CountryCode ?? ""), share: num(c?.Value) ?? 0 }))
        .filter((c: TrafficCountry) => c.code),
      topKeywords: (Array.isArray(d.TopKeywords) ? d.TopKeywords : [])
        .map((k: any) => ({
          keyword: String(k?.Name ?? ""), volume: num(k?.Volume),
          cpc: num(k?.Cpc), estimatedValue: num(k?.EstimatedValue),
        }))
        .filter((k: TrafficKeyword) => k.keyword),
    },
  };
}

// ─── Backlinks ─────────────────────────────────────────────────────────────────

export interface GoAnyBacklink {
  urlFrom: string;
  urlTo: string;
  anchor: string;
  domainRating: number | null;
  /** Present in the served HTML before JavaScript runs. */
  inRaw: boolean;
  /** Present after rendering. `inRendered && !inRaw` is a link Googlebot may never execute. */
  inRendered: boolean;
  title: string | null;
  textPre: string | null;
  textPost: string | null;
  redirectChain: string[];
}

export interface GoAnyBacklinkSummary {
  domain: string;
  domainRating: number | null;
  backlinks: number | null;
  dofollowBacklinks: number | null;
  refDomains: number | null;
  dofollowRefDomains: number | null;
  topBacklinks: GoAnyBacklink[];
}

/**
 * Read-only, and deliberately NOT plugged into `fetchBacklinkProfile`.
 *
 * That interface feeds `syncRefDomains`, which decides what is new and what is LOST by diffing a
 * stored profile against the incoming one. This endpoint returns `topBacklinks` — a sample, with
 * no documented row limit or pagination and no first-seen dates. Feeding a sample into a diff
 * would mark every referring domain outside the sample as lost, i.e. manufacture link-loss alerts
 * out of a smaller page size. So this stays a summary the user reads, not a profile the app
 * stores.
 *
 * What it does add that Ahrefs does not: `inRaw` vs `inRendered`. A link that exists only after
 * JavaScript is a link Google may never count, and until now nothing in the Link Monitor could
 * tell the two apart.
 */
export async function goanyBacklinks(apiKey: string, domain: string): Promise<GoAnyResult<GoAnyBacklinkSummary>> {
  const r = await get<any>(apiKey, "backlink", { domain });
  if (!r.data) return { ...r, data: null };
  const d = r.data;
  return {
    ...r,
    data: {
      domain: String(d.domain ?? domain),
      domainRating: num(d.domainRating),
      backlinks: num(d.backlinks),
      dofollowBacklinks: num(d.dofollowBacklinks),
      refDomains: num(d.refdomains),
      dofollowRefDomains: num(d.dofollowRefdomains),
      topBacklinks: (Array.isArray(d.topBacklinks) ? d.topBacklinks : []).map((b: any) => ({
        urlFrom: String(b?.urlFrom ?? ""),
        urlTo: String(b?.urlTo ?? ""),
        anchor: String(b?.anchor ?? ""),
        domainRating: num(b?.domainRating),
        inRaw: b?.inRaw === true,
        inRendered: b?.inRendered === true,
        title: b?.title ? String(b.title) : null,
        textPre: b?.textPre ? String(b.textPre) : null,
        textPost: b?.textPost ? String(b.textPost) : null,
        redirectChain: Array.isArray(b?.redirectChain) ? b.redirectChain.map(String) : [],
      })).filter((b: GoAnyBacklink) => b.urlFrom),
    },
  };
}
