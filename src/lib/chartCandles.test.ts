import assert from "node:assert/strict";
import test from "node:test";
import {
  candleBucketSize, candleRanges, candleImproved, ohlcOver, buildCandleRows, readChartTypePref,
} from "./chartCandles";

test("bucket size targets ~40 candles and never drops to a 1-day dash", () => {
  assert.equal(candleBucketSize(0), 1);
  assert.equal(candleBucketSize(1), 2);   // still 2: a 1-day candle has no range
  assert.equal(candleBucketSize(7), 2);   // 4 candles over a week
  assert.equal(candleBucketSize(28), 2);  // 14 candles over 28d
  assert.equal(candleBucketSize(90), 3);  // 30 candles over 3m
  assert.equal(candleBucketSize(365), 10);
  assert.equal(candleBucketSize(480), 12);
});

test("ranges cover every row exactly once, last bucket short", () => {
  assert.deepEqual(candleRanges(7), [[0, 2], [2, 4], [4, 6], [6, 7]]);
  assert.deepEqual(candleRanges(0), []);
  const flat = candleRanges(90).flat();
  assert.equal(Math.min(...flat), 0);
  assert.equal(Math.max(...flat), 90);
});

test("improvement direction inverts for position", () => {
  assert.equal(candleImproved(false, 10, 15), true);   // clicks up = good
  assert.equal(candleImproved(false, 15, 10), false);
  assert.equal(candleImproved(true, 15, 10), true);    // position down = good
  assert.equal(candleImproved(true, 10, 15), false);
});

test("ohlcOver: open is first valid, close is last valid, wick is min/max", () => {
  const rows = [
    { v: 5 },
    { v: null as number | null },  // missing day inside the bucket is skipped, not zero
    { v: 9 },
    { v: 7 },
  ];
  assert.deepEqual(ohlcOver(rows, r => r.v), { open: 5, high: 9, low: 5, close: 7 });
  assert.equal(ohlcOver([{ v: 0 }, { v: 0 }], r => (r.v > 0 ? r.v : null)), null); // all-missing bucket
});

interface Day { date: string; dateIso: string; clicks: number; clicksC: number; position: number }

test("buildCandleRows keeps buckets aligned across metrics and labels on the bucket's last day", () => {
  const days: Day[] = Array.from({ length: 6 }, (_, i) => ({
    date: `d${i + 1}`,
    dateIso: `2026-09-0${i + 1}`,
    clicks: i + 1,                       // 1..6
    clicksC: i === 5 ? 100 : 0,          // prev data only on the last day
    position: i < 4 ? 20 - i : 0,        // 20..17, then two missing days
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
  assert.equal(rows.length, 3); // bucket size 2 over 6 days
  // First bucket: days 1-2 → clicks 1→2, position 20→19.
  assert.deepEqual(rows[0].clicks, { open: 1, high: 2, low: 1, close: 2, prevClose: null });
  assert.deepEqual(rows[0].position, { open: 20, high: 20, low: 19, close: 19, prevClose: null });
  assert.equal(rows[0].date, "d2");
  assert.equal(rows[0].dateIso, "2026-09-02");
  // Third bucket: position has no valid days → no candle at all; clicks carries prevClose.
  assert.equal(rows[2].position, undefined);
  assert.deepEqual(rows[2].clicks, { open: 5, high: 6, low: 5, close: 6, prevClose: 100 });
});

test("readChartTypePref defaults to line and only accepts candle as the override", () => {
  assert.equal(readChartTypePref(), "line"); // no window in unit tests / no stored value
});
