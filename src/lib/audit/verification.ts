export interface AuditPageFindingSnapshot {
  url: string;
  httpStatus: number;
  issues: string[];
}

export interface AuditFindingRef {
  url: string;
  ruleId: string;
}

export interface AuditVerification {
  baselineAuditId: string;
  resolved: AuditFindingRef[];
  stillPresent: AuditFindingRef[];
  regressions: AuditFindingRef[];
  /**
   * Findings under a rule the baseline audit could not possibly report — the audit's rule
   * registry grew between the two runs (wave-oct added 12 rules). The first post-release
   * verification would otherwise read as a site that suddenly broke everywhere.
   */
  newRules: AuditFindingRef[];
  inconclusive: AuditFindingRef[];
  counts: { resolved: number; stillPresent: number; regressions: number; newRules: number; inconclusive: number };
}

const findingKey = (url: string, ruleId: string) => `${url}\u0000${ruleId}`;

/**
 * Deterministic comparison used by both persisted audit verification and tests.
 *
 * `baselineRuleIds` (optional) is the set of rule ids the BASELINE audit ran with — read from
 * its own summary (`ruleIds`, or the issue-total keys for audits that predate that field). A
 * current finding under a rule absent from that set is filed under `newRules`, not
 * `regressions`: "the rule did not exist then" is not "the problem appeared". Without the set
 * (a baseline with no usable summary) the strict comparison stands, because an unbounded
 * "everything new is fine" would silently swallow real regressions.
 */
export function compareAuditFindings(
  baselineAuditId: string,
  baseline: AuditPageFindingSnapshot[],
  current: AuditPageFindingSnapshot[],
  baselineRuleIds?: ReadonlySet<string>,
): AuditVerification {
  const baselineFindings = new Map<string, AuditFindingRef>();
  const currentFindings = new Map<string, AuditFindingRef>();
  const currentPages = new Map(current.map(page => [page.url, page]));

  for (const page of baseline) {
    for (const ruleId of new Set(page.issues)) baselineFindings.set(findingKey(page.url, ruleId), { url: page.url, ruleId });
  }
  for (const page of current) {
    for (const ruleId of new Set(page.issues)) currentFindings.set(findingKey(page.url, ruleId), { url: page.url, ruleId });
  }

  const resolved: AuditFindingRef[] = [];
  const stillPresent: AuditFindingRef[] = [];
  const regressions: AuditFindingRef[] = [];
  const newRules: AuditFindingRef[] = [];
  const inconclusive: AuditFindingRef[] = [];

  for (const [key, finding] of baselineFindings) {
    if (currentFindings.has(key)) {
      stillPresent.push(finding);
      continue;
    }
    const page = currentPages.get(finding.url);
    // A page outside this crawl's discovered/maxPages set, or one we could not fetch, cannot prove
    // a fix. Calling it resolved would be the most damaging false positive in this workflow.
    if (!page || page.httpStatus < 200 || page.httpStatus >= 300) inconclusive.push(finding);
    else resolved.push(finding);
  }
  for (const [key, finding] of currentFindings) {
    if (baselineFindings.has(key)) continue;
    if (baselineRuleIds && !baselineRuleIds.has(finding.ruleId)) newRules.push(finding);
    else regressions.push(finding);
  }

  const sort = (a: AuditFindingRef, b: AuditFindingRef) => a.url.localeCompare(b.url) || a.ruleId.localeCompare(b.ruleId);
  resolved.sort(sort); stillPresent.sort(sort); regressions.sort(sort); newRules.sort(sort); inconclusive.sort(sort);
  return {
    baselineAuditId,
    resolved,
    stillPresent,
    regressions,
    newRules,
    inconclusive,
    counts: {
      resolved: resolved.length,
      stillPresent: stillPresent.length,
      regressions: regressions.length,
      newRules: newRules.length,
      inconclusive: inconclusive.length,
    },
  };
}
