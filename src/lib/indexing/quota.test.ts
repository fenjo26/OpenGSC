import assert from "node:assert/strict";
import test from "node:test";
import { computeRemaining, indexingTablesMissing } from "./quota";
import { INSPECTION_DAILY_LIMIT } from "./types";

// The Prisma-backed halves (quotaToday / recordInspections / remainingToday) need a database;
// the arithmetic they wrap is pure and pinned here.

test("computeRemaining: the daily limit binds when the auto budget is larger", () => {
  assert.equal(computeRemaining(0, 0, 1800), INSPECTION_DAILY_LIMIT - 0 - (INSPECTION_DAILY_LIMIT - 1800));
  // used=0, auto=0, budget=1800 → min(2000−0, 1800−0) = 1800
  assert.equal(computeRemaining(0, 0, 1800), 1800);
});

test("computeRemaining: the auto budget binds once its own share is spent", () => {
  assert.equal(computeRemaining(1500, 1500, 1800), 300); // property total has room, budget has 300 left
  assert.equal(computeRemaining(1800, 1800, 1800), 0);
  // Manual-only spending eats the property pool but not the auto share.
  assert.equal(computeRemaining(1900, 0, 1800), 100);
});

test("computeRemaining: never negative, even on over-spent counters", () => {
  assert.equal(computeRemaining(2100, 0, 1800), 0); // used above the limit
  assert.equal(computeRemaining(500, 2000, 1800), 0); // auto above its budget
});

test("computeRemaining: an exhausted day is zero regardless of the counters", () => {
  assert.equal(computeRemaining(3, 1, 1800, { exhaustedToday: true }), 0);
});

test("computeRemaining: a custom limit (tests, smaller property tiers) is honoured", () => {
  assert.equal(computeRemaining(10, 0, 100, { limit: 50 }), 40);
});

test("indexingTablesMissing recognises Prisma's missing-table errors", () => {
  assert.equal(indexingTablesMissing({ code: "P2021" }), true);
  assert.equal(indexingTablesMissing(new Error('The table `main.InspectionQuota` does not exist in the current database.')), true);
  assert.equal(indexingTablesMissing(new Error("no such table: IndexCoverageDaily")), true);
  assert.equal(indexingTablesMissing(new Error("record not found")), false);
  assert.equal(indexingTablesMissing(null), false);
});
