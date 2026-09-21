import assert from "node:assert/strict";
import test from "node:test";
import { cronMatches, latestFireAtOrBefore, validateCron } from "./cron";

// 2026-09-21 is a Monday; 2026-09-25 a Friday; 2026-10-13 a Tuesday (the 13th).
const at = (iso: string) => new Date(iso);

test("field syntax: exact, lists, ranges, steps, and a/n running to the field max", () => {
  assert.equal(cronMatches("30 4 * * *", at("2026-09-21T04:30:00Z")), true);
  assert.equal(cronMatches("30 4 * * *", at("2026-09-21T04:31:00Z")), false);
  assert.equal(cronMatches("0,30 * * * *", at("2026-09-21T10:30:00Z")), true);
  assert.equal(cronMatches("0,30 * * * *", at("2026-09-21T10:15:00Z")), false);
  assert.equal(cronMatches("* 9-17 * * *", at("2026-09-21T12:00:00Z")), true);
  assert.equal(cronMatches("* 9-17 * * *", at("2026-09-21T18:00:00Z")), false);
  assert.equal(cronMatches("*/10 * * * *", at("2026-09-21T10:40:00Z")), true);
  assert.equal(cronMatches("*/10 * * * *", at("2026-09-21T10:41:00Z")), false);
  assert.equal(cronMatches("10-50/10 * * * *", at("2026-09-21T10:50:00Z")), true);
  assert.equal(cronMatches("10-50/10 * * * *", at("2026-09-21T10:55:00Z")), false);
  // "5/15" = 5,20,35,50 — from 5 to 59 step 15, not just the single minute 5
  assert.equal(cronMatches("5/15 * * * *", at("2026-09-21T10:20:00Z")), true);
  assert.equal(cronMatches("5/15 * * * *", at("2026-09-21T10:05:00Z")), true);
  assert.equal(cronMatches("5/15 * * * *", at("2026-09-21T10:10:00Z")), false);
});

test("day-of-week: 0 and 7 are both Sunday, month field gates", () => {
  // 2026-09-27 is a Sunday
  assert.equal(cronMatches("0 0 * * 0", at("2026-09-27T00:00:00Z")), true);
  assert.equal(cronMatches("0 0 * * 7", at("2026-09-27T00:00:00Z")), true);
  assert.equal(cronMatches("0 0 * * 1", at("2026-09-27T00:00:00Z")), false);
  assert.equal(cronMatches("0 0 27 9 *", at("2026-09-27T00:00:00Z")), true);
  assert.equal(cronMatches("0 0 27 10 *", at("2026-09-27T00:00:00Z")), false);
});

test("dom/dow OR rule: both restricted means either matches; one restricted means AND", () => {
  // "0 0 13 * 5": the 13th of any month OR any Friday
  assert.equal(cronMatches("0 0 13 * 5", at("2026-10-13T00:00:00Z")), true); // Tuesday the 13th — dom
  assert.equal(cronMatches("0 0 13 * 5", at("2026-09-25T00:00:00Z")), true); // Friday the 25th — dow
  assert.equal(cronMatches("0 0 13 * 5", at("2026-09-22T00:00:00Z")), false); // Tuesday the 22nd
  // only dow restricted: every minute of Fridays
  assert.equal(cronMatches("* * * * 5", at("2026-09-25T11:32:00Z")), true);
  assert.equal(cronMatches("* * * * 5", at("2026-09-24T11:32:00Z")), false);
});

test("validateCron: field count, garbage tokens, out-of-range values", () => {
  assert.equal(validateCron("0 3 */2 * *"), null);
  assert.match(validateCron("* * *")!, /got 3/);
  assert.match(validateCron("a * * * *")!, /cannot parse/);
  assert.match(validateCron("60 * * * *")!, /out of range/);
  assert.match(validateCron("* 24 * * *")!, /out of range/);
  assert.match(validateCron("* * 0 * *")!, /out of range/);
  assert.match(validateCron("* * * * 8")!, /out of range/);
  assert.match(validateCron("*/0 * * * *")!, /step/);
});

test("latestFireAtOrBefore walks back to the newest match inside the cap", () => {
  assert.equal(latestFireAtOrBefore("30 * * * *", at("2026-09-21T14:47:00Z"))?.toISOString(), "2026-09-21T14:30:00.000Z");
  assert.equal(latestFireAtOrBefore("30 * * * *", at("2026-09-21T14:29:00Z"))?.toISOString(), "2026-09-21T13:30:00.000Z");
  // the fire exists but sits outside the scan window (downtime): deliberately not found.
  // 15:30 is 59 minutes before 16:29 — inside a 60-minute cap, outside a 58-minute one.
  assert.equal(latestFireAtOrBefore("30 * * * *", at("2026-09-21T16:29:00Z"), 58), null);
  assert.equal(latestFireAtOrBefore("30 * * * *", at("2026-09-21T16:29:00Z"), 60)?.toISOString(), "2026-09-21T15:30:00.000Z");
  // a daily expression caught shortly after its fire
  assert.equal(latestFireAtOrBefore("0 3 * * *", at("2026-09-21T03:07:00Z"))?.toISOString(), "2026-09-21T03:00:00.000Z");
  // an every-minute expression finds the floored "now" itself
  assert.equal(latestFireAtOrBefore("* * * * *", at("2026-09-21T14:47:33Z"))?.toISOString(), "2026-09-21T14:47:00.000Z");
});
