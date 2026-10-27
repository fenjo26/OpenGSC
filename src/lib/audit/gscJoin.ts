/**
 * Site Audit × Search Console — the crawl checked against what Google itself reports.
 *
 * The crawler sees the site as a visitor; Search Console says what Google did with it. Three
 * disagreements between the two are worth a finding, and all three come from data the instance
 * already stores — no URL Inspection quota is spent by an audit:
 *
 *   - gsc_not_indexed      — an indexable page (200, no noindex, self-canonical) that the latest
 *                            URL Inspection reports as not in the index;
 *   - gsc_canonical_other  — Google selected a different canonical than the one the page declares
 *                            (or than the page itself, when it declares none);
 *   - GSC orphans          — URLs earning impressions that the crawl never reached: no internal
 *                            path leads there, so the only way in is Google's memory.
 *
 * The first two are per-page findings; orphans are not crawled pages, so they live in the audit
 * summary. Inspection results can be weeks old, which is why both page rules are informative
 * (affectsScore: false) and their evidence always carries the inspection date.
 *
 * Pure and Prisma-free: crawler.ts loads the rows, this module decides.
 */
import { statusIndexed } from "@/lib/indexing/queue";

/** Inspections older than this are not evidence of anything the site does today. */
export const GSC_INSPECTION_MAX_AGE_DAYS = 60;
/** Same floor as the main-query pick and the noindex triage. */
export const GSC_ORPHAN_MIN_IMPRESSIONS = 20;
export const GSC_ORPHAN_SAMPLE_SIZE = 20;

/**
 * Comparison key for "the same page": host without www, path without a trailing slash, query kept,
 * fragment and protocol dropped. A Domain property reports http:// and https:// rows and jump-link
 * fragments; none of those is a different page for the purpose of "did the crawl reach it".
 */
export function gscPageKey(url: string): string {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${host}${path}${u.search}`;
  } catch {
    return "";
  }
}

export interface InspectionRow {
  url: string;
  /** coverageState ?? verdict, as both tables store it. */
  status: string | null;
  checkedAt: Date | string | null;
  /** Google-selected canonical; the sitemap table stores it only when it differs from the URL. */
  googleCanonical?: string | null;
}

export interface GscIndexState {
  indexed: boolean | null;
  status: string;
  /** YYYY-MM-DD of the inspection. */
  checkedOn: string;
  googleCanonical: string | null;
}

/**
 * Freshest usable inspection per page key, from both stores (the Indexing tab's PageInspection
 * and the sitemap inventory's google* columns). Rows without a date or older than the limit are
 * dropped; an unknown status survives with indexed = null, and null never fires a rule.
 */
export function latestInspections(rows: readonly InspectionRow[], now = Date.now()): Map<string, GscIndexState> {
  const cutoff = now - GSC_INSPECTION_MAX_AGE_DAYS * 86_400_000;
  const best = new Map<string, { at: number; state: GscIndexState }>();
  for (const row of rows) {
    if (!row.status || !row.checkedAt) continue;
    const at = new Date(row.checkedAt).getTime();
    if (!Number.isFinite(at) || at < cutoff) continue;
    const key = gscPageKey(row.url);
    if (!key) continue;
    const prev = best.get(key);
    // Equal timestamps: keep the row that knows a canonical (only the sitemap store has one).
    if (prev && (prev.at > at || (prev.at === at && (prev.state.googleCanonical || !row.googleCanonical)))) continue;
    best.set(key, {
      at,
      state: {
        indexed: statusIndexed(row.status),
        status: row.status,
        checkedOn: new Date(at).toISOString().slice(0, 10),
        googleCanonical: row.googleCanonical?.trim() || null,
      },
    });
  }
  return new Map([...best].map(([key, value]) => [key, value.state]));
}

/**
 * Google's canonical, when it is NOT the one the page asks for. `declared` is the page's absolute
 * canonical, or null when it declares none (then the page itself is the expected canonical).
 */
export function canonicalOverride(pageUrl: string, declared: string | null, state: GscIndexState | null | undefined): string | null {
  const chosen = state?.googleCanonical;
  if (!chosen) return null;
  const expected = gscPageKey(declared || pageUrl);
  const got = gscPageKey(chosen);
  return got && expected && got !== expected ? chosen : null;
}

export interface GscOrphan {
  url: string;
  impressions: number;
  clicks: number;
}

export interface GscOrphanSummary {
  /** URLs with ≥ GSC_ORPHAN_MIN_IMPRESSIONS over 28 days that the crawl did not reach. */
  count: number;
  /** The crawl stopped at its page limit — some of these may simply lie beyond it. */
  partial: boolean;
  /** Highest impressions first, capped at GSC_ORPHAN_SAMPLE_SIZE. */
  sample: GscOrphan[];
}

/**
 * GSC pages the crawl never reached. Only same-host pages count (a Domain property also reports
 * subdomains the crawl never meant to visit); `skip` filters what the crawl was told to ignore and
 * non-page assets, so an ignored /wp-admin/ or a PDF is not called an orphan.
 */
export function findGscOrphans(
  gscPages: ReadonlyMap<string, { impressions: number; clicks: number }>,
  crawledUrls: Iterable<string>,
  rootUrl: string,
  opts: { partial: boolean; skip?: (url: string) => boolean },
): GscOrphanSummary {
  const crawled = new Set<string>();
  for (const url of crawledUrls) {
    const key = gscPageKey(url);
    if (key) crawled.add(key);
  }
  let rootHost = "";
  try { rootHost = new URL(rootUrl).hostname.toLowerCase().replace(/^www\./, ""); } catch { /* empty root: nothing matches */ }
  const merged = new Map<string, GscOrphan>();
  for (const [url, totals] of gscPages) {
    const key = gscPageKey(url);
    if (!key || crawled.has(key)) continue;
    let host = "";
    try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { continue; }
    if (host !== rootHost) continue;
    if (opts.skip?.(url)) continue;
    // http/https and fragment variants of one page fold into one orphan.
    const prev = merged.get(key);
    if (prev) {
      prev.impressions += totals.impressions;
      prev.clicks += totals.clicks;
    } else {
      merged.set(key, { url: url.replace(/#.*$/, ""), impressions: totals.impressions, clicks: totals.clicks });
    }
  }
  const orphans = [...merged.values()]
    .filter(o => o.impressions >= GSC_ORPHAN_MIN_IMPRESSIONS)
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.url.localeCompare(b.url));
  return { count: orphans.length, partial: opts.partial, sample: orphans.slice(0, GSC_ORPHAN_SAMPLE_SIZE) };
}
