// AEO Tracker core: server-side citation checks across AI answer engines for tracked
// questions. Mirrors the Rank Tracker pattern in lib/rank.ts — same "read keys from the
// server-side settings snapshot, persist a check row + denormalized latest state" shape.

import { prisma } from "@/lib/prisma";
import { runAeoCheck, AEO_ENGINES, type AeoEngine, type AeoCheckResult } from "@/lib/seo/aeo";
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

type LastResults = Partial<Record<AeoEngine, { cited: boolean; url: string | null; checkedAt: string; error?: string | null }>>;

// Check one tracked question across every engine the user has a key for; persist an
// AeoCheck row per engine plus the denormalized lastResults JSON.
export async function checkTrackedQuestion(
  q: { id: string; question: string; lastResults: string | null },
  siteUrl: string, brandTerms: string[], creds: AeoCreds,
): Promise<Partial<Record<AeoEngine, AeoCheckResult>>> {
  const results: Partial<Record<AeoEngine, AeoCheckResult>> = {};
  const now = new Date();
  const lastResults: LastResults = q.lastResults ? JSON.parse(q.lastResults) : {};

  for (const engine of AEO_ENGINES) {
    const key = creds[engine];
    if (!key) continue; // engine not configured — leave its last known state untouched
    const r = await runAeoCheck(engine, key, q.question, siteUrl, brandTerms);
    results[engine] = r;

    await prisma.aeoCheck.create({
      data: {
        questionId: q.id, engine, checkedAt: now,
        cited: r.error ? false : r.cited, url: r.url, snippet: r.snippet, error: r.error ?? null,
      },
    });

    lastResults[engine] = {
      cited: r.error ? (lastResults[engine]?.cited ?? false) : r.cited,
      url: r.url, checkedAt: now.toISOString(), error: r.error ?? null,
    };

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
  siteId: string, siteUrl: string, brandTerms: string[], creds: AeoCreds,
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
    await checkTrackedQuestion({ id: q.id, question: q.question, lastResults: q.lastResults }, siteUrl, brandTerms, creds);
  }
  return { checked: batch.length, remaining: Math.max(0, all.length - batch.length) };
}
