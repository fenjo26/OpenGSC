// Thin rows for the workspace-wide audit history (GET /api/audit without siteId).
//
// The global page lists every audit in the workspace, so the per-row payload stays scalars:
// the full summary / verification JSON belongs to the per-site Audit tab and the per-audit
// endpoint, and shipping both for hundreds of rows would bloat the list for data the table
// never renders. Legacy rows are expected here — summaries and verifications predate parts of
// this shape, and a broken or missing JSON degrades to nulls instead of dropping the row.

import { AUDIT_RULES } from "./rules";

const CRITICAL_CODES = new Set(AUDIT_RULES.filter(rule => rule.severity === "critical").map(rule => rule.id));

export interface AuditVerificationCounts {
  resolved: number;
  stillPresent: number;
  regressions: number;
  inconclusive: number;
}

export interface AuditHistoryRow {
  id: string;
  siteId: string;
  siteUrl: string;
  status: string;
  startedAt: string; // ISO
  finishedAt: string | null;
  pagesCrawled: number;
  baselineAuditId: string | null;
  error: string | null;
  healthScore: number | null;
  pages: number | null;
  pagesWithIssues: number | null;
  criticalIssues: number | null;
  verification: AuditVerificationCounts | null;
}

export function toAuditHistoryRow(
  audit: {
    id: string;
    status: string;
    startedAt: Date | string;
    finishedAt: Date | string | null;
    pagesCrawled: number;
    baselineAuditId: string | null;
    error: string | null;
    summary: string | null;
    verification: string | null;
  },
  site: { id: string; url: string },
): AuditHistoryRow {
  let summary: any = null;
  try { summary = audit.summary ? JSON.parse(audit.summary) : null; } catch { /* legacy row */ }
  let verification: any = null;
  try { verification = audit.verification ? JSON.parse(audit.verification) : null; } catch { /* legacy row */ }

  // Only critical codes count here: the global table is a triage view, and mixing warnings into
  // the one number an operator scans across 80 sites would bury the signal.
  const issues = summary?.issues;
  const criticalIssues = issues && typeof issues === "object" && !Array.isArray(issues)
    ? Object.entries(issues as Record<string, unknown>)
        .filter(([code, count]) => CRITICAL_CODES.has(code) && typeof count === "number")
        .reduce((sum, [, count]) => sum + (count as number), 0)
    : 0;

  // Newer runs ship a `counts` object; older ones only carry the finding arrays. Prefer the
  // explicit counts, fall back to counting the arrays, so pre-counts verifications still read.
  const counts = verification?.counts ?? {};
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const verificationCounts: AuditVerificationCounts | null = verification ? {
    resolved: num(counts.resolved) ?? len(verification.resolved),
    stillPresent: num(counts.stillPresent) ?? len(verification.stillPresent),
    regressions: num(counts.regressions) ?? len(verification.regressions),
    inconclusive: num(counts.inconclusive) ?? len(verification.inconclusive),
  } : null;

  return {
    id: audit.id,
    siteId: site.id,
    siteUrl: site.url,
    status: audit.status,
    startedAt: new Date(audit.startedAt).toISOString(),
    finishedAt: audit.finishedAt ? new Date(audit.finishedAt).toISOString() : null,
    pagesCrawled: audit.pagesCrawled,
    baselineAuditId: audit.baselineAuditId,
    error: audit.error,
    healthScore: num(summary?.healthScore),
    pages: num(summary?.pages),
    pagesWithIssues: num(summary?.pagesWithIssues),
    criticalIssues: summary ? criticalIssues : null,
    verification: verificationCounts,
  };
}
