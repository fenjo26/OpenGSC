import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreSnapshot, pickBestSnapshot, type SnapshotMetrics } from "./score";

const base = (over: Partial<SnapshotMetrics>): SnapshotMetrics => ({
  timestamp: "20040121214835", pagesWithText: 5, textChars: 5000, domain: "example.com", ...over,
});

test("empty snapshot set → honest no_snapshot, never fabricated", () => {
  const r = pickBestSnapshot([]);
  assert.equal(r.verdict, "no_snapshot");
  assert.equal(r.score, 0);
});

test("a snapshot with no text is thin, not recommended", () => {
  const r = scoreSnapshot(base({ pagesWithText: 0, textChars: 0 }));
  assert.equal(r.verdict, "thin");
  assert.ok(r.score < 20);
});

test("parking/redirect signals → parked_or_doorway", () => {
  assert.equal(scoreSnapshot(base({ parkingSignals: true })).verdict, "parked_or_doorway");
  assert.equal(scoreSnapshot(base({ redirects: true })).verdict, "parked_or_doorway");
});

test("foreign brand in title is flagged (pets.com → PETsMART)", () => {
  const r = scoreSnapshot(base({ domain: "pets.com", title: "PETsMART.com - The smarter way to shop for your pet" }));
  assert.equal(r.verdict, "brand_mismatch");
});

test("own brand in title is fine", () => {
  const r = scoreSnapshot(base({ domain: "pets.com", title: "Pets.com - adopt a puppy" }));
  assert.notEqual(r.verdict, "brand_mismatch");
});

test("content outweighs page count: rich 1-pager beats empty 10-pager", () => {
  const rich = scoreSnapshot(base({ pagesWithText: 1, textChars: 9000 }));
  const empty = scoreSnapshot(base({ pagesWithText: 10, textChars: 500 }));
  assert.ok(rich.score > empty.score, `rich ${rich.score} vs empty ${empty.score}`);
});

test("navigation-only snapshot (pets.com homepage ~950 chars) is thin", () => {
  const r = scoreSnapshot(base({ pagesWithText: 1, textChars: 950 }));
  assert.equal(r.verdict, "thin");
  assert.ok(r.reason.includes("no room"));
});

test("pickBestSnapshot chooses the richest, not the most recent", () => {
  const snaps: SnapshotMetrics[] = [
    base({ timestamp: "20160315152000", pagesWithText: 2, textChars: 1200, domain: "pets.com", title: "Pets.com" }),
    base({ timestamp: "20040121214835", pagesWithText: 8, textChars: 7000, domain: "pets.com", title: "Pets.com" }),
  ];
  const best = pickBestSnapshot(snaps);
  assert.equal("timestamp" in best ? best.timestamp : "", "20040121214835");
});
