import assert from "node:assert/strict";
import test from "node:test";
import { toAuditHistoryRow } from "./historyRows";

const site = { id: "site1", url: "https://example.com" };

test("extracts thin scalars and counts only critical issue codes", () => {
  const row = toAuditHistoryRow({
    id: "a1",
    status: "completed",
    startedAt: "2026-08-29T10:00:00.000Z",
    finishedAt: "2026-08-29T10:05:00.000Z",
    pagesCrawled: 42,
    baselineAuditId: null,
    error: null,
    summary: JSON.stringify({
      healthScore: 88,
      pages: 42,
      pagesWithIssues: 9,
      avgLoadMs: 410,
      // http_error and redirect_loop are critical rules; title_missing is a warning and must
      // not inflate the critical column.
      issues: { http_error: 3, redirect_loop: 2, title_missing: 7 },
    }),
    verification: null,
  }, site);
  assert.equal(row.siteId, "site1");
  assert.equal(row.siteUrl, "https://example.com");
  assert.equal(row.startedAt, "2026-08-29T10:00:00.000Z");
  assert.equal(row.finishedAt, "2026-08-29T10:05:00.000Z");
  assert.equal(row.healthScore, 88);
  assert.equal(row.pages, 42);
  assert.equal(row.pagesWithIssues, 9);
  assert.equal(row.criticalIssues, 5);
  assert.equal(row.verification, null);
});

test("verification prefers explicit counts and falls back to array lengths", () => {
  const withCounts = toAuditHistoryRow({
    id: "a2", status: "completed", startedAt: new Date(0), finishedAt: null,
    pagesCrawled: 1, baselineAuditId: "a1", error: null, summary: null,
    verification: JSON.stringify({
      counts: { resolved: 4, stillPresent: 2, regressions: 1, inconclusive: 3 },
      resolved: [], stillPresent: [], regressions: [], inconclusive: [],
    }),
  }, site);
  assert.deepEqual(withCounts.verification, { resolved: 4, stillPresent: 2, regressions: 1, inconclusive: 3 });
  assert.equal(withCounts.finishedAt, null);

  const arrayOnly = toAuditHistoryRow({
    id: "a3", status: "completed", startedAt: new Date(0), finishedAt: null,
    pagesCrawled: 1, baselineAuditId: "a1", error: null, summary: null,
    verification: JSON.stringify({
      resolved: [{ url: "/" }, { url: "/a" }],
      stillPresent: [{ url: "/b" }],
      regressions: [],
      inconclusive: [{ url: "/c" }],
    }),
  }, site);
  assert.deepEqual(arrayOnly.verification, { resolved: 2, stillPresent: 1, regressions: 0, inconclusive: 1 });
  // No summary JSON at all → the summary-derived columns degrade to nulls, not zeros.
  assert.equal(arrayOnly.healthScore, null);
  assert.equal(arrayOnly.criticalIssues, null);
});

test("broken legacy JSON never throws and never drops the row", () => {
  const row = toAuditHistoryRow({
    id: "a4", status: "error", startedAt: new Date(0), finishedAt: null,
    pagesCrawled: 0, baselineAuditId: null, error: "crawl failed",
    summary: "{not json", verification: "also not json",
  }, site);
  assert.equal(row.id, "a4");
  assert.equal(row.status, "error");
  assert.equal(row.error, "crawl failed");
  assert.equal(row.healthScore, null);
  assert.equal(row.pagesWithIssues, null);
  assert.equal(row.criticalIssues, null);
  assert.equal(row.verification, null);
});
