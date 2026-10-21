import { test } from "node:test";
import assert from "node:assert/strict";
import { planAnchors, seedFromString, type AnchorSpec } from "./anchors";

const A = (text: string, kind: AnchorSpec["kind"]): AnchorSpec => ({ text, kind });

test("quotas follow shares via largest remainder, summing to count", () => {
  const anchors = [A("e1", "exact"), A("u1", "url"), A("u2", "url")];
  const plan = planAnchors(anchors, { exact: 1, url: 4 }, 10, 1);
  assert.equal(plan.assignments.length, 10);
  assert.equal(plan.byKind.exact + plan.byKind.url, 10);
  assert.equal(plan.byKind.exact, 2); // 1/5 of 10
  assert.equal(plan.byKind.url, 8);
});

test("a kind with a share but no anchors gets zero, weight goes elsewhere", () => {
  // brand has share 5 but no brand anchors — its quota must not appear.
  const anchors = [A("u1", "url")];
  const plan = planAnchors(anchors, { brand: 5, url: 1 }, 6, 1);
  assert.equal(plan.byKind.brand, 0);
  assert.equal(plan.byKind.url, 6);
  assert.ok(plan.assignments.every(a => a.kind === "url"));
});

test("empty anchor list yields an empty plan (no bare-domain fallback)", () => {
  const plan = planAnchors([], { exact: 1 }, 5, 1);
  assert.deepEqual(plan.assignments, []);
  assert.equal(plan.byKind.exact, 0);
});

test("deterministic: same seed → same layout, and it is not a plain cycle", () => {
  const anchors = [A("e1", "exact"), A("b1", "brand"), A("u1", "url"), A("g1", "generic")];
  const shares = { exact: 1, brand: 1, url: 1, generic: 1 };
  const a = planAnchors(anchors, shares, 8, seedFromString("camp_1"));
  const b = planAnchors(anchors, shares, 8, seedFromString("camp_1"));
  assert.deepEqual(a.assignments, b.assignments);
  // Not the regular "drop i gets anchor i%n" sequence WayForge uses.
  const regular = Array.from({ length: 8 }, (_, i) => anchors[i % anchors.length].text);
  const got = a.assignments.map(x => x.text);
  assert.notDeepEqual(got, regular);
});

test("different seeds generally differ", () => {
  const anchors = [A("e1", "exact"), A("b1", "brand"), A("u1", "url"), A("g1", "generic")];
  const shares = { exact: 1, brand: 1, url: 1, generic: 1 };
  const a = planAnchors(anchors, shares, 12, seedFromString("camp_A")).assignments.map(x => x.text);
  const b = planAnchors(anchors, shares, 12, seedFromString("camp_B")).assignments.map(x => x.text);
  assert.notDeepEqual(a, b);
});

test("no shares at all → even split across available kinds", () => {
  const anchors = [A("e1", "exact"), A("u1", "url")];
  const plan = planAnchors(anchors, {}, 10, 3);
  assert.equal(plan.byKind.exact, 5);
  assert.equal(plan.byKind.url, 5);
});
