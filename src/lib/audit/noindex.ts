/**
 * Noindex triage for the Site Audit — "closed on purpose" versus "closed by mistake".
 *
 * Until this module the audit flagged every noindex page as critical and scored it 0. On a real
 * site most noindex pages are deliberate — cart, login, thank-you pages, tag archives, internal
 * search — so the health score of a correctly configured site collapsed, and the one noindex that
 * really mattered (a homepage left closed after a staging deploy, WordPress "Discourage search
 * engines" still ticked) drowned among the deliberate ones.
 *
 * A noindex page is now SUSPICIOUS when something else about the site says it is meant to be
 * found. Each reason is a fact the instance already holds, not a guess about the content:
 *   - homepage       — the crawl root carries noindex;
 *   - sitemap        — the site's own sitemap lists the URL (a sitemap is the list of pages the
 *                      owner wants indexed; noindex + sitemap is a contradiction either way);
 *   - gsc_traffic    — Search Console shows the page earning impressions over the last 28 days;
 *   - was_indexable  — the previous completed audit saw the same URL as an indexable page.
 * Anything else is INTENTIONAL: listed, never scored, and not audited for content and metadata —
 * a title that is too short on a page nobody is supposed to find is not a finding.
 *
 * Pure and Prisma-free so the tests run without a database; crawler.ts gathers the inputs.
 */

export type NoindexReason = "homepage" | "sitemap" | "gsc_traffic" | "was_indexable";

/** Display order — strongest evidence of a mistake first. */
export const NOINDEX_REASONS: readonly NoindexReason[] = ["homepage", "was_indexable", "gsc_traffic", "sitemap"];

/** Same floor as the audit's main-query pick: below it a page's GSC numbers are noise. */
export const NOINDEX_GSC_MIN_IMPRESSIONS = 20;

/**
 * Share of HTML pages that makes the noindex "site-wide" even when the homepage is open — e.g. a
 * template-level robots tag on every article. Deliberately high: a WordPress blog with many tag
 * archives can legitimately have half its crawled pages closed.
 */
export const NOINDEX_SITEWIDE_SHARE = 0.8;
export const NOINDEX_SITEWIDE_MIN_PAGES = 5;

/** How many suspicious pages the summary keeps for the card and the alert. */
export const NOINDEX_SAMPLE_SIZE = 20;

/**
 * True when a robots value (meta robots/googlebot joined with X-Robots-Tag) closes the page.
 * `none` is shorthand for "noindex, nofollow" and closes it too.
 */
export function hasNoindex(robots: string): boolean {
  return /(^|[\s,;:])(noindex|none)(?=$|[\s,;])/i.test(robots);
}

export interface NoindexSignals {
  isRoot: boolean;
  inSitemap: boolean;
  /** Web-search impressions / clicks over the last 28 days; 0 when there is no GSC data. */
  gscImpressions: number;
  gscClicks: number;
  /** Date (YYYY-MM-DD) of the previous audit that saw this URL indexable; null = it did not. */
  wasIndexableOn: string | null;
}

export function noindexReasons(s: NoindexSignals): NoindexReason[] {
  const out: NoindexReason[] = [];
  if (s.isRoot) out.push("homepage");
  if (s.wasIndexableOn) out.push("was_indexable");
  if (s.gscImpressions >= NOINDEX_GSC_MIN_IMPRESSIONS) out.push("gsc_traffic");
  if (s.inSitemap) out.push("sitemap");
  return out;
}

/** Evidence line stored on the finding — plain English like every other evidence string. */
export function noindexEvidence(reasons: readonly NoindexReason[], s: NoindexSignals, robots: string): string {
  const parts = reasons.map(reason => {
    switch (reason) {
      case "homepage": return "homepage";
      case "was_indexable": return `indexable in the audit of ${s.wasIndexableOn}`;
      case "gsc_traffic": return `${s.gscImpressions} impressions, ${s.gscClicks} clicks in GSC over 28 d`;
      case "sitemap": return "listed in the sitemap";
    }
  });
  return [robots || "noindex", ...parts].join(" · ");
}

export interface NoindexPageInput {
  url: string;
  hasHtml: boolean;
  httpStatus: number;
  noindex: boolean;
  reasons: readonly NoindexReason[];
}

export interface NoindexSummary {
  /** HTML pages answering 200 — the denominator of the site-wide share. */
  htmlPages: number;
  /** Of those, pages carrying noindex. */
  pages: number;
  /** Noindex pages with at least one reason. */
  suspicious: number;
  /** Noindex pages with none — closed on purpose, kept out of the score. */
  intentional: number;
  homepage: boolean;
  /** The homepage is closed, or nearly every page is. */
  sitewide: boolean;
  /** The site's audit settings say noindex never lowers the score (findings still listed). */
  neutral: boolean;
  /** Suspicious pages, strongest evidence first, capped at NOINDEX_SAMPLE_SIZE. */
  sample: { url: string; reasons: NoindexReason[] }[];
}

const reasonRank = (reasons: readonly NoindexReason[]) =>
  Math.min(...reasons.map(r => NOINDEX_REASONS.indexOf(r)), NOINDEX_REASONS.length);

export function summarizeNoindex(rows: readonly NoindexPageInput[], neutral = false): NoindexSummary {
  const html = rows.filter(row => row.hasHtml && row.httpStatus === 200);
  const closed = html.filter(row => row.noindex);
  const suspicious = closed.filter(row => row.reasons.length > 0);
  const homepage = closed.some(row => row.reasons.includes("homepage"));
  const share = html.length ? closed.length / html.length : 0;
  const sample = [...suspicious]
    .sort((a, b) => reasonRank(a.reasons) - reasonRank(b.reasons) || b.reasons.length - a.reasons.length || a.url.localeCompare(b.url))
    .slice(0, NOINDEX_SAMPLE_SIZE)
    .map(row => ({ url: row.url, reasons: [...row.reasons] }));
  return {
    htmlPages: html.length,
    pages: closed.length,
    suspicious: suspicious.length,
    intentional: closed.length - suspicious.length,
    homepage,
    sitewide: homepage || (html.length >= NOINDEX_SITEWIDE_MIN_PAGES && share >= NOINDEX_SITEWIDE_SHARE),
    neutral,
    sample,
  };
}

/**
 * Whether a stored summary deserves a push alert. Alerts are for events, the Audit tab is for
 * state: a homepage that closed, a page that WAS indexable last time, or a whole site going dark.
 * A page that merely sits in the sitemap with noindex is a standing misconfiguration — it shows in
 * the tab every run, but repeating it in Telegram every week would teach the owner to mute alerts.
 * A site whose owner switched noindex to neutral gets no alert at all: they said they know.
 */
export function noindexAlertWorthy(summary: Partial<NoindexSummary> | null | undefined): boolean {
  if (!summary || summary.neutral) return false;
  if (summary.sitewide) return true;
  return (summary.sample ?? []).some(page => page.reasons.includes("homepage") || page.reasons.includes("was_indexable"));
}

/** Site-level switch stored in Site.auditSettings — read leniently, like the schedule fields. */
export function noindexNeutralSetting(auditSettings: string | null | undefined): boolean {
  if (!auditSettings) return false;
  try { return JSON.parse(auditSettings)?.noindexNeutral === true; } catch { return false; }
}
