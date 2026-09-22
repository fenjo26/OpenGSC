import assert from "node:assert/strict";
import test from "node:test";
import {
  candleGranularity, candleRanges, candleImproved, ohlcChain, buildCandleRows, readChartTypePref, pctChange,
} from "./chartCandles";

test("granularity: daily up to ~6 weeks, weekly to ~6 months, monthly beyond", () => {
  assert.equal(candleGranularity(7), "day");
  assert.equal(candleGranularity(28), "day");
  assert.equal(candleGranularity(45), "day");
  assert.equal(candleGranularity(90), "week");
  assert.equal(candleGranularity(180), "week");
  assert.equal(candleGranularity(365), "month");
});

test("daily ranges are one row each", () => {
  assert.deepEqual(candleRanges(["2026-09-01", "2026-09-02", "2026-09-03"], "day"), [[0, 1], [1, 2], [2, 3]]);
  assert.deepEqual(candleRanges([], "week"), []);
});

test("weekly ranges follow Monday-start calendar weeks", () => {
  // 2026-09-02 is a Wednesday; 2026-09-07 is the next Monday.
  const isos = Array.from({ length: 10 }, (_, i) => `2026-09-${String(i + 2).padStart(2, "0")}`);
  assert.deepEqual(candleRanges(isos, "week"), [[0, 5], [5, 10]]);
});

test("monthly ranges follow calendar months; non-ISO dates fall back to fixed groups", () => {
  assert.deepEqual(candleRanges(["2026-08-30", "2026-08-31", "2026-09-01"], "month"), [[0, 2], [2, 3]]);
  assert.deepEqual(candleRanges(Array(16).fill("Sep 1"), "week"), [[0, 7], [7, 14], [14, 16]]);
});

test("improvement direction inverts for position", () => {
  assert.equal(candleImproved(false, 10, 15), true);
  assert.equal(candleImproved(false, 15, 10), false);
  assert.equal(candleImproved(true, 15, 10), true);
  assert.equal(candleImproved(true, 10, 15), false);
});

test("ohlcChain: each candle opens at the previous close; gaps do not break the chain", () => {
  const out = ohlcChain([5, 9, null, 7], [[0, 1], [1, 2], [2, 3], [3, 4]]);
  assert.deepEqual(out[0], { open: 5, close: 5, high: 5, low: 5, chained: false }); // first = doji
  assert.deepEqual(out[1], { open: 5, close: 9, high: 9, low: 5, chained: true });
  assert.equal(out[2], null);
  assert.deepEqual(out[3], { open: 9, close: 7, high: 9, low: 7, chained: true });
});

test("ohlcChain: bucket wick covers the open and every day inside", () => {
  const out = ohlcChain([10, 4, 12, 8, 6], [[0, 2], [2, 5]]);
  assert.deepEqual(out[1], { open: 4, close: 6, high: 12, low: 4, chained: true });
});

interface Day { date: string; dateIso: string; clicks: number; clicksC: number; position: number }

test("buildCandleRows: daily candles, previous-period ghost, missing metric days", () => {
  const days: Day[] = Array.from({ length: 4 }, (_, i) => ({
    date: `d${i + 1}`,
    dateIso: `2026-09-0${i + 1}`,
    clicks: [19, 9, 9, 12][i],
    clicksC: [0, 5, 7, 7][i],
    position: i < 3 ? 20 - i : 0,
  }));
  const rows = buildCandleRows(
    days,
    [
      { key: "clicks", value: r => r.clicks, prev: r => (r.clicksC > 0 ? r.clicksC : null) },
      { key: "position", value: r => (r.position > 0 ? r.position : null), prev: () => null },
    ],
    r => r.date,
    r => r.dateIso,
  );
  assert.equal(rows.length, 4);
  assert.equal(rows[1].gran, "day");
  assert.equal(rows[1].date, "d2");
  assert.deepEqual(rows[1].clicks, { open: 19, close: 9, high: 19, low: 9, chained: true, prev: { open: 5, close: 5, high: 5, low: 5, chained: false } });
  assert.deepEqual((rows[2].clicks as any).prev, { open: 5, close: 7, high: 7, low: 5, chained: true });
  assert.equal((rows[2].clicks as any).close, (rows[2].clicks as any).open); // flat day = doji
  assert.equal(rows[3].position, undefined);
});

test("pctChange guards a zero base", () => {
  assert.equal(pctChange(0, 5), null);
  assert.equal(Math.round(pctChange(19, 9)!), -53);
});

test("readChartTypePref defaults to line", () => {
  assert.equal(readChartTypePref(), "line");
});
