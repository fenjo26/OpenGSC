"use client";

/**
 * Candlestick rendering for recharts: one custom Bar shape + a tooltip, shared by the site
 * performance chart and the engine (Bing/Yandex) views.
 *
 * The trick that makes the geometry possible: each candle Bar uses a dataKey that returns the
 * [low, high] PAIR, so recharts hands the shape the rectangle spanning exactly the wick. Open and
 * close are then recovered linearly inside that rectangle (a linear scale maps any intermediate
 * value proportionally). A reversed axis flips which end of the pair the rectangle starts from,
 * which is why `flipAxis` exists — position candles sit on the same hidden reversed axis as the
 * position line, so rank 1 stays at the top in both modes.
 */

import type { CandleRow, MetricCandle } from "@/lib/chartCandles";
import { candleImproved } from "@/lib/chartCandles";

const GOOD = "#10B981";
const BAD = "#EF4444";
const FLAT = "#6b7280";

/** dataKey for a candle Bar: the [low, high] pair, or null when the metric has no candle there.
 *  Typed loosely on purpose: recharts infers the chart's data generic from dataKey functions, and
 *  a CandleRow-specific signature here would reject the line-mode rows on the same chart. */
export function candleWickDataKey(field: string) {
  return (row: any) => {
    const c = row?.[field] as MetricCandle | undefined;
    return c && c.close != null && c.high != null && c.low != null ? [c.low, c.high] : null;
  };
}

/** dataKey for the dashed previous-period line over candles. */
export function candlePrevDataKey(field: string) {
  return (row: any) => {
    const c = row?.[field] as MetricCandle | undefined;
    return c && c.prevClose != null ? c.prevClose : null;
  };
}

interface CandleBarProps {
  // Injected by recharts (BarShapeProps); typed loosely because the shape is cloned with the
  // full rectangle props and only the geometry matters here.
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: CandleRow;
  /** Row key holding the MetricCandle. */
  field: string;
  /** Position: a smaller close is the good direction. */
  invert?: boolean;
  /** The candle's Y axis is reversed (position): low maps to the top of the rectangle. */
  flipAxis?: boolean;
}

export function CandleBar({ x = 0, y = 0, width = 0, height = 0, payload, field, invert = false, flipAxis = false }: CandleBarProps) {
  const c = payload?.[field] as MetricCandle | undefined;
  if (!c || c.close == null || c.high == null || c.low == null) return null;
  const span = c.high - c.low;
  // Zero-height wick rectangle (flat bucket): every value maps to the rect's own y.
  const yOf = (v: number) => (span === 0 ? y : flipAxis ? y + ((v - c.low!) / span) * height : y + ((c.high! - v) / span) * height);

  const yOpen = yOf(c.open);
  const yClose = yOf(c.close);
  const bodyY = Math.min(yOpen, yClose);
  const bodyH = Math.max(1, Math.abs(yOpen - yClose)); // flat body still shows as a 1px dash
  const cx = x + width / 2;
  const bodyW = Math.max(1, width * 0.6);

  const good = candleImproved(invert, c.open, c.close);
  const color = c.close === c.open ? FLAT : good ? GOOD : BAD;

  return (
    <g>
      <line x1={cx} x2={cx} y1={yOf(c.low!)} y2={yOf(c.high!)} stroke={color} strokeWidth={1} />
      <rect x={cx - bodyW / 2} y={bodyY} width={bodyW} height={bodyH} fill={color} />
    </g>
  );
}

interface CandleTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: CandleRow }>;
  label?: string;
  /** Row key → display colour (the metric's series colour). */
  colors: Record<string, string>;
  /** Row key → localized metric name. */
  metricLabel: (key: string) => string;
  /** Per-metric value formatter (CTR adds %, big numbers get k-notation, position keeps a decimal). */
  format: (key: string, v: number) => string;
  /** Keys to show, in display order. */
  fields: string[];
  /** Which field is position (inverted good direction). */
  invertedField?: string;
  prevLabel: string;
}

export function CandleTooltip({ active, payload, label, colors, metricLabel, format, fields, invertedField, prevLabel }: CandleTooltipProps) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  const rows = fields
    .map(f => ({ f, c: d[f] as MetricCandle | undefined }))
    .filter(({ c }) => c && c.close != null);
  if (!rows.length) return null;
  return (
    <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "10px 14px", fontSize: "12px", color: "var(--color-text-primary)", boxShadow: "0 4px 20px rgba(0,0,0,0.3)", minWidth: "190px" }}>
      <div style={{ fontWeight: 600, marginBottom: "6px" }}>{label}</div>
      {rows.map(({ f, c }) => {
        const good = candleImproved(f === invertedField, c!.open, c!.close);
        const deltaColor = c!.close === c!.open ? FLAT : good ? GOOD : BAD;
        return (
          <div key={f} style={{ marginBottom: "4px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: colors[f], flexShrink: 0, display: "inline-block" }} />
              <span style={{ color: "var(--color-text-secondary)", flex: 1 }}>{metricLabel(f)}</span>
              <span style={{ fontWeight: 600, color: deltaColor }}>
                {format(f, c!.open)} → {format(f, c!.close)}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", fontSize: "11px", color: "var(--color-text-secondary)" }}>
              <span>L {format(f, c!.low!)} · H {format(f, c!.high!)}</span>
              <span>{prevLabel}: {c!.prevClose == null ? "—" : format(f, c!.prevClose)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
