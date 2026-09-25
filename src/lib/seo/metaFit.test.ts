import assert from "node:assert/strict";
import test from "node:test";
import { META_LIMITS, metaLength } from "./metaLimits";

// T1 rewrites this file; these two checks must survive the rewrite (docs/tasks/wave-oct/T0-foundation.md §2).
test("the target band sits wholly inside the audit band", () => {
  for (const field of ["title", "description"] as const) {
    const { targetMin, targetMax, auditMin, auditMax } = META_LIMITS[field];
    assert.ok(auditMin <= targetMin, `${field}: auditMin ≤ targetMin`);
    assert.ok(targetMin <= targetMax, `${field}: targetMin ≤ targetMax`);
    assert.ok(targetMax <= auditMax, `${field}: targetMax ≤ auditMax`);
  }
});

test("metaLength counts Unicode code points after trimming", () => {
  assert.equal(metaLength("Ελληνικά"), 8);
});

test("placeholder (T1)", () => {});
