// AEO Tracker core: server-side citation checks across AI answer engines for tracked
// questions. Mirrors the Rank Tracker pattern in lib/rank.ts — same "read keys from the
// server-side settings snapshot, persist a check row + denormalized latest state" shape.

import { prisma } from "@/lib/prisma";
import {
  runAeoCheck, AEO_ENGINES, AEO_DEFAULT_MODEL, hostOf,
  type AeoEngine, type AeoCheckResult, type AeoRunOptions, type AeoStatus,
} from "@/lib/seo/aeo";
import { rawQuery } from "@/lib/db/raw";

export const AEO_STALE_MS = 24 * 60 * 60 * 1000; // daily — AEO checks cost real money per engine

export interface AeoCreds { chatgpt?: string; perplexity?: string; claude?: string; grok?: string }

// Reads the user's server-side settings snapshot (User.seoSettings — the same mirror
// getUserSerpCreds in lib/rank.ts uses). ChatGPT/Claude reuse the existing generic AI
// provider keys (aiKey_openai / aiKey_anthropic, already used for content generation);
// Perplexity/Grok are AEO-specific keys (seoKey_perplexity / seoKey_xai) set alongside the
// SEO Tools SERP keys in Settings → SEO Tools.
export async function getUserAeoCreds(userId: string): Promise<AeoCreds> {
  try {
    const rows: any[] = await rawQuery(
      `SELECT seoSettings FROM "User" WHERE id = ?`, userId,
    );
    const raw = rows?.[0]?.seoSettings;
    if (!raw) return {};
    const s = JSON.parse(raw);
    return {
      chatgpt: s["aiKey_openai"] || undefined,
      claude: s["aiKey_anthropic"] || undefined,
      perplexity: s["seoKey_perplexity"] || undefined,
      grok: s["seoKey_xai"] || undefined,
    };
  } catch {
    return {};
  }
}

export function hasAnyAeoCreds(creds: AeoCreds): boolean {
  return !!(creds.chatgpt || creds.perplexity || creds.claude || creds.grok);
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
};
type LastResults = Partial<Record<AeoEngine, LastResult>>;

// Only the top few cited domains are denormalized onto the question row. The full list lives on
// the AeoCheck row; this copy exists so the table can render "who got cited instead of you"
// without a second query per row.
const TOP_DOMAINS_KEPT = 8;

function summarize(r: AeoCheckResult, host: string, prev: LastResult | undefined, now: Date): LastResult {
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
    };
  }
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
  };
}

// Check one tracked question across every engine the user has a key for; persist an
// AeoCheck row per engine plus the denormalized lastResults JSON.
export async function checkTrackedQuestion(
  q: { id: string; question: string; lastResults: string | null },
  cfg: AeoSiteConfig, creds: AeoCreds,
): Promise<Partial<Record<AeoEngine, AeoCheckResult>>> {
  const results: Partial<Record<AeoEngine, AeoCheckResult>> = {};
  const now = new Date();
  const host = hostOf(cfg.url);
  let lastResults: LastResults = {};
  try { lastResults = q.lastResults ? JSON.parse(q.lastResults) : {}; } catch { lastResults = {}; }

  for (const engine of AEO_ENGINES) {
    const key = creds[engine];
    if (!key) continue; // engine not configured — leave its last known state untouched
    const r = await runAeoCheck(engine, key, q.question, cfg.url, cfg.brandTerms, cfg.options);
    results[engine] = r;

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
        citations: r.citations.length ? JSON.stringify(r.citations.slice(0, 40)) : null,
        error: r.error ?? null,
      },
    });

    lastResults[engine] = summarize(r, host, lastResults[engine], now);

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
  for (const q of batch) {
    await checkTrackedQuestion({ id: q.id, question: q.question, lastResults: q.lastResults }, cfg, creds);
  }
  return { checked: batch.length, remaining: Math.max(0, all.length - batch.length) };
}
