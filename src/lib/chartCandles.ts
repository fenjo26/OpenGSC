/**
 * Candlestick aggregation for daily performance series.
 *
 * GSC/Bing/Yandex give one number per metric per day, and a candle needs four (open, high, low,
 * close). The candles here follow the convention of markets that trade continuously: a candle
 * OPENS where the previous one CLOSED. So:
 *
 *  - Short periods (≤ 45 days) get one candle per day. Its body runs from the previous day's value
 *    to this day's value: green = the day beat the day before, red = it fell, a flat day is a
 *    doji (a thick horizontal bar). There is no wick — a single daily number has no intraday range.
 *  - Longer periods get calendar weeks (Monday-start) or calendar months. Body = previous bucket's
 *    close → this bucket's last day; the wick is the best and worst day inside the bucket.
 *
 * The first candle has nothing before it, so it opens at its own first value (`chained: false`)
 * and draws as a doji; the tooltip then shows just the value, not a fake change.
 *
 * Pure by design: no React, no recharts, so the arithmetic is unit-testable and every chart that
 * draws candles (site page, Bing/Yandex views, dashboard cards) shares one definition.
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

export type CandleGranularity = "day" | "week" | "month";

/** Daily up to ~6 weeks (≤ 45 candles), weekly up to ~6.5 months (≤ 29), monthly beyond. */
export function candleGranularity(n: number): CandleGranularity {
  if (n <= 45) return "day";
  if (n <= 200) return "week";
  return "month";
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Calendar bucket key of an ISO date, or null when the date is not ISO (demo/fallback rows). */
function bucketKey(iso: string | null | undefined, gran: CandleGranularity): string | null {
  const m = iso ? ISO_RE.exec(iso) : null;
  if (!m) return null;
  if (gran === "day") return m[0];
  if (gran === "month") return `${m[1]}-${m[2]}`;
  // Monday of the ISO week, in UTC so the server's and the viewer's timezone agree.
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/**
 * Bucket boundaries as [start, end) index pairs. Calendar-aligned when every row has an ISO date;
 * otherwise fixed-size groups (7 for weeks, 30 for months) so demo rows still render.
 */
export function candleRanges(isoDates: ReadonlyArray<string | null | undefined>, gran: CandleGranularity): Array<[number, number]> {
  const n = isoDates.length;
  const out: Array<[number, number]> = [];
  if (n === 0) return out;
  if (gran === "day") {
    for (let i = 0; i < n; i++) out.push([i, i + 1]);
    return out;
  }
  const keys = isoDates.map(d => bucketKey(d, gran));
  if (keys.some(k => k === null)) {
    const size = gran === "week" ? 7 : 30;
    for (let s = 0; s < n; s += size) out.push([s, Math.min(s + size, n)]);
    return out;
  }
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || keys[i] !== keys[start]) {
      out.push([start, i]);
      start = i;
    }
  }
  return out;
}

/**
 * Whether a candle closed better than it opened. Every metric except position reads "bigger is
 * better"; position is inverted (a smaller number is a better rank).
 */
export function candleImproved(invert: boolean, open: number, close: number): boolean {
  return invert ? close < open : close > open;
}

export interface Ohlc {
  open: number;
  high: number;
  low: number;
  close: number;
  /** open came from the previous candle's close (false for the very first candle). */
  chained: boolean;
}

/**
 * Chained OHLC over consecutive buckets of one series. A bucket with no valid value yields null
 * and does not break the chain: the next candle opens at the last real close.
 */
export function ohlcChain(values: ReadonlyArray<number | null | undefined>, ranges: ReadonlyArray<[number, number]>): Array<Ohlc | null> {
  let prevClose: number | null = null;
  return ranges.map(([s, e]) => {
    let first: number | null = null;
    let close = 0;
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = s; i < e; i++) {
      const v = values[i];
      if (v == null || !Number.isFinite(v)) continue;
      if (first === null) first = v;
      close = v;
      if (v > hi) hi = v;
      if (v < lo) lo = v;
    }
    if (first === null) return null;
    const chained = prevClose !== null;
    const open: number = prevClose ?? first;
    prevClose = close;
    return { open, close, chained, high: Math.max(hi, open), low: Math.min(lo, open) };
  });
}

export interface MetricCandle extends Ohlc {
  /** The previous period's candle for the same slot — drawn as the ghost next to this one. */
  prev: Ohlc | null;
}

export interface CandleMetricSpec<T> {
  key: string;
  value: (row: T) => number | null | undefined;
  prev: (row: T) => number | null | undefined;
}

export type CandleRow = {
  /** X-axis label: the bucket's LAST day, so algo-update markers snap the same way as daily. */
  date: string;
  dateIso: string;
  fromIso: string;
  toIso: string;
  days: number;
  gran: CandleGranularity;
} & Record<string, MetricCandle | string | number>;

/**
 * Daily rows → one chart data array. All metrics share the same bucket boundaries, so the panes
 * stay X-aligned on a shared category axis.
 */
export function buildCandleRows<T>(
  rows: readonly T[],
  metrics: ReadonlyArray<CandleMetricSpec<T>>,
  label: (row: T) => string,
  dateIso: (row: T) => string,
): CandleRow[] {
  const gran = candleGranularity(rows.length);
  const isos = rows.map(dateIso);
  const ranges = candleRanges(isos, gran);
  const cur = metrics.map(m => ohlcChain(rows.map(m.value), ranges));
  const prv = metrics.map(m => ohlcChain(rows.map(m.prev), ranges));
  return ranges.map(([s, e], bi) => {
    const last = rows[e - 1];
    const row: CandleRow = {
      date: label(last),
      dateIso: isos[e - 1],
      fromIso: isos[s],
      toIso: isos[e - 1],
      days: e - s,
      gran,
    };
    metrics.forEach((m, mi) => {
      const c = cur[mi][bi];
      if (c) row[m.key] = { ...c, prev: prv[mi][bi] };
    });
    return row;
  });
}

/** Signed percent change, or null when there is no base to compare against. */
export function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}
