import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_UPTIME_SETTINGS, UPTIME_INTERVALS, UPTIME_OFFLINE_RATIO,
} from "./types";
import { formatDuration } from "../notifyI18n";

test("UPTIME_INTERVALS strictly ascend", () => {
  for (let i = 1; i < UPTIME_INTERVALS.length; i++) {
    assert.ok(UPTIME_INTERVALS[i] > UPTIME_INTERVALS[i - 1], `${UPTIME_INTERVALS[i]} > ${UPTIME_INTERVALS[i - 1]}`);
  }
});

test("DEFAULT_UPTIME_SETTINGS.defaultIntervalMin is one of UPTIME_INTERVALS", () => {
  assert.ok((UPTIME_INTERVALS as readonly number[]).includes(DEFAULT_UPTIME_SETTINGS.defaultIntervalMin));
});

test("UPTIME_OFFLINE_RATIO is in (0, 1]", () => {
  assert.ok(UPTIME_OFFLINE_RATIO > 0 && UPTIME_OFFLINE_RATIO <= 1);
});

test("formatDuration renders the coarsest two units per language", () => {
  assert.equal(formatDuration(45_000, "en"), "45 s");
  assert.equal(formatDuration(12 * 60_000, "en"), "12 min");
  assert.equal(formatDuration((2 * 60 + 5) * 60_000, "en"), "2 h 5 min");
  assert.equal(formatDuration(((3 * 24 + 4) * 60) * 60_000, "en"), "3 d 4 h");
  // The same instants in Russian — the "downtime" line of the recovery alert.
  assert.equal(formatDuration(12 * 60_000, "ru"), "12 мин");
  assert.equal(formatDuration((2 * 60 + 5) * 60_000, "ru"), "2 ч 5 мин");
});
