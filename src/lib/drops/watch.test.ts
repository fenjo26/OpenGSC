import { test } from "node:test";
import assert from "node:assert/strict";
import { nextWatchCheckMin, watchAcceleration, WATCH_STAGES } from "./watch";

test("nextWatchCheckMin: registry lifecycle statuses override the row interval", () => {
  assert.equal(nextWatchCheckMin(1440, ["ok", "pendingDelete"]), 15);
  assert.equal(nextWatchCheckMin(60, "redemptionPeriod"), 60);
  // The override wins even when the row was configured tighter than the acceleration.
  assert.equal(nextWatchCheckMin(30, ["pendingDelete"]), 15);
});

test("nextWatchCheckMin: no lifecycle status means the row's own interval", () => {
  assert.equal(nextWatchCheckMin(720, ["clientUpdateProhibited"]), 720);
  assert.equal(nextWatchCheckMin(720, null), 720);
  assert.equal(nextWatchCheckMin(720, []), 720);
});

test("nextWatchCheckMin: missing or bogus interval falls back to the daily default", () => {
  assert.equal(nextWatchCheckMin(null, null), 1440);
  assert.equal(nextWatchCheckMin(0, []), 1440);
  assert.equal(nextWatchCheckMin(-5, undefined), 1440);
});

test("nextWatchCheckMin: clamps an explicit interval into [15 min, 7 days]", () => {
  assert.equal(nextWatchCheckMin(5, []), 15);
  assert.equal(nextWatchCheckMin(60 * 24 * 30, []), 7 * 24 * 60);
  // 1440.6 rounds rather than truncates — a fractional interval is a configured value, not junk.
  assert.equal(nextWatchCheckMin(1440.6, []), 1441);
});

test("watchAcceleration: names the lifecycle stage behind an interval override", () => {
  assert.equal(watchAcceleration(["pendingDelete"]), "pending_delete");
  assert.equal(watchAcceleration("redemptionPeriod"), "redemption");
  assert.equal(watchAcceleration(["clientHold"]), null);
  assert.equal(watchAcceleration(null), null);
});

test("WATCH_STAGES: a corroborated-free row is unwatched, so available never leaks in from the catalogue", () => {
  // `available` is a watch stage only for rows the watch itself left there (uncorroborated
  // frees awaiting their re-check); the watch-off flag is what separates them.
  assert.ok(WATCH_STAGES.includes("available"));
  assert.ok(WATCH_STAGES.includes("taken"));
  assert.ok(!WATCH_STAGES.includes("ingested" as never));
});
