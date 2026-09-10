import assert from "node:assert/strict";
import test from "node:test";
import { parseCdxRows } from "./wayback";

const NOW = new Date(2026, 8, 7); // 2026-09-07 local — gap math compares local midnights, no TZ shift

test("a CDX reply turns into months-lived, first/last and the dead gap", () => {
  const profile = parseCdxRows([
    ["timestamp"],
    ["20120615091200"],
    ["20130701000000"],
    ["20240229120000"],
  ], NOW);
  assert.equal(profile.snapshots, 3);
  assert.deepEqual(
    [profile.firstAt!.getFullYear(), profile.firstAt!.getMonth(), profile.firstAt!.getDate()],
    [2012, 5, 15],
  );
  assert.deepEqual(
    [profile.lastAt!.getFullYear(), profile.lastAt!.getMonth(), profile.lastAt!.getDate()],
    [2024, 1, 29],
  );
  // 2024-02-29 → 2026-09-07 is 921 days. A leap day sits inside the gap on purpose.
  assert.equal(profile.gapDays, 921);
});

test("the gap is whole calendar days, whatever the timezone and DST do", () => {
  // This assertion used to hold at 920 in Europe/Athens and 921 in UTC, because the gap was
  // computed from raw milliseconds: 2024-02-29 is winter time (+02:00), 2026-09-07 is summer
  // (+03:00), the difference is short by an hour, and Math.floor swallowed the day. The same
  // domain therefore looked a day less dead on one server than on another, and gapDays feeds
  // the score a purchase is sorted by.
  const [first] = [new Date(2024, 1, 29)];
  const gap = parseCdxRows([["timestamp"], ["20240229120000"]], new Date(2026, 8, 7)).gapDays;
  assert.equal(gap, 921);
  assert.equal(first.getDate(), 29);

  // Both directions of the DST boundary, in one day steps around the changeover.
  const spring = parseCdxRows([["timestamp"], ["20260328000000"]], new Date(2026, 2, 30)).gapDays;
  assert.equal(spring, 2, "a clock that jumps forward must not eat a day");
  const autumn = parseCdxRows([["timestamp"], ["20261024000000"]], new Date(2026, 9, 26)).gapDays;
  assert.equal(autumn, 2, "a clock that falls back must not invent one");
});

test("shorter timestamps parse: CDX pads to 14 digits but old exports do not", () => {
  const profile = parseCdxRows([["timestamp"], ["2015"], ["201506"]], NOW);
  assert.equal(profile.snapshots, 2);
  assert.equal(profile.firstAt!.getFullYear(), 2015);
  assert.equal(profile.lastAt!.getMonth(), 5);
});

test("a broken or empty reply is 'unknown', never a fabricated verdict", () => {
  for (const bad of [null, undefined, 42, [], [["timestamp"]], [["nonsense"]], [["timestamp"], ["garbage"]]]) {
    const profile = parseCdxRows(bad, NOW);
    assert.deepEqual(profile, { snapshots: 0, firstAt: null, lastAt: null, gapDays: null }, JSON.stringify(bad));
  }
});

test("rows arriving out of order are sorted, not trusted", () => {
  const profile = parseCdxRows([["timestamp"], ["20200101000000"], ["20100101000000"]], NOW);
  assert.equal(profile.firstAt!.getFullYear(), 2010);
  assert.equal(profile.lastAt!.getFullYear(), 2020);
  assert.equal(profile.snapshots, 2);
});

test("a snapshot from today means the domain is not dead at all", () => {
  const profile = parseCdxRows([["timestamp"], ["20260907120000"]], NOW);
  assert.equal(profile.gapDays, 0);
});
