import assert from "node:assert/strict";
import test from "node:test";
import { flagDrSeries, monthKey, type DrPoint } from "./drHistory";

function series(...drs: number[]): DrPoint[] {
  return drs.map((dr, i) => ({ month: `2026-0${i + 1}`, dr }));
}

test("monthKey renders the UTC month zero-padded", () => {
  assert.equal(monthKey(new Date(Date.UTC(2026, 0, 31))), "2026-01");
  assert.equal(monthKey(new Date(Date.UTC(2026, 10, 5))), "2026-11");
  // A local 1 Feb in a UTC- timezone is still 1 Feb month; a UTC+23:30 wrap is not tested
  // because monthKey only reads UTC fields.
  assert.equal(monthKey(new Date("2026-02-01T00:30:00Z")), "2026-02");
});

test("flag fires on the −5 rule: 22→24→12→11→8 is a filter, not decay", () => {
  const f = flagDrSeries(series(22, 24, 12, 11, 8));
  assert.ok(f);
  assert.equal(f.flagged, true);
  assert.equal(f.drop, -14);
  assert.equal(f.first, 22);
  assert.equal(f.last, 8);
});

test("flag stays quiet on growth, noise, and shallow dips", () => {
  assert.equal(flagDrSeries(series(20, 24, 26))?.flagged, false);
  assert.equal(flagDrSeries(series(20, 24, 22, 25))?.flagged, false);
  // Exactly −5 flags: the veto threshold is inclusive, matching drops_dr_history.
  assert.equal(flagDrSeries(series(20, 15))?.flagged, true);
  // A crash that recovered reads as clean on first-vs-last — say so, do not hide it.
  const f = flagDrSeries(series(20, 8, 22));
  assert.ok(f);
  assert.equal(f.flagged, false);
  assert.equal(f.drop, 2);
});

test("flag returns null below two points — no verdict, not a clean verdict", () => {
  assert.equal(flagDrSeries(undefined), null);
  assert.equal(flagDrSeries([]), null);
  assert.equal(flagDrSeries(series(22)), null);
});
