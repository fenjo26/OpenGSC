import assert from "node:assert/strict";
import test from "node:test";
import { compareAuditFindings } from "./verification";

test("classifies resolved, persistent and new findings", () => {
  const result = compareAuditFindings("base", [
    { url: "https://example.com/", httpStatus: 200, issues: ["title_missing", "h1_missing"] },
  ], [
    { url: "https://example.com/", httpStatus: 200, issues: ["h1_missing", "slow_response"] },
  ]);
  assert.deepEqual(result.counts, { resolved: 1, stillPresent: 1, regressions: 1, newRules: 0, inconclusive: 0 });
  assert.deepEqual(result.resolved[0], { url: "https://example.com/", ruleId: "title_missing" });
});

test("never reports a missing or unreachable page as resolved", () => {
  const baseline = [{ url: "https://example.com/a", httpStatus: 200, issues: ["title_missing"] }];
  assert.equal(compareAuditFindings("base", baseline, []).counts.inconclusive, 1);
  assert.equal(compareAuditFindings("base", baseline, [{ url: "https://example.com/a", httpStatus: 0, issues: ["fetch_failed"] }]).counts.inconclusive, 1);
  assert.equal(compareAuditFindings("base", baseline, [{ url: "https://example.com/a", httpStatus: 404, issues: ["http_error"] }]).counts.inconclusive, 1);
  assert.equal(compareAuditFindings("base", baseline, [{ url: "https://example.com/a", httpStatus: 301, issues: ["redirect"] }]).counts.inconclusive, 1);
});

test("a rule the baseline audit did not have is a new check, not a regression", () => {
  // wave-oct shipped hreflang_invalid; the baseline predates it. The first verification after
  // the release must not read as the site suddenly breaking.
  const baseline = [{ url: "https://example.com/", httpStatus: 200, issues: ["title_missing"] }];
  const current = [{ url: "https://example.com/", httpStatus: 200, issues: ["title_missing", "hreflang_invalid"] }];
  const withRegistry = compareAuditFindings("base", baseline, current, new Set(["title_missing"]));
  assert.deepEqual(withRegistry.counts, { resolved: 0, stillPresent: 1, regressions: 0, newRules: 1, inconclusive: 0 });
  assert.deepEqual(withRegistry.newRules[0], { url: "https://example.com/", ruleId: "hreflang_invalid" });

  // Without the baseline's registry the strict comparison stands: an unbounded "everything new
  // is fine" would silently swallow real regressions on legacy baselines.
  const strict = compareAuditFindings("base", baseline, current);
  assert.equal(strict.counts.regressions, 1);
  assert.equal(strict.counts.newRules, 0);

  // A rule the baseline DID know stays a genuine regression even when it never fired before.
  const genuine = compareAuditFindings("base", baseline, current, new Set(["title_missing", "hreflang_invalid"]));
  assert.equal(genuine.counts.regressions, 1);
});
