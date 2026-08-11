import assert from "node:assert/strict";
import test from "node:test";
import { compareAuditFindings } from "./verification";

test("classifies resolved, persistent and new findings", () => {
  const result = compareAuditFindings("base", [
    { url: "https://example.com/", httpStatus: 200, issues: ["title_missing", "h1_missing"] },
  ], [
    { url: "https://example.com/", httpStatus: 200, issues: ["h1_missing", "slow_response"] },
  ]);
  assert.deepEqual(result.counts, { resolved: 1, stillPresent: 1, regressions: 1, inconclusive: 0 });
  assert.deepEqual(result.resolved[0], { url: "https://example.com/", ruleId: "title_missing" });
});

test("never reports a missing or unreachable page as resolved", () => {
  const baseline = [{ url: "https://example.com/a", httpStatus: 200, issues: ["title_missing"] }];
  assert.equal(compareAuditFindings("base", baseline, []).counts.inconclusive, 1);
  assert.equal(compareAuditFindings("base", baseline, [{ url: "https://example.com/a", httpStatus: 0, issues: ["fetch_failed"] }]).counts.inconclusive, 1);
  assert.equal(compareAuditFindings("base", baseline, [{ url: "https://example.com/a", httpStatus: 404, issues: ["http_error"] }]).counts.inconclusive, 1);
  assert.equal(compareAuditFindings("base", baseline, [{ url: "https://example.com/a", httpStatus: 301, issues: ["redirect"] }]).counts.inconclusive, 1);
});
