/**
 * Site Audit × the site's own sitemap.
 *
 * A sitemap is the owner's list of pages that should be crawled and indexed. Every entry should be
 * a final, live, self-canonical page; anything else wastes crawl budget and sends search engines
 * mixed signals. Per-page findings (rules.ts) cover the entries the crawl fetched:
 *   - sitemap_redirect       — the listed URL answers 3xx (list the target instead);
 *   - sitemap_error          — the listed URL answers 4xx/5xx or not at all;
 *   - sitemap_non_canonical  — the listed URL names another page as its canonical;
 *   - noindex on a listed URL is the noindex triage's `sitemap` reason (noindex.ts).
 * Entries the crawl never fetched cannot be judged from the crawl; this module counts them so the
 * report can say how much of the sitemap the verdict covers, and the "audit from sitemap" run
 * (seedFromSitemap) can check the rest.
 *
 * Membership comes from the sitemap inventory the instance already syncs; no sitemap is fetched
 * here. Pure and Prisma-free.
 */
import { gscPageKey } from "./gscJoin";

export const SITEMAP_SAMPLE_SIZE = 10;

export interface SitemapCoverage {
  /** Same-host URLs in the active sitemap inventory. */
  listed: number;
  /** Of those, how many the crawl fetched (and therefore judged). */
  checked: number;
  /** Listed but never fetched — not judged by this audit. */
  notChecked: number;
  /** The crawl was seeded from the sitemap (every listed URL was queued). */
  seeded: boolean;
  /** The crawl stopped at its page limit. */
  partial: boolean;
  sample: string[];
}

export function sitemapCoverage(
  inventory: Iterable<string>,
  crawledUrls: Iterable<string>,
  rootUrl: string,
  opts: { seeded: boolean; partial: boolean },
): SitemapCoverage {
  const crawled = new Set<string>();
  for (const url of crawledUrls) {
    const key = gscPageKey(url);
    if (key) crawled.add(key);
  }
  let rootHost = "";
  try { rootHost = new URL(rootUrl).hostname.toLowerCase().replace(/^www\./, ""); } catch { /* nothing matches */ }
  const listed = new Map<string, string>();
  for (const url of inventory) {
    const key = gscPageKey(url);
    if (!key || listed.has(key)) continue;
    let host = "";
    try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { continue; }
    if (host === rootHost) listed.set(key, url);
  }
  const missing = [...listed].filter(([key]) => !crawled.has(key)).map(([, url]) => url).sort();
  return {
    listed: listed.size,
    checked: listed.size - missing.length,
    notChecked: missing.length,
    seeded: opts.seeded,
    partial: opts.partial,
    sample: missing.slice(0, SITEMAP_SAMPLE_SIZE),
  };
}
