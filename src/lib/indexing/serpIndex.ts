// Index estimation via a `site:` SERP query (N6) — for URLs Google's own URL Inspection API
// cannot answer: drops, other people's sites, PBN domains without a verified Search Console
// property. Inspection is a verdict from Google about a property you own; this is an estimate
// read off the public SERP, and the two are never conflated — the result lands in its own
// SitemapUrl.serpIndex* columns and the UI labels the column as an estimate.
//
// The one rule that shapes everything (docs/tasks/wave-nov/CONTRACT.md §0.5 and the SERP
// Monitor contract): a provider failure — captcha, auth, network — is `error`, NEVER
// `not_indexed`. A mis-read captcha would tell the operator their page fell out of the index.

import { prisma } from "@/lib/prisma";
import { getUserSerpCreds } from "@/lib/rank";
import { runSerp } from "@/lib/seo/serp";
import { recordUsage, releaseUnusedUnits, withinCap } from "@/lib/seo/metricsStore";
import { estimateSerpQueryCost, usdToUnits } from "@/lib/plagiarism/price";

/** One route call, one ceiling: 200 URLs max, each a paid query on the user's SERP key. */
export const SERP_INDEX_MAX_URLS = 200;

const QUERY_DELAY_MS = 800;

export type SerpIndexStatus = "indexed" | "not_indexed" | "error";

export interface SerpIndexOutcome {
  url: string;
  status: SerpIndexStatus;
  /** The SERP URL that matched (set on `indexed`). */
  matchedUrl: string | null;
  /** Provider error text (set on `error`). */
  detail: string | null;
  provider: string;
  /** True when the verdict was written to this user's SitemapUrl row. */
  persisted: boolean;
}

export interface SerpIndexEstimate {
  provider: string;
  queries: number;
  costUsd: number | null;
  free: boolean;
  unknownPrice: boolean;
}

/** Tracking parameters that identify a session, not content — the same family utm belongs to. */
const TRACKING_PARAMS = new Set(["gclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "yclid", "_ga"]);

function parseMaybeUrl(url: string): URL | null {
  const s = url.trim();
  if (!s) return null;
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
}

/**
 * The comparison form: scheme-less, lowercase host, no `www.`, no trailing slash, tracking
 * parameters dropped, hash dropped. Everything else (real query parameters) stays, because
 * two URLs differing by `?page=2` are different pages.
 */
export function normalizeUrlForCompare(url: string): string {
  const u = parseMaybeUrl(url);
  if (!u) return "";
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  let search = "";
  if (u.search) {
    const params = [...u.searchParams].filter(([k]) => !k.toLowerCase().startsWith("utm_") && !TRACKING_PARAMS.has(k.toLowerCase()));
    if (params.length) search = `?${params.map(([k, v]) => `${k}=${v}`).join("&")}`;
  }
  if (path === "" && search === "") return host;
  return `${host}${path}${search}`;
}

/**
 * The `site:` query for one URL: `site:host` for the homepage, `site:host/path` for a page.
 * Scheme, query and hash never belong in a site: query — they are not part of what Google
 * matches on, and `site:host/?utm=x` simply returns nothing.
 */
export function siteQueryFor(url: string): string | null {
  const u = parseMaybeUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, "");
  if (!host) return null;
  return path ? `site:${host}/${path.replace(/^\//, "")}` : `site:${host}`;
}

/**
 * The verdict for one URL from one SERP answer.
 *
 *   error        the provider failed — captcha, auth, network. Never "not indexed".
 *   indexed      some result carries the same normalized URL.
 *   not_indexed  the provider answered and our URL is not among the results — including a
 *                non-empty SERP (siblings under the same site: prefix) that still lacks the
 *                exact page: those siblings say the host is indexed, not this URL.
 */
export function classifySerpIndex(
  target: string,
  results: { url: string }[],
  error: string | null | undefined,
): { status: SerpIndexStatus; matchedUrl: string | null } {
  if (error) return { status: "error", matchedUrl: null };
  const wanted = normalizeUrlForCompare(target);
  if (!wanted) return { status: "error", matchedUrl: null }; // unparseable input is our error, not Google's
  for (const r of results) {
    if (normalizeUrlForCompare(r.url) === wanted) return { status: "indexed", matchedUrl: r.url };
  }
  return { status: "not_indexed", matchedUrl: null };
}

function hostOf(url: string): string {
  const u = parseMaybeUrl(url);
  return u ? u.hostname.toLowerCase().replace(/^www\./, "") : "";
}

/** Free pricing half — the route shows this BEFORE the run and refuses to spend without confirm. */
export async function estimateSerpIndexCheck(userId: string, urls: string[]): Promise<SerpIndexEstimate & { error?: string }> {
  const queries = Math.min(SERP_INDEX_MAX_URLS, urls.length);
  const creds = await getUserSerpCreds(userId);
  if (!creds) return { provider: "", queries, costUsd: null, free: false, unknownPrice: false, error: "no_serp_key" };
  const price = estimateSerpQueryCost(creds.provider, queries);
  return { provider: creds.provider, queries, costUsd: price.costUsd, free: price.free, unknownPrice: price.unknownPrice };
}

/**
 * Write verdicts back into SitemapUrl.serpIndex* for the URLs that belong to one of the user's
 * sites. A URL from someone else's domain (the whole point of this check) has no row to update,
 * and is returned as-is.
 */
async function persistSerpIndexResults(userId: string, outcomes: SerpIndexOutcome[], provider: string): Promise<void> {
  const sites = await prisma.site.findMany({ where: { userId }, select: { id: true, url: true } });
  const siteByHost = new Map<string, string>();
  for (const s of sites) {
    const h = hostOf(String(s.url));
    if (h) siteByHost.set(h, s.id);
  }
  const siteIdFor = (url: string): string | null => {
    const h = hostOf(url);
    if (!h) return null;
    if (siteByHost.has(h)) return siteByHost.get(h)!;
    for (const [host, id] of siteByHost) if (h.endsWith("." + host)) return id;
    return null;
  };

  // Match stored rows by the URL string and its common variants (www, trailing slash): the
  // unique key is the raw string, and a checked URL pasted without `www.` must still find the
  // row the sitemap sync wrote with it. Batched to respect the 400-parameter ceiling.
  for (let i = 0; i < outcomes.length; i += 100) {
    const batch = outcomes.slice(i, i + 100);
    const variants = new Set<string>();
    for (const o of batch) {
      const u = parseMaybeUrl(o.url);
      if (!u) continue;
      const bare = u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "");
      variants.add(`https://${bare}`);
      variants.add(`https://www.${bare}`);
      variants.add(`http://${bare}`);
    }
    const variantList = [...variants];
    const byNorm = new Map<string, { id: string; siteId: string; url: string }>(); // normalized → stored row
    for (let j = 0; j < variantList.length; j += 300) {
      const slice = variantList.slice(j, j + 300);
      const rows = await prisma.sitemapUrl.findMany({ where: { url: { in: slice } }, select: { id: true, url: true, siteId: true } });
      for (const r of rows) byNorm.set(normalizeUrlForCompare(r.url), r);
    }
    const checkedAt = new Date();
    for (const o of batch) {
      const siteId = siteIdFor(o.url);
      const stored = byNorm.get(normalizeUrlForCompare(o.url));
      if (!siteId || !stored || stored.siteId !== siteId) { o.persisted = false; continue; }
      try {
        // updateMany, not update-by-id: the row was matched by its own unique (siteId, url) and
        // a vanished row reports count 0 instead of throwing.
        const res = await prisma.sitemapUrl.updateMany({
          where: { id: stored.id, siteId },
          data: { serpIndexStatus: o.status, serpIndexChecked: checkedAt, serpIndexProvider: provider },
        });
        o.persisted = res.count > 0;
      } catch {
        o.persisted = false; // pre-migration or raced: the verdict is still returned
      }
    }
  }
}

export interface SerpIndexRunResult {
  ok: boolean;
  error?: string;
  /** Human-readable provider failure (set when error = provider_failed). */
  detail?: string;
  provider: string;
  results: SerpIndexOutcome[];
  queries: number;       // queries actually answered by the provider
  attempted: number;     // queries sent (answered or not)
  errors: number;
  costUsd: number | null;
}

/**
 * Run the checks: sequential site: queries over the user's SERP provider, verdicts classified
 * per URL, results persisted where they belong. Units are reserved before the first query and
 * the unspent part (failed queries) is released — the same ledger discipline as the plagiarism
 * run, because it is the same money.
 */
export async function serpIndexCheckUrls(
  userId: string,
  urlsRaw: string[],
  opts: { cap?: unknown } = {},
): Promise<SerpIndexRunResult> {
  // Dedupe by comparison form, keep the caller's first spelling, cap at the route ceiling.
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const u of urlsRaw) {
    const norm = normalizeUrlForCompare(String(u));
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    urls.push(String(u).trim());
  }
  const targets = urls.slice(0, SERP_INDEX_MAX_URLS);

  const creds = await getUserSerpCreds(userId);
  if (!creds) return { ok: false, error: "no_serp_key", provider: "", results: [], queries: 0, attempted: 0, errors: 0, costUsd: null };

  const price = estimateSerpQueryCost(creds.provider, targets.length);
  const perQueryUsd = price.costUsd != null && targets.length ? price.costUsd / targets.length : null;
  const cap = Number(opts.cap ?? 0) || 0;
  let reservedUnits = 0;
  if (price.costUsd != null && price.costUsd > 0) {
    reservedUnits = usdToUnits(price.costUsd);
    if (!(await withinCap(userId, creds.provider, reservedUnits, cap))) {
      return { ok: false, error: "cap_exceeded", provider: creds.provider, results: [], queries: 0, attempted: 0, errors: targets.length, costUsd: price.costUsd };
    }
    await recordUsage(userId, creds.provider, reservedUnits);
  }

  const optsSerp: Parameters<typeof runSerp>[3] = {
    num: 10,
    ...(creds.baseUrl ? { baseUrl: creds.baseUrl } : {}),
    ...(creds.configPreset ? { configPreset: creds.configPreset } : {}),
  };

  const results: SerpIndexOutcome[] = [];
  let answered = 0;
  let errors = 0;
  let lastError = "";

  for (let i = 0; i < targets.length; i++) {
    const url = targets[i];
    const query = siteQueryFor(url);
    if (!query) {
      results.push({ url, status: "error", matchedUrl: null, detail: "invalid_url", provider: creds.provider, persisted: false });
      errors++;
      continue;
    }
    const serp = await runSerp(creds.provider, creds.apiKey, query, optsSerp);
    if (serp.error) {
      // Captcha, auth, network — an error, never a verdict (see the file header).
      results.push({
        url, status: "error", matchedUrl: null,
        detail: serp.errorDetail ? `${serp.error} (${serp.errorDetail.slice(0, 120)})` : serp.error,
        provider: creds.provider, persisted: false,
      });
      errors++;
      lastError = results[results.length - 1].detail ?? serp.error;
    } else {
      answered++;
      const { status, matchedUrl } = classifySerpIndex(url, serp.results, null);
      results.push({ url, status, matchedUrl, detail: null, provider: creds.provider, persisted: false });
    }
    if (i < targets.length - 1) await new Promise((r) => setTimeout(r, QUERY_DELAY_MS));
  }

  const spentUsd = perQueryUsd != null ? answered * perQueryUsd : null;
  if (reservedUnits > 0 && spentUsd != null) {
    await releaseUnusedUnits(userId, creds.provider, reservedUnits, usdToUnits(spentUsd));
  }

  // Everything failed: the provider is down, and an all-error table must not masquerade as a
  // result. Say it as an error and keep the per-URL rows for whoever wants the detail.
  if (answered === 0 && targets.length > 0) {
    return {
      ok: false, error: "provider_failed", detail: lastError || "provider returned no answer",
      provider: creds.provider, results, queries: 0, attempted: targets.length, errors, costUsd: spentUsd,
    };
  }

  try {
    await persistSerpIndexResults(userId, results, creds.provider);
  } catch { /* pre-migration or foreign URLs: the verdicts are still returned */ }

  return { ok: true, provider: creds.provider, results, queries: answered, attempted: targets.length, errors, costUsd: spentUsd };
}

export interface SerpIndexRow {
  url: string;
  googleChecked: string | null;
  googleStatus: string | null;
  serpIndexStatus: SerpIndexStatus | null;
  serpIndexChecked: string | null;
  serpIndexProvider: string | null;
}

/**
 * The panel's table: the site's URLs with whatever site: verdicts exist (newest first), plus
 * the URLs a "Check via site:" run would take — those Google's own quota cannot or will not
 * reach (never inspected: no GSC property, or not picked yet).
 */
export async function listSerpIndexRows(siteId: string): Promise<{ rows: SerpIndexRow[]; pendingUrls: string[] }> {
  const all = await prisma.sitemapUrl.findMany({
    where: { siteId, inventoryStatus: "active" },
    select: {
      url: true, googleChecked: true, googleStatus: true,
      serpIndexStatus: true, serpIndexChecked: true, serpIndexProvider: true,
      firstSeenAt: true,
    },
    orderBy: { firstSeenAt: "desc" },
    take: 800,
  });
  const map = (r: (typeof all)[number]): SerpIndexRow => ({
    url: r.url,
    googleChecked: r.googleChecked ? r.googleChecked.toISOString() : null,
    googleStatus: r.googleStatus,
    serpIndexStatus: (r.serpIndexStatus as SerpIndexStatus | null) ?? null,
    serpIndexChecked: r.serpIndexChecked ? r.serpIndexChecked.toISOString() : null,
    serpIndexProvider: r.serpIndexProvider,
  });
  const checked = all
    .filter((r) => r.serpIndexStatus != null)
    .sort((a, b) => (b.serpIndexChecked?.getTime() ?? 0) - (a.serpIndexChecked?.getTime() ?? 0))
    .slice(0, 50)
    .map(map);
  // Unchecked by Google and not site:-checked either — the honest "unknown" set the button targets.
  const pending = all
    .filter((r) => r.googleChecked == null && r.serpIndexStatus == null)
    .slice(0, 50)
    .map((r) => r.url);
  return { rows: checked, pendingUrls: pending };
}
