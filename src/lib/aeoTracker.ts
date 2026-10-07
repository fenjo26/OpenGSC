// AEO Tracker core: server-side citation checks across AI answer engines for tracked
// questions. Mirrors the Rank Tracker pattern in lib/rank.ts — same "read keys from the
// server-side settings snapshot, persist a check row + denormalized latest state" shape.

import { prisma } from "@/lib/prisma";
import {
  runAeoCheck, AEO_ENGINES, AEO_DEFAULT_MODEL, hostOf,
  type AeoEngine, type AeoCheckResult, type AeoRunOptions, type AeoStatus, type AioContext,
} from "@/lib/seo/aeo";
import { classifyCitations, categoryCounts, redditCut, type ClassifiedCitation } from "@/lib/seo/aeoCitationClassify";
import { brandNamesFromHost } from "@/lib/seo/localPack";
import { getAparserServerCreds } from "@/lib/seo/aparserServerCreds";
import { rawQuery } from "@/lib/db/raw";

export const AEO_STALE_MS = 24 * 60 * 60 * 1000; // daily — AEO checks cost real money per engine

export interface AeoCreds {
  chatgpt?: string;
  perplexity?: string;
  claude?: string;
  grok?: string;
  gemini?: string;
  chatgptBaseUrl?: string;
  claudeBaseUrl?: string;
  perplexityBaseUrl?: string;
  grokBaseUrl?: string;
  geminiBaseUrl?: string;
  chatgptModel?: string;
  claudeModel?: string;
  perplexityModel?: string;
  grokModel?: string;
  geminiModel?: string;
  /** The ai_overview engine has no key of Google's to pass — this names who fetches the SERP
   *  the overview is read from (DataForSEO key, else the owner's A-Parser connection). */
  ai_overview?: AioContext;
}

// Reads the user's server-side settings snapshot (User.seoSettings — the same mirror
// getUserSerpCreds in lib/rank.ts uses). ChatGPT/Claude/Gemini reuse the existing generic AI
// provider keys (aiKey_openai / aiKey_anthropic / aiKey_gemini, already used for content
// generation — the Gemini one is the "Google Gemini" provider in Settings → API keys, mirrored
// here by SeoKeysSync); Perplexity/Grok are AEO-specific keys (seoKey_perplexity / seoKey_xai)
// set alongside the SEO Tools SERP keys in Settings → SEO Tools. The ai_overview engine rides
// on the SERP infrastructure: the DataForSEO key (seoKey_dataforseo) when present, else the
// owner's A-Parser connection — DataForSEO first because it needs no instance of one's own.
export async function getUserAeoCreds(userId: string): Promise<AeoCreds> {
  let s: Record<string, unknown> = {};
  try {
    const rows = await rawQuery<{ seoSettings?: string | null }[]>(
      `SELECT seoSettings FROM "User" WHERE id = ?`, userId,
    );
    const raw = rows?.[0]?.seoSettings;
    if (raw) s = JSON.parse(raw);
  } catch { s = {}; }

  let aiOverview: AioContext | undefined;
  const dfsKey = String(s["seoKey_dataforseo"] ?? "").trim();
  if (dfsKey) {
    aiOverview = { provider: "dataforseo", dataForSeoKey: dfsKey };
  } else {
    // getAparserServerCreds pings to pick between env/settings passwords (cached a minute), so
    // it is only consulted when it can actually decide the engine's availability.
    const ap = await getAparserServerCreds(userId);
    if (ap) aiOverview = { provider: "aparser", aparser: { baseUrl: ap.baseUrl, password: ap.password, ...(ap.configPreset ? { configPreset: ap.configPreset } : {}) } };
  }

  // Settings values arrive as unknown JSON; a non-string at any of these slots is "not set",
  // never a crash on the read path.
  const str = (key: string): string | undefined => {
    const v = s[key];
    return typeof v === "string" && v ? v : undefined;
  };

  return {
    chatgpt: str("aiKey_openai"),
    claude: str("aiKey_anthropic"),
    gemini: str("aiKey_gemini"),
    perplexity: str("seoKey_perplexity"),
    grok: str("seoKey_xai"),
    chatgptBaseUrl: str("aiBaseUrl_openai"),
    claudeBaseUrl: str("aiBaseUrl_anthropic"),
    geminiBaseUrl: str("aiBaseUrl_gemini"),
    perplexityBaseUrl: str("seoBaseUrl_perplexity"),
    grokBaseUrl: str("seoBaseUrl_xai"),
    chatgptModel: str("aiModel_openai"),
    claudeModel: str("aiModel_anthropic"),
    geminiModel: str("aiModel_gemini"),
    perplexityModel: str("seoModel_perplexity"),
    grokModel: str("seoModel_xai"),
    ai_overview: aiOverview,
  };
}

export function hasAnyAeoCreds(creds: AeoCreds): boolean {
  return !!(creds.chatgpt || creds.perplexity || creds.claude || creds.grok || creds.gemini || creds.ai_overview);
}

// Site.brandedKeywords is JSON array text (e.g. '["ikea","ikea chair"]'); tolerate a plain
// comma-separated fallback too.
export function parseBrandTerms(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
  } catch { /* fall through to comma-separated */ }
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

// The subset of Site the checker needs. Passed around explicitly so the scheduler and the API
// route cannot drift into checking with different settings.
export interface AeoSiteConfig {
  url: string;
  brandTerms: string[];
  options: AeoRunOptions;
}

// Country falls back to the site's search market rather than to a default: "no location" and
// "United States" are different questions to ask an answer engine, and only one of them is
// honest about not knowing.
export function siteAeoConfig(site: {
  url: string; brandedKeywords?: string | null; market?: string | null;
  aeoModel?: string | null; aeoCountry?: string | null; aeoCity?: string | null; aeoLanguage?: string | null;
}): AeoSiteConfig {
  return {
    url: site.url,
    brandTerms: parseBrandTerms(site.brandedKeywords),
    options: {
      model: site.aeoModel || AEO_DEFAULT_MODEL,
      country: site.aeoCountry || site.market || null,
      city: site.aeoCity || null,
      language: site.aeoLanguage || null,
    },
  };
}

type LastResult = {
  cited: boolean; status: AeoStatus; url: string | null; rank: number | null;
  citedDomains: string[]; searched: boolean; model: string | null;
  checkedAt: string; error?: string | null;
  /** Wave A citation classification of this check's citations: non-zero category counts and,
   *  when Reddit shows up, the subreddit cut. Absent on rows written before the wave and on
   *  checks with no citations — undefined drops out of the JSON, keeping old payloads intact. */
  categoryCounts?: Record<string, number>;
  reddit?: { count: number; subreddits: { name: string; count: number }[] };
};
type LastResults = Partial<Record<AeoEngine, LastResult>>;

// Only the top few cited domains are denormalized onto the question row. The full list lives on
// the AeoCheck row; this copy exists so the table can render "who got cited instead of you"
// without a second query per row.
const TOP_DOMAINS_KEPT = 8;

/** Brand/competitor domains the citation classifier needs. Brand = the site host plus the brand
 *  spellings guessed from it (brandNamesFromHost); competitor = the same aeoCompetitors list
 *  share of voice reads. */
export interface CitationClassifyContext {
  brandDomains: string[];
  competitorDomains: string[];
}

export function defaultCitationContext(siteUrl: string): CitationClassifyContext {
  const host = hostOf(siteUrl);
  return { brandDomains: [host, ...brandNamesFromHost(host)].filter(Boolean), competitorDomains: [] };
}

function summarize(
  r: AeoCheckResult, host: string, prev: LastResult | undefined, now: Date,
  classified: ClassifiedCitation[] = [],
): LastResult {
  const domains: string[] = [];
  for (const c of r.citations) if (c.domain && !domains.includes(c.domain)) domains.push(c.domain);

  // An errored check must not overwrite a known-good verdict with "absent" — a rate limit is
  // not evidence that the citation disappeared.
  if (r.error) {
    return {
      cited: prev?.cited ?? false,
      status: prev?.status ?? "absent",
      url: prev?.url ?? null,
      rank: prev?.rank ?? null,
      citedDomains: prev?.citedDomains ?? [],
      searched: prev?.searched ?? false,
      model: r.model ?? prev?.model ?? null,
      checkedAt: now.toISOString(),
      error: r.error,
      categoryCounts: prev?.categoryCounts,
      reddit: prev?.reddit,
    };
  }
  const counts = categoryCounts(classified);
  const reddit = redditCut(classified);
  return {
    cited: r.cited,
    status: r.status,
    url: r.url,
    rank: r.rank,
    citedDomains: domains.slice(0, TOP_DOMAINS_KEPT).filter(d => d !== host),
    searched: r.searched,
    model: r.model,
    checkedAt: now.toISOString(),
    error: null,
    ...(counts.length ? { categoryCounts: Object.fromEntries(counts.map(c => [c.category, c.count])) } : {}),
    ...(reddit.count ? { reddit } : {}),
  };
}

// Check one tracked question across every engine the user has a key for; persist an
// AeoCheck row per engine plus the denormalized lastResults JSON. Citations are classified
// (Wave A) before they are stored — category/pageType ride inside the citations JSON, so the
// schema stays as it is.
export async function checkTrackedQuestion(
  q: { id: string; question: string; lastResults: string | null },
  cfg: AeoSiteConfig, creds: AeoCreds,
  classifyCtx?: CitationClassifyContext,
): Promise<Partial<Record<AeoEngine, AeoCheckResult>>> {
  const results: Partial<Record<AeoEngine, AeoCheckResult>> = {};
  const now = new Date();
  const host = hostOf(cfg.url);
  // Brand context always resolves (the host itself is a brand domain); the competitor half is
  // what checkSiteQuestions adds from Site.aeoCompetitors.
  const classify = classifyCtx ?? defaultCitationContext(cfg.url);
  let lastResults: LastResults = {};
  try { lastResults = q.lastResults ? JSON.parse(q.lastResults) : {}; } catch { lastResults = {}; }

  for (const engine of AEO_ENGINES) {
    // The ai_overview engine runs on the SERP context instead of a key; every other engine
    // needs its own key or its last known state stays untouched.
    if (engine === "ai_overview" && !creds.ai_overview) continue;
    const key = engine === "ai_overview" ? "aio" : creds[engine as Exclude<AeoEngine, "ai_overview">];
    if (!key) continue;
    const engineOpts: AeoRunOptions = { ...cfg.options };
    if (engine === "ai_overview") {
      engineOpts.aio = creds.ai_overview ?? null;
    } else if (engine === "claude") {
      if (creds.claudeBaseUrl) engineOpts.baseUrl = creds.claudeBaseUrl;
      if (creds.claudeModel) engineOpts.model = creds.claudeModel;
    } else if (engine === "chatgpt") {
      if (creds.chatgptBaseUrl) engineOpts.baseUrl = creds.chatgptBaseUrl;
      if (cfg.options.model) engineOpts.model = cfg.options.model;
      else if (creds.chatgptModel) engineOpts.model = creds.chatgptModel;
    } else if (engine === "perplexity") {
      if (creds.perplexityBaseUrl) engineOpts.baseUrl = creds.perplexityBaseUrl;
      if (creds.perplexityModel) engineOpts.model = creds.perplexityModel;
    } else if (engine === "grok") {
      if (creds.grokBaseUrl) engineOpts.baseUrl = creds.grokBaseUrl;
      if (creds.grokModel) engineOpts.model = creds.grokModel;
    } else if (engine === "gemini") {
      if (creds.geminiBaseUrl) engineOpts.baseUrl = creds.geminiBaseUrl;
      if (creds.geminiModel) engineOpts.model = creds.geminiModel;
    }

    const r = await runAeoCheck(engine, key, q.question, cfg.url, cfg.brandTerms, engineOpts);
    results[engine] = r;

    const classified = classifyCitations(r.citations.slice(0, 40), classify.brandDomains, classify.competitorDomains);

    await prisma.aeoCheck.create({
      data: {
        questionId: q.id, engine, checkedAt: now,
        cited: r.error ? false : r.cited,
        status: r.error ? null : r.status,
        url: r.url,
        snippet: r.snippet,
        rank: r.rank,
        model: r.model,
        searched: r.error ? null : r.searched,
        // Trimmed: a tracked question checked daily across four engines would otherwise grow
        // an unbounded text column forever. Enough to see what the engine actually said.
        answerText: r.answerText ? r.answerText.slice(0, 12000) : null,
        citations: classified.length ? JSON.stringify(classified) : null,
        error: r.error ?? null,
      },
    });

    lastResults[engine] = summarize(r, host, lastResults[engine], now, classified);

    // Small delay between engine calls — kind to rate limits, and these are billed API calls.
    await new Promise(res => setTimeout(res, 500));
  }

  await prisma.trackedQuestion.update({
    where: { id: q.id },
    data: { lastCheckedAt: now, lastResults: JSON.stringify(lastResults) },
  });

  return results;
}

// Check up to `limit` stale (or all, when force=true) questions for a site.
export async function checkSiteQuestions(
  siteId: string, cfg: AeoSiteConfig, creds: AeoCreds,
  opts: { force?: boolean; limit?: number; onlyIds?: string[] } = {},
): Promise<{ checked: number; remaining: number }> {
  const limit = opts.limit ?? 5; // small — each question is up to 4 sequential billed API calls
  const staleBefore = new Date(Date.now() - AEO_STALE_MS);
  const where: any = { siteId };
  if (opts.onlyIds?.length) where.id = { in: opts.onlyIds };
  else if (!opts.force) where.OR = [{ lastCheckedAt: null }, { lastCheckedAt: { lt: staleBefore } }];

  const all = await prisma.trackedQuestion.findMany({ where, orderBy: [{ lastCheckedAt: "asc" }] });
  const batch = all.slice(0, limit);

  // Competitor domains for citation classification, read here rather than trusted from the
  // callers: the scheduler's site select does not carry aeoCompetitors, and one tiny query per
  // batch beats every caller having to remember it.
  let competitorDomains: string[] = [];
  try {
    const site = await prisma.site.findUnique({ where: { id: siteId }, select: { aeoCompetitors: true } });
    const parsed = site?.aeoCompetitors ? JSON.parse(site.aeoCompetitors) : [];
    if (Array.isArray(parsed)) {
      competitorDomains = parsed.map((c: { domain?: unknown }) => hostOf(String(c?.domain ?? ""))).filter(Boolean);
    }
  } catch { competitorDomains = []; } // missing column / corrupt blob → classify without rivals
  const classifyCtx = { ...defaultCitationContext(cfg.url), competitorDomains };

  for (const q of batch) {
    await checkTrackedQuestion({ id: q.id, question: q.question, lastResults: q.lastResults }, cfg, creds, classifyCtx);
  }
  return { checked: batch.length, remaining: Math.max(0, all.length - batch.length) };
}
