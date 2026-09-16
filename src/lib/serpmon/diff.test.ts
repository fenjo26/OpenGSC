import assert from "node:assert/strict";
import test from "node:test";
import { diffKeyword, hostPositions } from "./diff";
import { ignorePredicate } from "./hosts";
import type { HostChange, SerpRow } from "./types";

let urlSeq = 0;
function row(position: number, host: string, url?: string): SerpRow {
  urlSeq += 1;
  return { position, host, url: url ?? `https://${host}/u${urlSeq}`, title: `t${urlSeq}` };
}

type Spec = [position: number, host: string][];

function listing(spec: Spec): SerpRow[] {
  return spec.map(([position, host]) => row(position, host));
}

const noIgnore = (): boolean => false;
const findChange = (changes: HostChange[], host: string): HostChange | undefined =>
  changes.find((c) => c.host === host);

test("hostPositions keeps the best position, counts urls, sorts by best, cuts beyond depth", () => {
  assert.deepEqual(hostPositions(listing([
    [1, "a.test"], [5, "b.test"], [3, "a.test"], [150, "a.test"], [2, "c.test"],
  ]), 100), [
    { host: "a.test", best: 1, urls: 2 },
    { host: "c.test", best: 2, urls: 1 },
    { host: "b.test", best: 5, urls: 1 },
  ]);
  assert.deepEqual(hostPositions(listing([[1, "a.test"], [2, "a.test"], [5, "a.test"]]), 3), [
    { host: "a.test", best: 1, urls: 2 }, // row at position 5 is beyond depth 3
  ]);
  assert.deepEqual(hostPositions(listing([[150, "deep.test"]]), 100), []);
});

test("identical lists produce no changes and zero volatility", () => {
  const spec: Spec = Array.from({ length: 30 }, (_, i) => [i + 1, `h${i + 1}.test`]);
  const diff = diffKeyword(listing(spec), listing(spec), { depth: 100, ignore: noIgnore });
  assert.deepEqual(diff.changes, []);
  assert.equal(diff.visibleCount, 0);
  assert.equal(diff.volatility, 0);
  assert.equal(diff.volTop10, 0);
});

test("one host losing nine urls is ONE exit change with urls: 9 (post regression)", () => {
  const before: Spec = Array.from({ length: 49 }, (_, i) => [i + 1, `f${i + 1}.test`]);
  const dropped: Spec = Array.from({ length: 9 }, (_, i) => [50 + i, "dropper.test"]);
  const after: Spec = Array.from({ length: 42 }, (_, i) => [59 + i, `g${i + 1}.test`]);
  const prev = listing([...before, ...dropped, ...after]); // 100 rows, 92 hosts
  const cur = listing([...before, ...after]);              // 91 rows, none of them moves
  const diff = diffKeyword(prev, cur, { depth: 100, ignore: noIgnore });
  assert.equal(diff.changes.length, 1);
  assert.deepEqual(diff.changes[0], { host: "dropper.test", kind: "exit", from: 50, to: null, urls: 9, hidden: false });
  assert.equal(diff.visibleCount, 1);
  assert.ok(diff.volatility > 0); // the host order below the dropped block shifted by 9 ranks
});

test("a host swapping urls at the same position is not a change", () => {
  const prev = [row(3, "a.test", "https://a.test/old")];
  const cur = [row(3, "a.test", "https://a.test/new")];
  assert.deepEqual(diffKeyword(prev, cur, { depth: 100, ignore: noIgnore }).changes, []);
});

test("a host losing one of its urls is not a change either", () => {
  const prev = listing([[1, "a.test"], [2, "a.test"]]);
  const cur = listing([[1, "a.test"]]);
  const diff = diffKeyword(prev, cur, { depth: 100, ignore: noIgnore });
  assert.deepEqual(diff.changes, []);
  // ... but a later genuine exit of that host reports its current url count
  const gone = diffKeyword(prev, listing([[1, "other.test"]]), { depth: 100, ignore: noIgnore });
  assert.deepEqual(findChange(gone.changes, "a.test"), { host: "a.test", kind: "exit", from: 1, to: null, urls: 2, hidden: false });
});

function assertMove(from: number, to: number, expected: HostChange | null): void {
  const changes = diffKeyword(listing([[from, "a.test"]]), listing([[to, "a.test"]]), { depth: 100, ignore: noIgnore }).changes;
  if (expected === null) {
    assert.deepEqual(changes, [], `${from} → ${to} must stay silent`);
  } else {
    assert.deepEqual(changes, [expected], `${from} → ${to}`);
  }
}

test("move thresholds follow the band of min(from, to)", () => {
  assertMove(95, 99, null);        // band 95 → threshold 15, delta 4
  assertMove(99, 85, null);        // delta 14 < 15
  assertMove(90, 75, { host: "a.test", kind: "up", from: 90, to: 75, urls: 1, hidden: false }); // delta 15
  assertMove(75, 90, { host: "a.test", kind: "down", from: 75, to: 90, urls: 1, hidden: false });
  assertMove(2, 6, { host: "a.test", kind: "down", from: 2, to: 6, urls: 1, hidden: false });     // band 2 → 3
  assertMove(6, 2, { host: "a.test", kind: "up", from: 6, to: 2, urls: 1, hidden: false });
  assertMove(9, 12, { host: "a.test", kind: "down", from: 9, to: 12, urls: 1, hidden: false });   // delta 3 fires on equality
  assertMove(25, 31, null);        // band min 25 → threshold 7, delta 6
  assertMove(25, 33, { host: "a.test", kind: "down", from: 25, to: 33, urls: 1, hidden: false }); // delta 8
  assertMove(25, 18, { host: "a.test", kind: "up", from: 25, to: 18, urls: 1, hidden: false });
  assertMove(14, 11, null);        // band min 11 → threshold 7, delta 3
});

test("band edges: 10 keeps the tight threshold, 11 does not", () => {
  assertMove(10, 13, { host: "a.test", kind: "down", from: 10, to: 13, urls: 1, hidden: false }); // min 10 → threshold 3
  assertMove(11, 14, null);        // min 11 → band 30 → threshold 7, delta 3
  assertMove(11, 18, { host: "a.test", kind: "down", from: 11, to: 18, urls: 1, hidden: false }); // delta 7
});

test("comparison stays inside the comparable depth: a host at 80 is not an exit at depth 60", () => {
  const prev = listing([
    ...Array.from({ length: 79 }, (_, i) => [i + 1, `a${i + 1}.test`] as [number, string]),
    [80, "was80.test"],
    ...Array.from({ length: 20 }, (_, i) => [81 + i, `b${i + 1}.test`] as [number, string]),
  ]);
  const cur = listing(Array.from({ length: 60 }, (_, i) => [i + 1, `a${i + 1}.test`] as [number, string]));
  const diff = diffKeyword(prev, cur, { depth: 60, ignore: noIgnore });
  assert.equal(diff.comparedDepth, 60);
  assert.ok(!findChange(diff.changes, "was80.test"));
  assert.ok(!findChange(diff.changes, "b1.test"));
  // Both sides are cut to the first 60 slots — nothing below them can enter or exit at all.
  assert.deepEqual(diff.changes, []);
  assert.equal(diff.visibleCount, 0);
  assert.equal(diff.volatility, 0); // the first 60 host slots are identical
});

test("platform changes are hidden but stored, and volatility still sees them", () => {
  const prev = listing([[1, "a.test"], [2, "b.test"], [3, "c.test"]]);
  const cur = listing([[1, "facebook.com"], [2, "a.test"], [3, "b.test"], [4, "c.test"]]);
  const diff = diffKeyword(prev, cur, { depth: 100, ignore: ignorePredicate([]) });
  assert.equal(diff.changes.length, 1);
  assert.deepEqual(diff.changes[0], { host: "facebook.com", kind: "enter", from: null, to: 1, urls: 1, hidden: true });
  assert.equal(diff.visibleCount, 0);
  assert.ok(diff.volatility > 0);
  assert.ok(diff.volTop10 > 0);
});

test("a platform exit is hidden too", () => {
  const prev = listing([[1, "facebook.com"], [2, "a.test"]]);
  const cur = listing([[1, "a.test"]]);
  const diff = diffKeyword(prev, cur, { depth: 100, ignore: ignorePredicate([]) });
  assert.equal(diff.changes.length, 1);
  assert.deepEqual(diff.changes[0], { host: "facebook.com", kind: "exit", from: 1, to: null, urls: 1, hidden: true });
  assert.equal(diff.visibleCount, 0);
});

test("a full list replacement gives volatility 1 and enter/exit pairs", () => {
  const prev = listing(Array.from({ length: 20 }, (_, i) => [i + 1, `old${i + 1}.test`] as [number, string]));
  const cur = listing(Array.from({ length: 20 }, (_, i) => [i + 1, `new${i + 1}.test`] as [number, string]));
  const diff = diffKeyword(prev, cur, { depth: 100, ignore: noIgnore });
  assert.equal(diff.volatility, 1);
  assert.equal(diff.volTop10, 1);
  assert.equal(diff.changes.length, 40); // 20 enters + 20 exits
  assert.equal(diff.visibleCount, 40);
});

test("RBO weights the top: a top-10 shuffle moves volTop10, a 91st-place shuffle does not", () => {
  const hosts = Array.from({ length: 100 }, (_, i) => `h${i + 1}.test`);
  const prev = listing(hosts.map((h, i) => [i + 1, h] as [number, string]));
  const swap = (list: string[], i: number, j: number): string[] => {
    const copy = list.slice();
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
    return copy;
  };
  const curTop = listing(swap(hosts, 0, 1).map((h, i) => [i + 1, h] as [number, string]));
  const curTail = listing(swap(hosts, 90, 91).map((h, i) => [i + 1, h] as [number, string]));
  const topDiff = diffKeyword(prev, curTop, { depth: 100, ignore: noIgnore });
  const tailDiff = diffKeyword(prev, curTail, { depth: 100, ignore: noIgnore });
  assert.ok(topDiff.volTop10 > 0);
  assert.equal(tailDiff.volTop10, 0); // the first 10 hosts are untouched
  assert.equal(tailDiff.volatility, 0); // raw ≈ 5e-6 — rounds away at the contractual 4 decimals
  assert.ok(topDiff.volatility > 0);
  assert.ok(topDiff.volatility > tailDiff.volatility);
});

test("changes are sorted: enters by `to`, moves by |delta| desc, exits by `from`, ties by host", () => {
  const fillersPrev: Spec = [];
  const fillersCur: Spec = [];
  const reservedPrev = new Set([3, 6, 25, 40]);   // exit-early, mover-small, mover-big, exit-late
  const reservedCur = new Set([2, 5, 10, 15]);    // enter-b, enter-a, mover-small, mover-big
  for (let pos = 1; pos <= 40; pos++) {
    if (!reservedPrev.has(pos)) fillersPrev.push([pos, `pf${pos}.test`]);
    if (!reservedCur.has(pos) && !(pos === 3 || pos === 6 || pos === 25 || pos === 40)) {
      fillersCur.push([pos, `pf${pos}.test`]);
    }
  }
  const prev = listing([
    ...fillersPrev,
    [3, "exit-early.test"], [6, "mover-small.test"], [25, "mover-big.test"], [40, "exit-late.test"],
  ]);
  const cur = listing([
    ...fillersCur,
    [2, "enter-b.test"], [5, "enter-a.test"], [10, "mover-small.test"], [15, "mover-big.test"],
  ]);
  const diff = diffKeyword(prev, cur, { depth: 100, ignore: noIgnore });
  assert.deepEqual(diff.changes.map((c) => [c.kind, c.host, c.from, c.to]), [
    ["enter", "enter-b.test", null, 2],
    ["enter", "enter-a.test", null, 5],
    ["up", "mover-big.test", 25, 15],     // |delta| 10
    ["down", "mover-small.test", 6, 10],  // |delta| 4
    ["exit", "pf2.test", 2, null],
    ["exit", "exit-early.test", 3, null],
    ["exit", "pf5.test", 5, null],
    ["exit", "pf10.test", 10, null],
    ["exit", "pf15.test", 15, null],
    ["exit", "exit-late.test", 40, null],
  ]);
  assert.equal(diff.visibleCount, 10);
});

test("moves with equal |delta| are ordered by host name for determinism", () => {
  const prev = listing([[2, "bb.test"], [4, "aa.test"]]);
  const cur = listing([[7, "bb.test"], [9, "aa.test"]]);
  const diff = diffKeyword(prev, cur, { depth: 100, ignore: noIgnore });
  assert.deepEqual(diff.changes.map((c) => [c.host, c.kind, c.from, c.to]), [
    ["aa.test", "down", 4, 9],
    ["bb.test", "down", 2, 7],
  ]);
});

test("the exit urls count comes from the previous snapshot", () => {
  const prev = listing([[5, "multi.test"], [7, "multi.test"], [9, "multi.test"], [1, "other.test"]]);
  const cur = listing([[1, "other.test"], [2, "fresh.test"]]);
  const diff = diffKeyword(prev, cur, { depth: 100, ignore: noIgnore });
  assert.deepEqual(findChange(diff.changes, "multi.test"), {
    host: "multi.test", kind: "exit", from: 5, to: null, urls: 3, hidden: false,
  });
  assert.deepEqual(findChange(diff.changes, "fresh.test"), {
    host: "fresh.test", kind: "enter", from: null, to: 2, urls: 1, hidden: false,
  });
});
