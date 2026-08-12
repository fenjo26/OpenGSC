import assert from "node:assert/strict";
import test from "node:test";
import { isCheckpointDue, OUTCOME_DAYS, parseOutcome, summarizeRows } from "./outcomeMath";

const DAY = 86_400_000;

test("window totals weight position by impressions", () => {
  const summary = summarizeRows([
    { clicks: 1, impressions: 10, position: 2 },
    { clicks: 9, impressions: 990, position: 8 },
  ]);
  assert.equal(summary.clicks, 10);
  assert.equal(summary.impressions, 1000);
  // A plain mean would report 5 and make the page look twice as good as it is.
  assert.equal(summary.position, 7.9);
});

test("a window with no impressions reports no position instead of zero", () => {
  const summary = summarizeRows([]);
  assert.deepEqual(summary, { clicks: 0, impressions: 0, position: null });
  assert.equal(summarizeRows([{ clicks: 0, impressions: 0, position: 0 }]).position, null);
});

test("a checkpoint waits for its window to close and for Search Console to catch up", () => {
  const liveAt = new Date("2026-01-01T00:00:00.000Z");
  const at = (days: number) => new Date(liveAt.getTime() + days * DAY);
  assert.equal(isCheckpointDue(liveAt, 7, at(6)), false);
  assert.equal(isCheckpointDue(liveAt, 7, at(7)), false, "the reporting lag has not passed yet");
  assert.equal(isCheckpointDue(liveAt, 7, at(10)), true);
  assert.equal(isCheckpointDue(liveAt, 90, at(80)), false);
  assert.equal(isCheckpointDue(liveAt, 90, at(93)), true);
});

test("outcome parsing tolerates missing, empty and corrupt records", () => {
  for (const value of [null, undefined, "", "{oops", 42]) {
    assert.deepEqual(parseOutcome(value), { baseline: null, checkpoints: [] });
  }
  const record = parseOutcome(JSON.stringify({ baseline: { clicks: 1, impressions: 2, position: 3, from: "a", to: "b" }, checkpoints: [{ day: 7 }] }));
  assert.equal(record.baseline?.clicks, 1);
  assert.equal(record.checkpoints.length, 1);
  assert.deepEqual([...OUTCOME_DAYS], [7, 30, 90]);
});
