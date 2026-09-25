import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INDEX_INSPECT, INSPECTION_DAILY_LIMIT, INSPECTION_PER_MINUTE, INSPECTION_TZ,
} from "./types";

test("the default auto budget leaves room for manual inspections", () => {
  assert.ok(DEFAULT_INDEX_INSPECT.dailyBudget < INSPECTION_DAILY_LIMIT);
});

test("we stay at or below Google's per-minute inspection limit", () => {
  assert.ok(INSPECTION_PER_MINUTE <= 600);
});

test("the quota day resets at midnight Pacific", () => {
  assert.equal(INSPECTION_TZ, "America/Los_Angeles");
});
