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
  inconclusive: AuditFindingRef[];
  counts: { resolved: number; stillPresent: number; regressions: number; inconclusive: number };
}

const findingKey = (url: string, ruleId: string) => `${url}\u0000${ruleId}`;

/** Deterministic comparison used by both persisted audit verification and tests. */
export function compareAuditFindings(
  baselineAuditId: string,
  baseline: AuditPageFindingSnapshot[],
  current: AuditPageFindingSnapshot[],
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
    if (!baselineFindings.has(key)) regressions.push(finding);
  }

  const sort = (a: AuditFindingRef, b: AuditFindingRef) => a.url.localeCompare(b.url) || a.ruleId.localeCompare(b.ruleId);
  resolved.sort(sort); stillPresent.sort(sort); regressions.sort(sort); inconclusive.sort(sort);
  return {
    baselineAuditId,
    resolved,
    stillPresent,
    regressions,
    inconclusive,
    counts: {
      resolved: resolved.length,
      stillPresent: stillPresent.length,
      regressions: regressions.length,
      inconclusive: inconclusive.length,
    },
  };
}
