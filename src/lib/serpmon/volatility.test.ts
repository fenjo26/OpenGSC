import assert from "node:assert/strict";
import test from "node:test";
import { mad, median, quantile, rboExt, shareAboveOwnP90, stormVerdict } from "./volatility";

function assertClose(actual: number, expected: number, eps = 1e-9, message = ""): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${message} expected ${actual} to be within ${eps} of ${expected}`,
  );
}

test("rboExt identities: identical → 1, disjoint → 0, empty → 1", () => {
  const a = ["a", "b", "c", "d"];
  assertClose(rboExt(a, a, 0.9), 1);
  assertClose(rboExt(["a", "b"], ["c", "d"], 0.9), 0);
  assert.equal(rboExt([], [], 0.9), 1);
  assert.equal(rboExt(["a"], [], 0.9), 1);
  assert.equal(rboExt([], ["a"], 0.95), 1);
});

test("rboExt worked example: A=[a,b,c], B=[b,a,c], p=0.9 → exactly 0.9", () => {
  // X1=0, X2=2, X3=3; Σ = 0 + 0.81 + 0.729 = 1.539; (0.1/0.9)·1.539 = 0.171; + 1·0.729 = 0.9
  assertClose(rboExt(["a", "b", "c"], ["b", "a", "c"], 0.9), 0.9, 1e-9);
});

test("rboExt is symmetric", () => {
  const a = ["a", "b", "c", "d", "e", "f", "g"];
  const b = ["b", "a", "c", "d", "e", "g", "x"];
  assertClose(rboExt(a, b, 0.95), rboExt(b, a, 0.95), 0);
  assertClose(rboExt(a, a.slice().reverse(), 0.8), rboExt(a.slice().reverse(), a, 0.8), 0);
});

test("rboExt truncates both lists to the shorter one", () => {
  // common prefix [a, b], k = 2: X1=1, X2=2 → RBO = p² + (1−p)(1+p) = 1
  assertClose(rboExt(["a", "b", "c", "d"], ["a", "b"], 0.8), 1, 1e-9);
  assertClose(rboExt(["a", "b"], ["a", "b", "c", "d"], 0.8), 1, 1e-9);
  // shared head with disjoint tails scores in (0, 1)
  const partial = rboExt(["a", "b", "c", "d"], ["a", "b", "x", "y"], 0.9);
  assert.ok(partial > 0 && partial < 1, `partial overlap in (0,1), got ${partial}`);
});

test("rboExt counts duplicates by first occurrence only", () => {
  // A=[a,a,b], B=[a,b,b], p=0.5: X1=1, X2=1, X3=2
  // Σ = 0.5 + 0.125 + (2/3)·0.125 = 0.708333…; RBO = (2/3)·0.125 + 1·0.708333… = 19/24
  assertClose(rboExt(["a", "a", "b"], ["a", "b", "b"], 0.5), 19 / 24, 1e-12);
  // Set semantics: ["a","a","a"] is effectively the 1-element list {a}, even against itself.
  // X_d = 1 for every d → Σ = 0.9 + 0.405 + 0.243 = 1.548 → 0.243 + (1/9)·1.548 = 0.415
  assertClose(rboExt(["a", "a", "a"], ["a", "a", "a"], 0.9), 0.415, 1e-9);
});

test("median does not mutate and handles odd, even and empty input", () => {
  const xs = [3, 1, 2];
  assert.equal(median(xs), 2);
  assert.deepEqual(xs, [3, 1, 2]);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.ok(Number.isNaN(median([])));
});

test("mad is the unscaled median absolute deviation", () => {
  assert.equal(mad([1, 1, 2, 2, 4, 6, 9]), 1);
  assert.equal(mad([5, 5, 5]), 0);
  assert.equal(mad([0, 10]), 5);
  assert.ok(Number.isNaN(mad([])));
});

test("quantile interpolates linearly, clamps q, and does not mutate", () => {
  const xs = [1, 2, 3, 4];
  assert.equal(quantile(xs, 0), 1);
  assert.equal(quantile(xs, 1), 4);
  assert.equal(quantile(xs, 0.5), 2.5);
  assert.equal(quantile(xs, 0.25), 1.75);
  assert.equal(quantile(xs, 0.75), 3.25);
  assert.equal(quantile([10], 0.3), 10);
  assert.ok(Number.isNaN(quantile([], 0.5)));
  assert.deepEqual(xs, [1, 2, 3, 4]);
});

// A quiet but not constant baseline: median 0.10, mad ≈ 0.01 → z(0.30) ≈ 10 > STORM_Z.
const noisyBaseline = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 0.09 : 0.11));

test("fewer than STORM_MIN_BASELINE baseline runs → calibrating, no verdict", () => {
  const v = stormVerdict({ current: 0.3, baseline: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1], compared: 100, planned: 100, shareHigh: 0.5 });
  assert.equal(v.calibrating, true);
  assert.equal(v.score, null);
  assert.equal(v.storm, false);
  assert.equal(v.baselineRuns, 6);
  const ready = stormVerdict({ current: 0.3, baseline: noisyBaseline.slice(0, 7), compared: 100, planned: 100, shareHigh: 0.5 });
  assert.equal(ready.calibrating, false);
});

test("a spike over a quiet baseline with a high share is a storm", () => {
  const v = stormVerdict({ current: 0.3, baseline: noisyBaseline, compared: 100, planned: 100, shareHigh: 0.5 });
  assert.equal(v.calibrating, false);
  assert.ok(v.score !== null && v.score > 3);
  assert.equal(v.storm, true);
  assert.equal(v.baselineRuns, 20);
});

test("the same spike with a low share is not a storm", () => {
  const v = stormVerdict({ current: 0.3, baseline: noisyBaseline, compared: 100, planned: 100, shareHigh: 0.1 });
  assert.ok(v.score !== null && v.score >= 3);
  assert.equal(v.storm, false);
});

test("shareHigh null never turns a high score into a storm", () => {
  const v = stormVerdict({ current: 0.3, baseline: noisyBaseline, compared: 100, planned: 100, shareHigh: null });
  assert.ok(v.score !== null);
  assert.equal(v.storm, false);
});

test("current at the baseline median scores ≈ 0", () => {
  const baseline = [0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25];
  const v = stormVerdict({ current: median(baseline), baseline, compared: 50, planned: 50, shareHigh: 0.9 });
  assert.ok(v.score !== null);
  assert.ok(Math.abs(v.score) < 1e-9, `score at median ≈ 0, got ${v.score}`);
  assert.equal(v.storm, false);
});

test("zero MAD does not divide by zero", () => {
  const v = stormVerdict({ current: 0.3, baseline: Array.from({ length: 20 }, () => 0.1), compared: 100, planned: 100, shareHigh: 0.5 });
  assert.ok(v.score !== null && Number.isFinite(v.score));
  assert.equal(v.storm, true);
  const calm = stormVerdict({ current: 0.1, baseline: Array.from({ length: 20 }, () => 0.1), compared: 100, planned: 100, shareHigh: 0.5 });
  assert.equal(calm.score, 0);
  assert.equal(calm.storm, false);
});

test("not enough compared keywords → score null, storm false, not calibrating", () => {
  const v = stormVerdict({ current: 0.9, baseline: noisyBaseline, compared: 5, planned: 944, shareHigh: 0.9 });
  assert.equal(v.calibrating, false);
  assert.equal(v.score, null);
  assert.equal(v.storm, false);
});

test("the compared gate is max(absolute, share × planned)", () => {
  const enough = stormVerdict({ current: 0.1, baseline: noisyBaseline, compared: 10, planned: 33, shareHigh: 0 });
  assert.ok(enough.score !== null); // max(10, 9.9) = 10 → 10 comparable is enough
  const notEnough = stormVerdict({ current: 0.1, baseline: noisyBaseline, compared: 9, planned: 33, shareHigh: 0 });
  assert.equal(notEnough.score, null);
});

test("a null current produces no score and no storm", () => {
  const v = stormVerdict({ current: null, baseline: noisyBaseline, compared: 100, planned: 100, shareHigh: 0.9 });
  assert.equal(v.calibrating, false);
  assert.equal(v.score, null);
  assert.equal(v.storm, false);
});

test("shareAboveOwnP90: keywords with fewer than 5 history points are skipped", () => {
  assert.equal(shareAboveOwnP90([{ current: 0.9, history: [0.1, 0.1, 0.1, 0.1] }]), null);
  assert.equal(shareAboveOwnP90([]), null);
  // the ineligible keyword does not reach the denominator
  const mixed = shareAboveOwnP90([
    { current: 0.5, history: [0.1, 0.1, 0.1, 0.1, 0.1] },
    { current: 0.9, history: [0.2, 0.2, 0.2, 0.2] },
  ]);
  assert.equal(mixed, 1);
});

test("shareAboveOwnP90 counts strictly-above currents over each keyword's own p90", () => {
  const share = shareAboveOwnP90([
    { current: 0.5, history: [0.1, 0.1, 0.1, 0.1, 0.1] },  // above its p90
    { current: 0.05, history: [0.1, 0.1, 0.1, 0.1, 0.1] }, // below
    { current: 0.1, history: [0.5, 0.5, 0.5, 0.5, 0.5] },  // equal — not above
  ]);
  assert.equal(share, 1 / 3);
});

test("shareAboveOwnP90 interpolates p90: a current equal to the interpolated p90 is not above", () => {
  const history = [0.1, 0.2, 0.3, 0.4, 0.5]; // p90 = 0.4 + 0.6·0.1 = 0.46
  assert.equal(shareAboveOwnP90([{ current: 0.46, history }]), 0);
  assert.equal(shareAboveOwnP90([{ current: 0.47, history }]), 1);
});
