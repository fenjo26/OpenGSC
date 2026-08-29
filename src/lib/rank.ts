// Rank Tracker core: server-side keyword position checks via the user's SERP provider.
//
// Keys: the browser-side SEO Tools keys are mirrored to User.seoSettings (SeoKeysSync),
// so the server (API routes + scheduler) reads them from there — no extra setup needed.
//
// Scrape strategy ("smart", inspired by SerpBear): if we know the keyword's last
// position we only scan a window around it (lastPosition + buffer). If the keyword
// isn't found in that window we escalate once to the provider's max depth.

import { prisma } from "@/lib/prisma";
import { runSerp } from "@/lib/seo/serp";
import { rawQuery } from "@/lib/db/raw";

export const RANK_STALE_MS = 20 * 60 * 60 * 1000; // ~daily, resilient to restarts

const MAX_DEPTH: Record<string, number> = { serper: 50, dataforseo: 100, scrapingrobot: 50 };
const SMART_BUFFER = 20;

/**
 * SERP providers this tracker will not use, and why refusing beats degrading.
 *
 * GoAnyAPI is a real SERP source and is wired into `runSerp` for content and competitor work.
 * It cannot answer this question: it serves from a cache (its own responses carry a `lastUpdate`
 * days behind), it takes no depth parameter, and it takes no language. A tracker running on it
 * would still draw a chart — a chart of last week's positions, truncated at whatever depth the
 * provider felt like returning, and indistinguishable on screen from a correct one. A wrong
 * rank history is worse than a missing one, because the missing one gets fixed.
 *
 * The message names the setting rather than the failure, because the fix is one dropdown away.
 */
const RANK_UNSUPPORTED: Record<string, string> = {
  goanyapi:
    "GoAnyAPI serves cached SERPs with no depth or language control, so it cannot measure today's position. " +
    "Pick Serper, DataForSEO or ScrapingRobot for Rank Tracker in Settings → SEO Tools (the Rank Tracker provider is set separately from the one used elsewhere).",
};

export interface SerpCreds { provider: string; apiKey: string; baseUrl?: string }

/**
 * SERP providers whose host the user supplies, and which are therefore only "configured" when
 * BOTH slots are filled.
 *
 * The fallback loop below tests the key alone, which is correct for every metered provider: a
 * key is the whole credential. For a self-hosted one it is half of it, and treating a lone
 * password as configured picks a provider that cannot be reached and fails every scheduled
 * check from then on — with an error about the network, not about the setting that is missing.
 */
const SELF_HOSTED_PROVIDERS = new Set<string>(["aparser"]);

function configuredIn(s: any, provider: string): SerpCreds | null {
  const apiKey = String(s[`seoKey_${provider}`] ?? "");
  if (!apiKey) return null;
  const baseUrl = String(s[`seoBaseUrl_${provider}`] ?? "");
  if (SELF_HOSTED_PROVIDERS.has(provider) && !baseUrl) return null;
  return { provider, apiKey, ...(baseUrl ? { baseUrl } : {}) };
}

// Read the user's SERP provider + key from the server-side settings snapshot.
export async function getUserSerpCreds(userId: string): Promise<SerpCreds | null> {
  try {
    const rows: any[] = await rawQuery(
      `SELECT seoSettings FROM "User" WHERE id = ?`, userId,
    );
    const raw = rows?.[0]?.seoSettings;
    if (!raw) return null;
    const s = JSON.parse(raw);
    // Rank Tracker can use its own provider override (independent from the one used for
    // content generation/SERP analysis in SEO Tools) — set in Settings → SEO Tools; falls
    // back to the general active provider when unset.
    const provider = s.seoSerpProvider_rank || s.seoSerpProvider || "serper";
    const chosen = configuredIn(s, provider);
    // An unsupported provider is treated exactly like a missing key: fall through to whatever
    // else is configured. Someone who set GoAnyAPI as their app-wide SERP source and never
    // touched the Rank Tracker override should keep tracking on the key they already have,
    // rather than have every scheduled check start failing at once.
    if (!chosen || RANK_UNSUPPORTED[provider]) {
      // Fall back to any configured SERP key
      for (const p of ["serper", "dataforseo", "scrapingrobot"]) {
        const alt = configuredIn(s, p);
        if (alt) return alt;
      }
      return null;
    }
    return chosen;
  } catch {
    return null;
  }
}

function hostOf(domain: string): string {
  let d = (domain || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "");
  d = d.split("/")[0];
  return d.replace(/^www\./, "");
}

// Does a SERP result belong to the tracked site (incl. subdomains)?
function matchesSite(resultDomain: string, siteHost: string): boolean {
  const r = (resultDomain || "").toLowerCase().replace(/^www\./, "");
  return r === siteHost || r.endsWith("." + siteHost);
}

export interface CheckResult {
  position: number | null;
  url: string | null;
  depth: number;
  error?: string;
}

// One SERP scan pass at the given depth.
async function scan(
  creds: SerpCreds, keyword: string, gl: string, hl: string, depth: number, siteHost: string,
): Promise<CheckResult> {
  const serp = await runSerp(creds.provider, creds.apiKey, keyword, { gl, hl, num: depth, baseUrl: creds.baseUrl });
  if (serp.error) return { position: null, url: null, depth, error: serp.error };
  for (const r of serp.results) {
    if (matchesSite(r.domain, siteHost)) return { position: r.position, url: r.url, depth };
  }
  return { position: null, url: null, depth };
}

// Check one tracked keyword (smart depth), persist RankCheck + denormalized state.
export async function checkTrackedKeyword(
  kw: { id: string; keyword: string; country: string; lang: string; lastPosition: number | null; bestPosition: number | null; siteUrl: string },
  creds: SerpCreds,
): Promise<CheckResult> {
  const siteHost = hostOf(kw.siteUrl);
  const unsupported = RANK_UNSUPPORTED[creds.provider];
  if (unsupported) return { position: null, url: null, depth: 0, error: unsupported };
  const max = MAX_DEPTH[creds.provider] ?? 50;

  // Smart strategy: known position → scan a window around it; unknown → full depth.
  let depth = kw.lastPosition
    ? Math.min(max, Math.ceil((kw.lastPosition + SMART_BUFFER) / 10) * 10)
    : max;

  let res = await scan(creds, kw.keyword, kw.country, kw.lang, depth, siteHost);

  // Not found in the smart window → escalate once to max depth.
  if (!res.error && res.position === null && depth < max) {
    res = await scan(creds, kw.keyword, kw.country, kw.lang, max, siteHost);
  }

  const now = new Date();
  await prisma.rankCheck.create({
    data: {
      keywordId: kw.id,
      checkedAt: now,
      position: res.error ? null : res.position,
      url: res.url,
      depth: res.depth,
      error: res.error ?? null,
    },
  });

  if (res.error) {
    // Keep last known state; bump lastCheckedAt so the scheduler doesn't hot-loop.
    await prisma.trackedKeyword.update({
      where: { id: kw.id },
      data: { lastCheckedAt: now },
    });
  } else {
    const best =
      res.position !== null && (kw.bestPosition === null || res.position < kw.bestPosition)
        ? res.position
        : kw.bestPosition;
    await prisma.trackedKeyword.update({
      where: { id: kw.id },
      data: {
        lastCheckedAt: now,
        prevPosition: kw.lastPosition,
        lastPosition: res.position,
        lastUrl: res.url,
        bestPosition: best,
      },
    });
  }
  return res;
}

// Check up to `limit` keywords of a site that are stale (or all when force=true).
// Sequential with a small delay — kind to provider rate limits.
export async function checkSiteKeywords(
  siteId: string, siteUrl: string, creds: SerpCreds,
  opts: { force?: boolean; limit?: number; onlyIds?: string[] } = {},
): Promise<{ checked: number; remaining: number; errors: number }> {
  const limit = opts.limit ?? 20;
  const staleBefore = new Date(Date.now() - RANK_STALE_MS);
  const where: any = { siteId };
  if (opts.onlyIds?.length) where.id = { in: opts.onlyIds };
  else if (!opts.force) where.OR = [{ lastCheckedAt: null }, { lastCheckedAt: { lt: staleBefore } }];

  const all = await prisma.trackedKeyword.findMany({
    where,
    orderBy: [{ lastCheckedAt: "asc" }],
  });
  const batch = all.slice(0, limit);
  let errors = 0;
  for (const kw of batch) {
    const res = await checkTrackedKeyword(
      { id: kw.id, keyword: kw.keyword, country: kw.country, lang: kw.lang, lastPosition: kw.lastPosition, bestPosition: kw.bestPosition, siteUrl },
      creds,
    );
    if (res.error) errors++;
    await new Promise(r => setTimeout(r, 800));
  }
  return { checked: batch.length, remaining: Math.max(0, all.length - batch.length), errors };
}
