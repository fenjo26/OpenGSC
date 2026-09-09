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
//   • adsense / ads-statistics ad-intelligence endpoints were once left out for having nowhere
//     to live. The Transparency family and the ads-statistics actions now power the site
//     dashboard's Ads tab (`AdsIntelTab` + `/api/ads-intel`), so they live here too; the plain
//     AdSense reverse endpoints still wait for a reason to exist.
//
// And one limit that shapes how the SERP half is wired: this data is CACHED. Their own example
// carries `lastUpdate` several days behind with `source: "Serps"`, and the endpoint takes only
// `keyword` + `country` — no language, no depth, no device. That is fine for "who ranks here and
// how strong are they", and wrong for a rank tracker, which needs today's position to depth 50+.
// `lastUpdate` is therefore surfaced on every SERP response instead of being dropped, and
// `lib/rank.ts` refuses this provider outright.

import { loggedFetch, type CallHandle } from "@/lib/providerLog/log";

// The documented host moved to api.goanyapi.com; the bare domain answered before, but the
// docs' examples and the error taxonomy both now name the api. subdomain.
const BASE = "https://api.goanyapi.com/api/v1";

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
  let call: CallHandle;
  try {
    // `attempt` counts from 0 here and from 1 in the log, where attempt 1 is a single-shot call.
    ({ res, call } = await loggedFetch(`${BASE}/${path}?${qs}`, {
      headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    }, { provider: "goanyapi", attempt: attempt + 1 }));
  } catch (e: any) {
    return fail<T>(`goanyapi network: ${e?.cause?.code || e?.message || "fetch failed"}`);
  }

  if (res.status === 429 && attempt === 0) {
    // A rate-limited request is still a request the provider answered, and the retry below opens
    // a row of its own. Two rows is the truth here; one would hide a round trip.
    call.finish({ error: "goanyapi 429" });
    const wait = Math.min(10, Math.max(1, parseInt(res.headers.get("Retry-After") || "2", 10) || 2));
    await new Promise(r => setTimeout(r, wait * 1000));
    return get<T>(apiKey, path, params, 1);
  }
  if (!res.ok) {
    const error = classify(res.status, await res.text().catch(() => ""));
    call.finish({ error });
    return fail<T>(error);
  }

  let body: any;
  try { body = await res.json(); } catch {
    call.finish({ error: "goanyapi: non-JSON response" });
    return fail<T>("goanyapi: non-JSON response");
  }

  // A 200 with `code !== "ok"` is their in-band error channel. Treating it as success is how a
  // failure becomes an empty result three layers away.
  if (body?.code && body.code !== "ok") {
    const error = `goanyapi ${body.code}: ${String(body.message ?? "").slice(0, 200)}`;
    call.finish({ error, responseBody: body });
    return fail<T>(error);
  }
  const d = body?.data;
  if (!d) {
    call.finish({ error: "goanyapi: empty data", responseBody: body });
    return fail<T>("goanyapi: empty data");
  }

  // `costCredits` below is what this request cost in GoAnyAPI credits, and credits are not
  // dollars: what a credit is worth depends on the plan the key was bought on, which this app
  // never sees. Putting it in `costUsd` would produce a number that reads as money and is not,
  // so the row's cost stays null and the credit count keeps travelling in the result as before.
  call.finish({ responseBody: body });

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
  /** Which vendor estimated these figures — "goanyapi" or "semrush". Old cached rows predate
   *  the field and read as "goanyapi", the only source there was at the time. */
  provider?: string;
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
      provider: "goanyapi",
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
      // GenAI rides in TrafficSources; newer responses also carry a dedicated aiTraffic block
      // with the share spelled out — accepted as the fallback, never as a second source of truth.
      sources: { ...sources(d.TrafficSources), genAI: num(sources(d.TrafficSources).genAI) ?? num(d?.aiTraffic?.share) },
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

// ─── Credit balance ────────────────────────────────────────────────────────────

export interface GoAnyBalance { remaining: number | null }

/** Free, one call: the wallet the traffic/KD/SERP calls spend from. */
export async function goanyBalance(apiKey: string): Promise<GoAnyResult<GoAnyBalance>> {
  const r = await get<any>(apiKey, "credits/balance", {});
  if (!r.data) return { ...r, data: null };
  return { ...r, data: { remaining: num(r.data.remainingCredits) } };
}

// ─── Domain Rating history ─────────────────────────────────────────────────────

export interface GoAnyDrMonth { month: string; dr: number | null }
export interface GoAnyDrHistory {
  domain: string;
  /** Chronological YYYY-MM rows; `dr` is null in the free preview, which only reveals
   *  which months exist and what the full answer will cost. */
  history: GoAnyDrMonth[];
}

/**
 * DR per month, for as far back as Ahrefs' index reaches into the domain.
 *
 * The two-stage pricing is part of the design: `includeDr=false` is a free preview listing
 * the months on file, so a caller can price the paid answer before committing — the charge
 * is 2 credits per returned month, and the preview exists precisely so "how far back" is
 * never a surprise. A DR series is the veto signal a single DR number can never be: a domain
 * sitting at DR 22→24→12→11→8 did not lose links, it was hit, and the drops funnel should
 * read that as a spam-period flag rather than a bargain.
 */
export async function goanyDrHistory(
  apiKey: string, domain: string, includeDr: boolean,
): Promise<GoAnyResult<GoAnyDrHistory>> {
  const r = await get<any>(apiKey, "dr-history", { domain, ...(includeDr ? { includeDr: "true" } : {}) });
  if (!r.data) return { ...r, data: null };
  const rows = Array.isArray(r.data.history) ? r.data.history : [];
  return {
    ...r,
    data: {
      domain: String(r.data?.query?.domain ?? domain),
      history: rows.map((m: any) => {
        const raw = String(m?.month ?? "");
        // Months arrive numeric YYYYMM; normalized to YYYY-MM like every other series here.
        const month = /^\d{6}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}` : raw;
        return { month, dr: m?.dr == null ? null : num(m.dr) };
      }).filter((m: GoAnyDrMonth) => /^\d{4}-\d{2}$/.test(m.month))
        .sort((a: GoAnyDrMonth, b: GoAnyDrMonth) => a.month.localeCompare(b.month)),
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

// ─── Ads Transparency (the site dashboard's Ads tab) ───────────────────────────
//
// A mirror of Google's Ads Transparency Center: who advertises for a domain, with what copy,
// which creatives, where, and how the weekly activity develops. Everything here is read-only
// lookups billed in credits — 4 for the advertiser mapping, 5 per ads-statistics action — and
// the documented chain matters: domain → `domainSearch` yields the hostId that titles,
// statistics, image ads and title countries all require. Weekly ranges cap at 48 Google Ads
// buckets (days 1–7, 8–14, 15–21, 22–month end), so the callers keep spans under ~330 days.

export interface GoAnyAdvertiser {
  advertiser: string;
  country: string;
  adsCount: number | null;
  creativeIds: string[];
}

/**
 * The advertiser mapping for one domain — the overview the Ads tab opens with. This is the
 * answer no other provider here gives: which advertisers (agencies, affiliate programs, brands)
 * put Google ads on a domain's behalf.
 */
export async function goanyTransparencyDomain(apiKey: string, domain: string): Promise<GoAnyResult<GoAnyAdvertiser[]>> {
  const r = await get<any>(apiKey, "transparency", { domain });
  if (!r.data) return { ...r, data: null };
  const rows = Array.isArray(r.data.advertisers) ? r.data.advertisers : [];
  return {
    ...r,
    data: rows.map((a: any) => ({
      advertiser: String(a?.advertiser ?? ""),
      country: String(a?.country ?? ""),
      adsCount: num(a?.adsCount),
      creativeIds: Array.isArray(a?.creativeIds) ? a.creativeIds.map(String) : [],
    })).filter((a: GoAnyAdvertiser) => a.advertiser),
  };
}

export interface GoAnyKeywordAds {
  keyword: string;
  advertisers: { name: string; country: string; id: string; adsCount: number | null }[];
  /** Domains buying ads on this keyword — the "who else is here" answer. */
  domains: string[];
}

/**
 * Keyword mode of the same transparency endpoint: who buys Google ads around a keyword.
 * This is the reverse of the domain view — instead of "who advertises for this domain" it
 * answers "which advertisers and which OTHER domains show up here", which is the competitive
 * read and the reason the tab has a keyword search.
 */
export async function goanyTransparencyKeyword(apiKey: string, keyword: string): Promise<GoAnyResult<GoAnyKeywordAds>> {
  const r = await get<any>(apiKey, "transparency", { keyword });
  if (!r.data) return { ...r, data: null };
  return {
    ...r,
    data: {
      keyword: String(r.data.keyword ?? keyword),
      advertisers: (Array.isArray(r.data.advertisers) ? r.data.advertisers : []).map((a: any) => ({
        name: String(a?.name ?? ""),
        country: String(a?.country ?? ""),
        id: String(a?.id ?? ""),
        adsCount: num(a?.adsCount),
      })).filter((a: { name: string }) => a.name),
      domains: (Array.isArray(r.data.domains) ? r.data.domains : []).map(String).filter(Boolean),
    },
  };
}

export interface GoAnyHost { domain: string; host: string; id: number }

/** The hostId every ads-statistics detail action requires. */
export async function goanyDomainSearch(apiKey: string, domain: string): Promise<GoAnyResult<GoAnyHost | null>> {
  const r = await get<any>(apiKey, "ads-statistics", { action: "domainSearch", keyword: domain });
  if (!r.data) return { ...r, data: null };
  const rows = Array.isArray(r.data.result) ? r.data.result : [];
  const hit = rows.find((x: any) => String(x?.domain ?? "").replace(/^www\./, "") === domain.replace(/^www\./, "")) ?? rows[0];
  if (!hit) return { ...r, data: null, error: r.error ?? "no_data" };
  return { ...r, data: { domain: String(hit.domain ?? domain), host: String(hit.host ?? ""), id: Number(hit.id) } };
}

export interface GoAnyAdTitle { title: string; startDay: string; endDay: string }

/** Ad copy for one domain, with the window each title ran in. */
export async function goanyDomainTitles(apiKey: string, hostId: number, startDay: string, endDay: string): Promise<GoAnyResult<GoAnyAdTitle[]>> {
  const r = await get<any>(apiKey, "ads-statistics", { action: "domainTitles", hostId: String(hostId), startDay, endDay });
  if (!r.data) return { ...r, data: null };
  const rows = Array.isArray(r.data.result) ? r.data.result : [];
  return {
    ...r,
    data: rows.map((t: any) => ({
      title: String(t?.title ?? ""),
      startDay: String(t?.startDay ?? ""),
      endDay: String(t?.endDay ?? ""),
    })).filter((t: GoAnyAdTitle) => t.title),
  };
}

export interface GoAnyWeekCountry { country: string; countryName: string; adCount: number | null }
export interface GoAnyWeekAdvertiser { advertiser: string; country: string; adCount: number | null; countries: GoAnyWeekCountry[] }
export interface GoAnyWeekRow { month: string; week: number; advertisers: GoAnyWeekAdvertiser[] }
export interface GoAnyDomainStatistics { weeks: GoAnyWeekRow[]; totals: GoAnyWeekAdvertiser[] }

/**
 * Weekly ad-count activity for one domain: per week, per advertiser, with each advertiser's
 * country split. Aggregated here into `weeks` (chronological) and `totals` (per advertiser),
 * which is the shape the tab's trend bars and top-advertisers table read.
 */
export async function goanyDomainStatistics(
  apiKey: string, hostId: number, startDay: string, endDay: string,
): Promise<GoAnyResult<GoAnyDomainStatistics>> {
  const r = await get<any>(apiKey, "ads-statistics", { action: "domainStatistics", hostId: String(hostId), startDay, endDay });
  if (!r.data) return { ...r, data: null };
  const result = r.data.result ?? {};
  const weeks: GoAnyWeekRow[] = (Array.isArray(result.weekAdvertiserStatistics) ? result.weekAdvertiserStatistics : [])
    .map((w: any) => ({
      month: String(w?.month ?? ""),
      week: num(w?.week) ?? 0,
      advertisers: (Array.isArray(w?.adsHostAdvertiserWeeklyList) ? w.adsHostAdvertiserWeeklyList : []).map((a: any) => ({
        advertiser: String(a?.advertiser?.advertiser ?? ""),
        country: String(a?.advertiser?.country ?? ""),
        adCount: num(a?.adCount),
        countries: (Array.isArray(a?.countries) ? a.countries : []).map((c: any) => ({
          country: String(c?.country ?? ""),
          countryName: String(c?.countryName ?? ""),
          adCount: num(c?.adCount),
        })),
      })).filter((a: GoAnyWeekAdvertiser) => a.advertiser),
    }))
    .filter((w: GoAnyWeekRow) => w.month)
    .sort((a: GoAnyWeekRow, b: GoAnyWeekRow) => (a.month + String(a.week).padStart(2, "0")).localeCompare(b.month + String(b.week).padStart(2, "0")));

  const totals = new Map<string, GoAnyWeekAdvertiser>();
  for (const w of weeks) {
    for (const a of w.advertisers) {
      const cur = totals.get(a.advertiser);
      if (!cur) totals.set(a.advertiser, { ...a, countries: a.countries.map(c => ({ ...c })) });
      else {
        cur.adCount = (cur.adCount ?? 0) + (a.adCount ?? 0);
        for (const c of a.countries) {
          const cc = cur.countries.find(x => x.country === c.country);
          if (cc) cc.adCount = (cc.adCount ?? 0) + (c.adCount ?? 0);
          else cur.countries.push({ ...c });
        }
      }
    }
  }
  return { ...r, data: { weeks, totals: [...totals.values()].sort((a, b) => (b.adCount ?? 0) - (a.adCount ?? 0)) } };
}

/**
 * Image creatives for one domain: a map from the Google Ads Transparency detail URL to the
 * asset it carries (a static image or an HTML bundle — the URL shape tells which). Values are
 * publicly fetchable Google asset hosts and render directly in an <img>.
 */
export async function goanyDomainImageAds(apiKey: string, hostId: number, startDay: string, endDay: string): Promise<GoAnyResult<Record<string, string>>> {
  const r = await get<any>(apiKey, "ads-statistics", { action: "domainImageAds", hostId: String(hostId), startDay, endDay });
  if (!r.data) return { ...r, data: null };
  const result = r.data.result ?? {};
  const out: Record<string, string> = {};
  for (const [detailUrl, asset] of Object.entries(result)) {
    if (typeof asset === "string" && asset) out[detailUrl] = asset;
  }
  return { ...r, data: out };
}

export interface GoAnyTitleCountry { country: string; countryName: string; adCount: number | null }

/** Where one ad title ran. The API answers positional arrays; named here so no consumer ever
 *  has to know that. */
export async function goanyTitleCountries(apiKey: string, hostId: number, title: string, startDay: string, endDay: string): Promise<GoAnyResult<GoAnyTitleCountry[]>> {
  const r = await get<any>(apiKey, "ads-statistics", {
    action: "domainTitleCountries", hostId: String(hostId), title, startDay, endDay,
  });
  if (!r.data) return { ...r, data: null };
  const rows = Array.isArray(r.data.result) ? r.data.result : [];
  return {
    ...r,
    data: rows.map((row: any) => Array.isArray(row) ? {
      country: String(row[2] ?? ""),
      countryName: String(row[1] ?? ""),
      adCount: num(row[3]),
    } : {
      country: String(row?.country ?? ""),
      countryName: String(row?.countryName ?? ""),
      adCount: num(row?.adCount),
    }).filter((c: GoAnyTitleCountry) => c.country || c.countryName),
  };
}
