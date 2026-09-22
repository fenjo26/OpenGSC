/**
 * Candlestick aggregation for daily performance series.
 *
 * GSC/Bing/Yandex give one number per metric per day, and a candle needs four (open, high, low,
 * close). So candles are always an aggregation: consecutive days are grouped into buckets and the
 * bucket's first valid day is the open, the last is the close, min/max are the wick — exactly how
 * weekly candles compress daily stock prices. A single-day candle has no range and renders as a
 * flat dash, which is why the bucket size never drops below 2.
 *
 * Pure by design: no React, no recharts, so the arithmetic is unit-testable and both the site
 * chart and the engine views share one definition of what a candle is.
 */

export type ChartTypePref = "line" | "candle";

const PREF_KEY = "opengsc:chartType";

export function readChartTypePref(): ChartTypePref {
  if (typeof window === "undefined") return "line";
  try {
    return window.localStorage.getItem(PREF_KEY) === "candle" ? "candle" : "line";
  } catch {
    return "line";
  }
}

export function writeChartTypePref(v: ChartTypePref): void {
  try {
    window.localStorage.setItem(PREF_KEY, v);
  } catch {
    /* private mode / storage disabled — the default line mode still works */
  }
}

/** Days per candle bucket: ~40 candles on screen, never 1 (a 1-day candle is a dash, not a range). */
export function candleBucketSize(n: number): number {
  if (n <= 0) return 1;
  return Math.max(2, Math.ceil(n / 40));
}

/** Bucket boundaries as [start, end) index pairs over `n` daily rows. */
export function candleRanges(n: number): Array<[number, number]> {
  const size = candleBucketSize(n);
  const out: Array<[number, number]> = [];
  for (let start = 0; start < n; start += size) out.push([start, Math.min(start + size, n)]);
  return out;
}

/**
 * Whether a candle closed better than it opened. Every metric except position reads "bigger is
 * better"; position is inverted (a smaller number is a better rank), which is the same inversion
 * the line charts apply by giving position its own reversed axis.
 */
export function candleImproved(invert: boolean, open: number, close: number): boolean {
  return invert ? close < open : close > open;
}

export interface Ohlc {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** OHLC over a bucket of rows. Values the extractor returns as null/undefined are skipped. */
export function ohlcOver<T>(rows: readonly T[], value: (row: T) => number | null | undefined): Ohlc | null {
  let open: number | null = null;
  let close = 0;
  let high = -Infinity;
  let low = Infinity;
  for (const r of rows) {
    const v = value(r);
    if (v == null || !Number.isFinite(v)) continue;
    if (open === null) open = v;
    close = v;
    if (v > high) high = v;
    if (v < low) low = v;
  }
  return open === null ? null : { open, high, low, close };
}

export interface MetricCandle extends Ohlc {
  /** Previous-period value on the bucket's last day — the dashed comparison line over the candles. */
  prevClose: number | null;
}

export interface CandleMetricSpec<T> {
  key: string;
  value: (row: T) => number | null | undefined;
  prev: (row: T) => number | null | undefined;
}

export type CandleRow = { date: string; dateIso: string } & Record<string, MetricCandle | string>;

/**
 * Daily rows → one chart data array. All metrics share the same bucket boundaries (computed once
 * over the row count), so candles of different metrics stay X-aligned on a shared category axis,
 * and every row carries `date`/`dateIso` of its bucket's LAST day so algo-update markers can snap
 * to candle labels the same way they snap to daily labels in line mode.
 */
export function buildCandleRows<T>(
  rows: readonly T[],
  metrics: ReadonlyArray<CandleMetricSpec<T>>,
  label: (row: T) => string,
  dateIso: (row: T) => string,
): CandleRow[] {
  return candleRanges(rows.length).map(([start, end]) => {
    const bucket = rows.slice(start, end);
    const last = bucket[bucket.length - 1];
    const row: CandleRow = { date: label(last), dateIso: dateIso(last) };
    for (const m of metrics) {
      const o = ohlcOver(bucket, m.value);
      if (o) row[m.key] = { ...o, prevClose: m.prev(last) ?? null };
    }
    return row;
  });
}
