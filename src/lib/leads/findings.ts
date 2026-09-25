// N9 — the pure finding helpers, kept in a module with ZERO imports beyond ./types.
// Client components (the /leads inbox, the proposal draft) need topFindings, but its old
// home (./liteAudit) imports safeFetch → node:dns — a Node external the client bundle
// cannot carry (a Turbopack build failure on the server, invisible to tsc/eslint).
import type { FindingSeverity, RawFinding } from "./types";

export const SEVERITY_WEIGHT: Record<FindingSeverity, number> = { critical: 12, warning: 5, info: 1 };

export const SEVERITY_RANK: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** 100 minus the penalty of every DISTINCT finding code — the same idea as the scanner. */
export function scoreFromFindings(findings: RawFinding[]): number {
  const penalty = findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  return Math.max(0, 100 - Math.min(100, penalty));
}

/** Findings ordered critical → warning → info, stable; the widget's "top N" list. */
export function topFindings<T extends { severity: FindingSeverity }>(findings: T[], n: number): T[] {
  return [...findings]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || a.i - b.i)
    .slice(0, n)
    .map(x => x.f);
}
