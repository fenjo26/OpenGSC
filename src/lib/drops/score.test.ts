import assert from "node:assert/strict";
import test from "node:test";
import { scoreCandidate, scoreCandidateDetailed } from "./score";

test("an empty candidate scores zero rather than throwing", () => {
  assert.equal(scoreCandidate({}), 0);
  assert.equal(scoreCandidate({ dr: null, refdomains: null, historyVerdict: null }), 0);
});

test("more dofollow donors always scores higher", () => {
  const at = (n: number) => scoreCandidate({ refdomainsDofollow: n });
  assert.ok(at(50) > at(10));
  assert.ok(at(10) > at(1));
  assert.ok(at(1) > at(0));
});

// Linear weighting would let one outlier bury the rest of the list; the gap from 5 to 15 donors
// has to matter more than the gap from 300 to 310.
test("donor count is log-scaled, so the low end is where the resolution is", () => {
  const at = (n: number) => scoreCandidate({ refdomainsDofollow: n });
  assert.ok(at(15) - at(5) > at(310) - at(300));
});

test("dofollow count wins over the raw total when both are known", () => {
  const both = scoreCandidate({ refdomains: 400, refdomainsDofollow: 4 });
  const onlyDofollow = scoreCandidate({ refdomainsDofollow: 4 });
  assert.equal(both, onlyDofollow);
});

test("a spam period outweighs good metrics", () => {
  const clean = scoreCandidate({ dr: 10, refdomainsDofollow: 20, historyVerdict: "clean" });
  const spam = scoreCandidate({ dr: 10, refdomainsDofollow: 20, historyVerdict: "spam_period" });
  assert.ok(spam < clean - 40, `clean=${clean} spam=${spam}`);
});

test("an unexamined history is an absence, not a penalty", () => {
  const unknown = scoreCandidate({ dr: 20, historyVerdict: "unknown" });
  const omitted = scoreCandidate({ dr: 20 });
  assert.equal(unknown, omitted);
});

test("a domain nobody ever archived is penalised", () => {
  const none = scoreCandidate({ dr: 20, waybackSnapshots: 0 });
  const some = scoreCandidate({ dr: 20, waybackSnapshots: 40 });
  assert.ok(none < some);
  assert.ok(none < scoreCandidate({ dr: 20 }), "zero snapshots is worse than not having looked");
});

test("a domain dead for years loses points", () => {
  const fresh = scoreCandidate({ refdomainsDofollow: 30, waybackGapDays: 400 });
  const stale = scoreCandidate({ refdomainsDofollow: 30, waybackGapDays: 2000 });
  // Two values each rounded to one decimal; their difference still carries float noise.
  assert.ok(Math.abs((fresh - stale) - 15) < 1e-6, `fresh=${fresh} stale=${stale}`);
});

test("DR is clamped, so a bad value cannot dominate the list", () => {
  assert.equal(scoreCandidate({ dr: 100 }), scoreCandidate({ dr: 5000 }));
  assert.equal(scoreCandidate({ dr: -20 }), 0);
  assert.equal(scoreCandidate({ dr: NaN }), 0);
});

test("the breakdown adds up to the score, so a row can be explained", () => {
  const c = { dr: 18, refdomainsDofollow: 45, waybackSnapshots: 44, waybackGapDays: 2000, historyVerdict: "clean" as const };
  const d = scoreCandidateDetailed(c);
  const sum = Math.round(d.parts.reduce((a, p) => a + p.value, 0) * 10) / 10;
  assert.equal(d.score, sum);
  assert.deepEqual(d.parts.map(p => p.label), ["refdomains", "dr", "history", "snapshots", "stale"]);
});
