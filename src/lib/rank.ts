// Rank Tracker core: server-side keyword position checks via the user's SERP provider.
//
// Keys: the browser-side SEO Tools keys are mirrored to User.seoSettings (SeoKeysSync),
// so the server (API routes + scheduler) reads them from there — no extra setup needed.
//
// Scrape strategy ("smart", inspired by SerpBear): if we know the keyword's last
// position we only scan a window around it (lastPosition + buffer). If the keyword
// isn't found in that window we escalate once to the provider's max depth.
//
// A-Parser is the exception: it runs SE::Google::Position, which stops at the page where the
// site is found, so it always asks for the full depth in one call — the parser does the
// windowing itself, one results page per ten positions.
//
// Every check goes through `checkWithFallback` (lib/rankFallback.ts): a transient error is
// retried once on the same provider, then handed to the optional fallback provider
// (Settings → SEO Tools → Rank Tracker fallback).

import { prisma } from "@/lib/prisma";
import { runSerp } from "@/lib/seo/serp";
import { resolveBaseUrl, setAparserConcurrency } from "@/lib/seo/aparser";
import { aparserRankPosition } from "@/lib/seo/aparserPositionRun";
import { checkWithFallback, type RankAttempt } from "@/lib/rankFallback";
import { resolveAparserPassword } from "@/lib/seo/aparserServerCreds";
import { rawQuery } from "@/lib/db/raw";

export const RANK_STALE_MS = 20 * 60 * 60 * 1000; // ~daily, resilient to restarts

const MAX_DEPTH: Record<string, number> = { serper: 50, dataforseo: 100, scrapingrobot: 50, aparser: 100 };
const SMART_BUFFER = 20;

/** Providers that can carry the tracker, in the order the no-choice fallback tries them. */
export const RANK_PROVIDERS = ["serper", "dataforseo", "scrapingrobot", "aparser"] as const;

/** Parallel checks per batch for A-Parser (the transport's own semaphore still applies). */
const APARSER_RANK_WORKERS = 3;

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
    "Pick Serper, DataForSEO, ScrapingRobot or A-Parser for Rank Tracker in Settings → SEO Tools (the Rank Tracker provider is set separately from the one used elsewhere).",
};

export interface SerpCreds {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  /** A-Parser thread config name (Settings → A-Parser). */
  configPreset?: string;
  /** Second provider for checks the first one could not answer. Never nested. */
  fallback?: SerpCreds;
}

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

async function configuredIn(s: any, provider: string): Promise<SerpCreds | null> {
  // A-Parser is deliberately deployable through the env pair alone (OPENGSC_APARSER_BASE_URL /
  // OPENGSC_APARSER_PASSWORD — see the comment on `resolveBaseUrl` for why env outranks a
  // settings URL). The password goes through the same probe SERP Monitor and the console use:
  // env and settings are both tried when they differ, so a rotated password re-tested in
  // Settings is picked up even while a stale env var is still in place.
  if (provider === "aparser") {
    const resolved = resolveBaseUrl(String(s.seoBaseUrl_aparser ?? ""));
    if ("problem" in resolved) return null;
    const picked = await resolveAparserPassword(resolved.url, String(s.seoKey_aparser ?? ""));
    if (!picked) return null;
    // Same limiter setting getAparserServerCreds applies — the tracker shares the instance.
    const rawConcurrency = s.seoAparserConcurrency;
    const concurrency = Number(rawConcurrency);
    if (rawConcurrency !== "" && rawConcurrency != null && Number.isFinite(concurrency)) setAparserConcurrency(concurrency);
    const configPreset = String(s.seoAparserConfig ?? "").trim();
    return { provider, apiKey: picked.password, baseUrl: resolved.url, ...(configPreset ? { configPreset } : {}) };
  }
  const apiKey = String(s[`seoKey_${provider}`] ?? "");
  if (!apiKey) return null;
  const baseUrl = String(s[`seoBaseUrl_${provider}`] ?? "");
  if (SELF_HOSTED_PROVIDERS.has(provider) && !baseUrl) return null;
  return { provider, apiKey, ...(baseUrl ? { baseUrl } : {}) };
}

/**
 * Attach the Rank Tracker fallback (`seoSerpProvider_rankFallback`) when it names another
 * configured, supported provider. An unconfigured fallback is simply absent: the primary's
 * errors are stored as they are, exactly as before this setting existed.
 */
async function withFallback(s: any, primary: SerpCreds | null): Promise<SerpCreds | null> {
  if (!primary) return null;
  const id = String(s.seoSerpProvider_rankFallback ?? "").trim();
  if (!id || id === primary.provider || RANK_UNSUPPORTED[id]) return primary;
  const fb = await configuredIn(s, id);
  return fb ? { ...primary, fallback: fb } : primary;
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
    const chosen = await withFallback(s, await configuredIn(s, provider));
    // An unsupported provider is treated exactly like a missing key: fall through to whatever
    // else is configured. Someone who set GoAnyAPI as their app-wide SERP source and never
    // touched the Rank Tracker override should keep tracking on the key they already have,
    // rather than have every scheduled check start failing at once.
    if (!chosen || RANK_UNSUPPORTED[provider]) {
      // Fall back to any configured SERP key. A-Parser last: free, but it needs the user's own
      // proxies warmed up and in front of it, so it should only carry the tracker when nothing
      // metered is configured.
      for (const p of RANK_PROVIDERS) {
        const alt = await configuredIn(s, p);
        if (alt) return withFallback(s, alt);
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
  /** Provider whose answer was stored (the fallback's id when it stepped in). */
  provider?: string;
}

// One SERP scan pass at the given depth.
async function scan(
  creds: SerpCreds, keyword: string, gl: string, hl: string, depth: number, siteHost: string,
): Promise<CheckResult> {
  const serp = await runSerp(creds.provider, creds.apiKey, keyword, {
    gl, hl, num: depth, baseUrl: creds.baseUrl, ...(creds.configPreset ? { configPreset: creds.configPreset } : {}),
  });
  if (serp.error) return { position: null, url: null, depth, error: serp.error };
  for (const r of serp.results) {
    if (matchesSite(r.domain, siteHost)) return { position: r.position, url: r.url, depth };
  }
  return { position: null, url: null, depth };
}

/**
 * One provider's answer for one keyword. Metered providers: the smart window, escalated once to
 * full depth. A-Parser: one SE::Google::Position call at full depth ("Stop when found" keeps it
 * short), its detail line stored as the error so the cause is visible in the tracker.
 */
async function providerScan(
  creds: SerpCreds,
  kw: { keyword: string; country: string; lang: string; lastPosition: number | null },
  siteHost: string,
): Promise<CheckResult> {
  const max = MAX_DEPTH[creds.provider] ?? 50;
  if (creds.provider === "aparser") {
    const r = await aparserRankPosition(
      { baseUrl: creds.baseUrl ?? "", password: creds.apiKey, ...(creds.configPreset ? { configPreset: creds.configPreset } : {}) },
      { keyword: kw.keyword, gl: kw.country, hl: kw.lang, siteHost, depth: max },
    );
    if (r.problem) {
      const why = r.detail ?? r.problem;
      return { position: null, url: null, depth: r.depth, error: /^aparser\b/i.test(why) ? why : `aparser: ${why}` };
    }
    return { position: r.position, url: r.url, depth: r.depth };
  }

  // Smart strategy: known position → scan a window around it; unknown → full depth.
  const depth = kw.lastPosition
    ? Math.min(max, Math.ceil((kw.lastPosition + SMART_BUFFER) / 10) * 10)
    : max;
  let res = await scan(creds, kw.keyword, kw.country, kw.lang, depth, siteHost);
  // Not found in the smart window → escalate once to max depth.
  if (!res.error && res.position === null && depth < max) {
    res = await scan(creds, kw.keyword, kw.country, kw.lang, max, siteHost);
  }
  return res;
}

// Check one tracked keyword (smart depth), persist RankCheck + denormalized state.
export async function checkTrackedKeyword(
  kw: { id: string; keyword: string; country: string; lang: string; lastPosition: number | null; bestPosition: number | null; siteUrl: string },
  creds: SerpCreds,
): Promise<CheckResult> {
  const siteHost = hostOf(kw.siteUrl);
  const unsupported = RANK_UNSUPPORTED[creds.provider];
  if (unsupported) return { position: null, url: null, depth: 0, error: unsupported };
  const run = (provider: string): Promise<RankAttempt> => {
    const c = provider === creds.provider ? creds : creds.fallback;
    if (!c) return Promise.resolve({ position: null, url: null, depth: 0, error: `no_serp_key (${provider})`, provider });
    return providerScan(c, kw, siteHost).then((r) => ({ ...r, provider }));
  };
  const outcome = await checkWithFallback(run, creds.provider, creds.fallback?.provider);
  if (outcome.primaryError) {
    console.warn(`[rank] "${kw.keyword}": ${creds.provider} failed (${outcome.primaryError.slice(0, 160)}); answered by ${outcome.provider}`);
  }
  const res: CheckResult = {
    position: outcome.position, url: outcome.url, depth: outcome.depth,
    ...(outcome.error ? { error: outcome.error } : {}), provider: outcome.provider,
  };

  const now = new Date();
  await prisma.rankCheck.create({
    data: {
      keywordId: kw.id,
      checkedAt: now,
      position: res.error ? null : res.position,
      url: res.url,
      depth: res.depth,
      error: res.error ? res.error.slice(0, 1000) : null,
      provider: res.provider ?? null,
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
  opts: { force?: boolean; limit?: number; onlyIds?: string[]; before?: Date } = {},
): Promise<{ checked: number; remaining: number; errors: number }> {
  const limit = opts.limit ?? 20;
  const staleBefore = new Date(Date.now() - RANK_STALE_MS);
  const where: any = { siteId };
  if (opts.onlyIds?.length) where.id = { in: opts.onlyIds };
  // `force` = regardless of staleness, but each keyword once: the client loops while
  // `remaining > 0`, and with no cut-off every call counted all keywords again — a "check all"
  // on 79 keywords ran 30 batches (600 paid checks). `before` is the moment the loop started.
  else if (opts.force && opts.before) where.OR = [{ lastCheckedAt: null }, { lastCheckedAt: { lt: opts.before } }];
  else if (!opts.force) where.OR = [{ lastCheckedAt: null }, { lastCheckedAt: { lt: staleBefore } }];

  const all = await prisma.trackedKeyword.findMany({
    where,
    orderBy: [{ lastCheckedAt: "asc" }],
  });
  const batch = all.slice(0, limit);
  let errors = 0;
  const one = async (kw: (typeof batch)[number]) => {
    const res = await checkTrackedKeyword(
      { id: kw.id, keyword: kw.keyword, country: kw.country, lang: kw.lang, lastPosition: kw.lastPosition, bestPosition: kw.bestPosition, siteUrl },
      creds,
    );
    if (res.error) errors++;
  };
  if (creds.provider === "aparser") {
    // Self-hosted: no rate limit to be kind to, and a Position call takes seconds to minutes.
    // A few workers keep a 50-keyword tick inside the hour; the transport caps real parallelism.
    let next = 0;
    const worker = async () => { while (next < batch.length) await one(batch[next++]); };
    await Promise.all(Array.from({ length: Math.min(APARSER_RANK_WORKERS, batch.length) }, worker));
  } else {
    for (const kw of batch) {
      await one(kw);
      await new Promise(r => setTimeout(r, 800));
    }
  }
  return { checked: batch.length, remaining: Math.max(0, all.length - batch.length), errors };
}
