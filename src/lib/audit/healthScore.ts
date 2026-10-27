import { AUDIT_RULE_BY_ID, AUDIT_SCORING_RULE_IDS } from "./rules";

/**
 * Site Audit health score, version 2 (issue #30).
 *
 * Version 1 was `100 × (1 − pagesWithAnyScoredIssue / pages)`: a page with one image missing alt
 * weighed exactly as much as a page answering 404, and a plain internal 301 was a "page with an
 * issue" of its own. A small site with a minor warning on every template therefore scored 0/100,
 * the same as a site that was down.
 *
 * Version 2 scores each page, then averages:
 *   - any critical finding                → the page scores 0 (it is broken, not imperfect);
 *   - otherwise each DISTINCT scored warning costs WARNING_PENALTY, floored at WARNING_FLOOR,
 *     so warnings alone can never make a page look as bad as a broken one;
 *   - info rules and `affectsScore: false` rules cost nothing (unchanged from v1).
 * A single-hop redirect to the same site is not a page — it is how the site reaches one — so it
 * leaves the average entirely. Chains, loops and redirects off the site still count.
 *
 * A page closed from indexing on purpose (noindex.ts) leaves the average too, unless it carries a
 * scored finding of its own (a 404, broken links): the owner hid it, so its perfect or imperfect
 * content says nothing about the site. Rows without the flag — every stored audit — are unaffected.
 *
 * Invariant (tested): for the same rows, v2 ≥ v1. Recomputing old audits therefore never pushes
 * one below an alert threshold it was above, and the alert's per-audit dedupe stays quiet.
 */
export const HEALTH_SCORE_VERSION = 2;
export const WARNING_PENALTY = 8;
export const WARNING_FLOOR = 40;

export interface HealthScoreRow {
  url: string;
  httpStatus: number;
  redirectTo?: string | null;
  issues: string[];
  /** Closed with noindex and nothing says it should be open — see noindex.ts. */
  intentionalNoindex?: boolean;
}

export interface HealthScoreOptions {
  /**
   * Rule ids that cost nothing on this run even though the registry scores them — the site-level
   * "noindex never lowers the score" switch passes noindex_suspicious here. The findings stay in
   * the report; only the number ignores them.
   */
  ignoreRuleIds?: ReadonlySet<string>;
}

export interface HealthScoreResult {
  healthScore: number;
  /** v1 formula on the same rows — kept in the summary so a changed number can be explained. */
  healthScoreV1: number;
  scoreVersion: typeof HEALTH_SCORE_VERSION;
  /** Rows that entered the average (crawled rows minus plain internal redirects). */
  scoredPages: number;
  /** Plain internal redirects left out of the average. */
  redirectsExcluded: number;
  pagesWithScoredIssues: number;
  /** Intentionally closed pages without a scored finding, left out of the average. */
  noindexExcluded: number;
}

const isScored = (id: string, ignore?: ReadonlySet<string>) => AUDIT_SCORING_RULE_IDS.has(id) && !ignore?.has(id);

export function pageHealthScore(issues: readonly string[], ignore?: ReadonlySet<string>): number {
  const scored = new Set(issues.filter(id => isScored(id, ignore)));
  let warnings = 0;
  for (const id of scored) {
    if (AUDIT_RULE_BY_ID.get(id)?.severity === "critical") return 0;
    warnings++;
  }
  if (!warnings) return 100;
  return Math.max(WARNING_FLOOR, 100 - WARNING_PENALTY * warnings);
}

const siteHost = (host: string) => host.toLowerCase().replace(/^www\./, "");

/**
 * A 3xx whose only scored finding is `redirect` (no chain, no loop, nothing else) and whose
 * target is the same site — http→https, www↔apex and trailing-slash hops all qualify.
 */
export function isPlainInternalRedirect(row: HealthScoreRow): boolean {
  if (row.httpStatus < 300 || row.httpStatus >= 400 || !row.redirectTo) return false;
  const scored = row.issues.filter(id => AUDIT_SCORING_RULE_IDS.has(id));
  if (scored.length !== 1 || scored[0] !== "redirect") return false;
  try {
    const from = new URL(row.url);
    const to = new URL(row.redirectTo, from);
    return siteHost(from.hostname) === siteHost(to.hostname);
  } catch {
    return false;
  }
}

export function computeHealthScore(rows: readonly HealthScoreRow[], opts: HealthScoreOptions = {}): HealthScoreResult {
  const ignore = opts.ignoreRuleIds;
  const hasScored = (row: HealthScoreRow) => row.issues.some(id => isScored(id, ignore));
  const pagesWithScoredIssues = rows.filter(hasScored).length;
  const healthScoreV1 = rows.length ? Math.round(100 * (1 - pagesWithScoredIssues / rows.length)) : 0;
  const withoutRedirects = rows.filter(row => !isPlainInternalRedirect(row));
  const redirectsExcluded = rows.length - withoutRedirects.length;
  const scoredRows = withoutRedirects.filter(row => !(row.intentionalNoindex && !hasScored(row)));
  const noindexExcluded = withoutRedirects.length - scoredRows.length;
  let healthScore: number;
  if (!rows.length) healthScore = 0; // nothing crawled — same as v1
  else if (!scoredRows.length) healthScore = 100; // only clean internal redirects or pages closed on purpose: nothing wrong was seen
  else healthScore = Math.round(scoredRows.reduce((sum, row) => sum + pageHealthScore(row.issues, ignore), 0) / scoredRows.length);
  return {
    healthScore,
    healthScoreV1,
    scoreVersion: HEALTH_SCORE_VERSION,
    scoredPages: scoredRows.length,
    redirectsExcluded,
    pagesWithScoredIssues,
    noindexExcluded,
  };
}
