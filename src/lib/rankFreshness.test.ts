import { test } from "node:test";
import assert from "node:assert/strict";
import { GSC_SYNC_STALE_MS, lastSuccessState } from "./gscSyncHealth";
import { RANK_SUCCESS_STALE_MS, rankSuccessLabel, rankSuccessState } from "./rankFreshness";

const ZH = { at: "最后查到：{time}（UTC+8）", never: "尚未查到" };
const NOW = Date.parse("2026-10-28T01:14:00.000Z");
const H = 60 * 60 * 1000;

test("keyword yellow line is 72h and does not move the 48h site-card rule", () => {
  assert.equal(RANK_SUCCESS_STALE_MS, 72 * H);
  assert.equal(GSC_SYNC_STALE_MS, 48 * H);
  const ago50 = new Date(NOW - 50 * H);
  assert.equal(rankSuccessState(ago50, NOW), "fresh");
  assert.equal(lastSuccessState(ago50, NOW), "stale");
});

test("fresh under 72h is not yellow, including exactly 72h", () => {
  const ago50 = new Date(NOW - 50 * H);
  assert.equal(rankSuccessState(ago50, NOW), "fresh");
  assert.equal(rankSuccessState(new Date(NOW - RANK_SUCCESS_STALE_MS), NOW), "fresh");
  // 2026-10-28 01:14 UTC minus 50h is 2026-10-25 23:14 UTC → 10-26 07:14 in UTC+8.
  const label = rankSuccessLabel(ago50, ZH, NOW);
  assert.equal(label.state, "fresh");
  assert.equal(label.text, "最后查到：10-26 07:14（UTC+8）");
});

test("older than 72h is yellow", () => {
  const at = new Date(NOW - RANK_SUCCESS_STALE_MS - 1);
  assert.equal(rankSuccessState(at, NOW), "stale");
  const label = rankSuccessLabel(at, ZH, NOW);
  assert.equal(label.state, "stale");
  assert.match(label.text, /^最后查到：\d{2}-\d{2} \d{2}:\d{2}（UTC\+8）$/);
});

test("a completed not-found check uses the last-checked label", () => {
  const label = rankSuccessLabel(new Date("2026-10-28T01:14:00.000Z"), {
    at: "最后检查：{time}（UTC+8）",
    never: "尚未查到",
  }, NOW);
  assert.equal(label.text, "最后检查：10-28 09:14（UTC+8）");
});

test("no successful check is 尚未查到", () => {
  for (const at of [null, undefined, ""]) {
    const label = rankSuccessLabel(at, ZH, NOW);
    assert.equal(label.state, "never");
    assert.equal(label.text, "尚未查到");
  }
  assert.equal(rankSuccessState("not-a-date", NOW), "never");
});
