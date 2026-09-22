"use client";

/**
 * Candlestick panes for recharts — shared by the site performance chart, the Bing/Yandex engine
 * views and the dashboard site cards.
 *
 * Layout: one pane per enabled metric, stacked, each with its own Y scale and a colour label, on a
 * shared date axis (like indicator panes under a price chart). Four metrics with four different
 * units cannot share one plot as candles — the old single-plot version squeezed four candles into
 * every slot and nothing said which one was clicks and which was position.
 *
 * Inside a pane each slot holds two bars: the previous period's candle as a faint outlined "ghost"
 * on the left, the current candle on the right. recharts groups two Bars of one category side by
 * side on its own, so the ghost costs no custom layout.
 *
 * Geometry trick: every candle Bar uses a dataKey returning the [low, high] PAIR, so recharts hands
 * the shape the rectangle spanning exactly the wick; open and close are recovered linearly inside it.
 * Position panes use a reversed Y axis (rank 1 on top), which flips which end is `low`.
 */

import { useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ComposedChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import type { CandleRow, MetricCandle, Ohlc } from "@/lib/chartCandles";
import { candleImproved, pctChange, readChartTypePref, type ChartTypePref } from "@/lib/chartCandles";

const noopSubscribe = () => () => {};

/**
 * The Settings → Preferences chart type, hydration-safe: the server (and the first client pass)
 * render "line", then the stored preference takes over without a setState-in-effect round trip.
 */
export function useChartTypePref(): ChartTypePref {
  return useSyncExternalStore(noopSubscribe, readChartTypePref, () => "line");
}
import { useLanguage } from "@/lib/i18n/LanguageProvider";

const GOOD = "#10B981";
const BAD = "#EF4444";
/** Flat candle (doji). Mid grey so it reads on both themes and is clearly "no change", not a gap. */
const FLAT = "#94a3b8";

export type CandleMetricKind = "count" | "pct" | "pos";

export interface CandlePaneMetric {
  key: string;
  label: string;
  color: string;
  kind: CandleMetricKind;
}

function fmtValue(kind: CandleMetricKind, v: number, compact = false): string {
  if (kind === "pct") return `${v.toFixed(2)}%`;
  if (kind === "pos") return v.toFixed(1);
  if (compact && Math.abs(v) >= 1000) return `${(v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k`;
  return Math.round(v).toLocaleString();
}

function fmtTick(kind: CandleMetricKind, v: number): string {
  if (kind === "pct") return `${+v.toFixed(1)}%`;
  if (kind === "pos") return String(+v.toFixed(1));
  return fmtValue(kind, v, true);
}

type RowLike = Partial<Record<string, unknown>> | undefined;

function wickKey(field: string) {
  return (row: RowLike) => {
    const c = row?.[field] as MetricCandle | undefined;
    return c ? [c.low, c.high] : null;
  };
}

function ghostKey(field: string) {
  return (row: RowLike) => {
    const p = (row?.[field] as MetricCandle | undefined)?.prev;
    return p ? [p.low, p.high] : null;
  };
}

interface ShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: CandleRow;
}

/** Pixel Y of `v` inside the wick rectangle recharts gave us. */
function yMapper(c: Ohlc, y: number, height: number, flip: boolean) {
  const top = Math.min(y, y + height);
  const h = Math.abs(height);
  const span = c.high - c.low;
  return (v: number) => (span === 0 ? top : flip ? top + ((v - c.low) / span) * h : top + ((c.high - v) / span) * h);
}

function CandleShape({ x = 0, y = 0, width = 0, height = 0, payload, field, invert }: ShapeProps & { field: string; invert: boolean }) {
  const c = payload?.[field] as MetricCandle | undefined;
  if (!c) return null;
  const yOf = yMapper(c, y, height, invert);
  const cx = x + width / 2;
  const flat = c.open === c.close;
  const color = flat ? FLAT : candleImproved(invert, c.open, c.close) ? GOOD : BAD;
  const yO = yOf(c.open);
  const yC = yOf(c.close);
  const bodyTop = Math.min(yO, yC);
  const bodyBot = Math.max(yO, yC);
  const wickTop = Math.min(yOf(c.low), yOf(c.high));
  const wickBot = Math.max(yOf(c.low), yOf(c.high));
  return (
    <g>
      {(wickTop < bodyTop - 0.5 || wickBot > bodyBot + 0.5) && (
        <line x1={cx} x2={cx} y1={wickTop} y2={wickBot} stroke={color} strokeWidth={1.5} />
      )}
      {flat ? (
        // Doji: a day that did not move still gets a solid, full-width bar — not a hairline.
        <rect x={x} y={yO - 1.5} width={width} height={3} rx={1} fill={color} />
      ) : (
        <rect x={x} y={bodyTop} width={width} height={Math.max(2, bodyBot - bodyTop)} rx={1.5} fill={color} />
      )}
    </g>
  );
}

function GhostShape({ x = 0, y = 0, width = 0, height = 0, payload, field, invert, color }: ShapeProps & { field: string; invert: boolean; color: string }) {
  const p = (payload?.[field] as MetricCandle | undefined)?.prev;
  if (!p) return null;
  const yOf = yMapper(p, y, height, invert);
  const w = Math.max(3, width * 0.8);
  const gx = x + width - w; // hug the current candle on the right
  const cx = gx + w / 2;
  const yO = yOf(p.open);
  const yC = yOf(p.close);
  const top = Math.min(yO, yC);
  const bot = Math.max(yO, yC);
  const wickTop = Math.min(yOf(p.low), yOf(p.high));
  const wickBot = Math.max(yOf(p.low), yOf(p.high));
  return (
    <g opacity={0.55}>
      {(wickTop < top - 0.5 || wickBot > bot + 0.5) && <line x1={cx} x2={cx} y1={wickTop} y2={wickBot} stroke={color} strokeWidth={1} />}
      {p.open === p.close ? (
        <rect x={gx} y={yO - 1} width={w} height={2} fill={color} />
      ) : (
        <rect x={gx + 0.5} y={top} width={w - 1} height={Math.max(2, bot - top)} rx={1} fill={color} fillOpacity={0.15} stroke={color} strokeWidth={1} strokeDasharray="3 2" />
      )}
    </g>
  );
}

// ─── Hover card ───────────────────────────────────────────────────────────────

function parseIso(iso: string | undefined): Date | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}

function rowHeading(row: CandleRow, locale: string, weekWord: string): string {
  const from = parseIso(row.fromIso);
  const to = parseIso(row.toIso);
  if (!from || !to) return row.date;
  try {
    if (row.gran === "day") {
      return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(to);
    }
    if (row.gran === "month") {
      return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(to);
    }
    const f = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }) as Intl.DateTimeFormat & { formatRange?: (a: Date, b: Date) => string };
    const range = f.formatRange ? f.formatRange(from, to) : `${f.format(from)} – ${f.format(to)}`;
    return `${range} · ${weekWord}`;
  } catch {
    return row.date;
  }
}

function capitalize(s: string): string {
  return s ? s[0].toLocaleUpperCase() + s.slice(1) : s;
}

function deltaText(kind: CandleMetricKind, from: number, to: number, ppWord: string): string | null {
  const d = to - from;
  if (d === 0) return "0";
  const sign = d > 0 ? "+" : "−";
  if (kind === "pos") return `${sign}${Math.abs(d).toFixed(1)}`;
  if (kind === "pct") return `${sign}${Math.abs(d).toFixed(2)} ${ppWord}`;
  const p = pctChange(from, to);
  return p == null ? `${sign}${Math.abs(Math.round(d)).toLocaleString()}` : `${sign}${Math.abs(p).toFixed(0)}%`;
}

function HoverCard({ row, metrics, showPrev }: { row: CandleRow; metrics: CandlePaneMetric[]; showPrev: boolean }) {
  const { t, language } = useLanguage() as unknown as { t: (k: string) => string; language: string };
  const muted = "var(--color-text-secondary)";
  return (
    <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "10px 12px", fontSize: "12px", color: "var(--color-text-primary)", boxShadow: "0 4px 20px rgba(0,0,0,0.25)", minWidth: "230px" }}>
      <div style={{ fontWeight: 600, marginBottom: "8px" }}>{capitalize(rowHeading(row, language || "en", t("candleWeek")))}</div>
      {metrics.map(m => {
        const c = row[m.key] as MetricCandle | undefined;
        if (!c) return null;
        const invert = m.kind === "pos";
        const flat = c.open === c.close;
        const color = flat ? muted : candleImproved(invert, c.open, c.close) ? GOOD : BAD;
        const delta = c.chained ? deltaText(m.kind, c.open, c.close, t("candlePp")) : null;
        const details: string[] = [];
        if (c.chained) details.push(`${row.gran === "day" ? t("candleEve") : t("candleStart")} ${fmtValue(m.kind, c.open)}`);
        if (row.gran !== "day") details.push(`${t("candleMin")} ${fmtValue(m.kind, c.low)} · ${t("candleMax")} ${fmtValue(m.kind, c.high)}`);
        let prevLine: ReactNode = null;
        if (showPrev) {
          const pv = c.prev?.close;
          const pd = pv != null ? deltaText(m.kind, pv, c.close, t("candlePp")) : null;
          const pColor = pv == null || pv === c.close ? muted : candleImproved(invert, pv, c.close) ? GOOD : BAD;
          prevLine = (
            <span>
              {t("candlePrevPeriod")} {pv == null ? "—" : fmtValue(m.kind, pv)}
              {pd && pd !== "0" && <span style={{ color: pColor, marginLeft: 4 }}>({pd})</span>}
            </span>
          );
        }
        return (
          <div key={m.key} style={{ marginBottom: "6px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: m.color, flexShrink: 0, display: "inline-block" }} />
              <span style={{ color: muted, flex: 1 }}>{m.label}</span>
              <span style={{ fontWeight: 700 }}>{fmtValue(m.kind, c.close)}</span>
              {delta && <span style={{ fontWeight: 600, color, minWidth: "46px", textAlign: "right" }}>{flat ? "=" : delta}</span>}
            </div>
            {(details.length > 0 || prevLine) && (
              <div style={{ paddingLeft: "14px", fontSize: "11px", color: muted, display: "flex", flexWrap: "wrap", columnGap: "8px" }}>
                {details.map(d => <span key={d}>{d}</span>)}
                {prevLine}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 1 / 2 / 2.5 / 5 × 10ⁿ — the step a person would pick for an axis. */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}

/**
 * Y scale for one pane: every candle (and ghost) fits with headroom, so a candle at the period's
 * extreme is not cut by the pane edge, with tick labels on round numbers (recharts would label
 * a padded domain 17 / 13 / 203).
 */
function paneScale(rows: CandleRow[], key: string, withPrev: boolean, kind: CandleMetricKind): { domain: [number, number]; ticks: number[] } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) {
    const c = r[key] as MetricCandle | undefined;
    if (!c) continue;
    lo = Math.min(lo, c.low);
    hi = Math.max(hi, c.high);
    if (withPrev && c.prev) {
      lo = Math.min(lo, c.prev.low);
      hi = Math.max(hi, c.prev.high);
    }
  }
  if (!Number.isFinite(lo)) return { domain: [0, 1], ticks: [0, 1] };
  const pad = hi > lo ? (hi - lo) * 0.12 : Math.max(Math.abs(hi) * 0.1, kind === "count" ? 1 : 0.1);
  const floor = kind === "pos" ? 1 : 0;
  lo = Math.max(floor, lo - pad);
  hi = hi + pad;
  // The domain stays tight (candles keep their height); only the labels snap to round values
  // that fall inside it.
  let step = niceStep((hi - lo) / 3);
  if (kind === "count") step = Math.max(1, step);
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(+v.toFixed(6));
  return { domain: [lo, hi], ticks };
}

// ─── Panes ────────────────────────────────────────────────────────────────────

interface CandlePanesProps {
  rows: CandleRow[];
  metrics: CandlePaneMetric[];
  /** Draw the previous period's ghost candles. */
  showPrev: boolean;
  /** Total plot height in px (panes split it). */
  height: number;
  /** Sparkline mode for dashboard cards: no axes, no grid, no pane labels. */
  compact?: boolean;
  /** Extra headroom over the first pane (marker labels). */
  topMargin?: number;
  /** Reference lines/areas (yAxisId "left") per pane; `top` is the first pane (labels go there). */
  renderMarkers?: (top: boolean) => ReactNode;
}

export function CandlePanes({ rows, metrics, showPrev, height, compact = false, topMargin = 6, renderMarkers }: CandlePanesProps) {
  const syncId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ idx: number; x: number; y: number; w: number } | null>(null);
  const shown = useMemo(() => metrics.filter(m => rows.some(r => r[m.key] != null)), [metrics, rows]);
  const hasGhost = showPrev && shown.some(m => rows.some(r => (r[m.key] as MetricCandle | undefined)?.prev));
  // Sparklines skip the ghosts: at ~20px per pane a second candle per slot is noise, not a
  // comparison. The previous period stays in the hover card.
  const drawGhosts = hasGhost && !compact;

  if (!shown.length) return <div style={{ height }} />;

  const axisH = compact ? 0 : 22;
  const gap = compact ? 2 : 0;
  const labelH = compact ? 0 : 16;
  const paneH = Math.max(compact ? 16 : 52, Math.floor((height - axisH - (labelH + gap) * shown.length) / shown.length));
  const yW = compact ? 0 : 46;

  const onMove = (e: React.MouseEvent) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r || !hover) return;
    setHover({ ...hover, x: e.clientX - r.left, y: e.clientY - r.top, w: r.width });
  };
  const hoverRow = hover ? rows[hover.idx] : undefined;

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "flex", flexDirection: "column", gap }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {shown.map((m, i) => {
        const last = i === shown.length - 1;
        const first = i === 0;
        const invert = m.kind === "pos";
        const scale = paneScale(rows, m.key, drawGhosts, m.kind);
        const head = (first ? topMargin : 0) + labelH;
        const h = paneH + (last ? axisH : 0) + head;
        return (
          <div key={m.key} style={{ position: "relative", height: h, borderTop: !compact && !first ? "1px dashed var(--color-border)" : undefined }}>
            {compact ? (
              <span style={{ position: "absolute", zIndex: 1, left: 0, top: (first ? topMargin : 0) + 2, bottom: last ? axisH + 2 : 2, width: 2, borderRadius: 1, background: m.color, opacity: 0.8 }} />
            ) : (
              <span style={{ position: "absolute", left: yW + 2, top: head - labelH + 2, zIndex: 1, pointerEvents: "none", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: m.color, background: "var(--color-card)", borderRadius: 6, padding: "1px 6px 1px 4px", opacity: 0.95 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: m.color }} />
                {m.label}
              </span>
            )}
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={rows}
                syncId={syncId}
                margin={{ top: head + (compact ? 1 : 4), right: compact ? 0 : 4, left: compact ? 4 : 0, bottom: compact ? 1 : 2 }}
                barCategoryGap={compact ? "14%" : "22%"}
                barGap={compact ? 1 : 2}
                onMouseMove={(s: { activeTooltipIndex?: number | string | null }) => {
                  const idx = Number(s?.activeTooltipIndex);
                  if (s?.activeTooltipIndex != null && Number.isFinite(idx) && idx !== hover?.idx) setHover(h0 => ({ idx, x: h0?.x ?? 0, y: h0?.y ?? 0, w: h0?.w ?? 0 }));
                }}
              >
                {!compact && <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />}
                <XAxis dataKey="date" hide={compact || !last} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "var(--color-text-secondary)" }} minTickGap={16} />
                <YAxis
                  yAxisId="left"
                  hide={compact}
                  reversed={invert}
                  domain={scale.domain}
                  ticks={scale.ticks}
                  interval={0}
                  width={yW}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }}
                  tickFormatter={(v: number) => fmtTick(m.kind, v)}
                />
                <Tooltip content={() => null} cursor={{ fill: "rgba(127,127,127,0.10)" }} isAnimationActive={false} />
                {drawGhosts && (
                  <Bar yAxisId="left" dataKey={ghostKey(m.key)} maxBarSize={compact ? 10 : 30} isAnimationActive={false} legendType="none"
                    shape={(p: unknown) => <GhostShape {...(p as ShapeProps)} field={m.key} invert={invert} color={m.color} />} />
                )}
                <Bar yAxisId="left" dataKey={wickKey(m.key)} maxBarSize={compact ? 12 : 38} isAnimationActive={false} legendType="none"
                  shape={(p: unknown) => <CandleShape {...(p as ShapeProps)} field={m.key} invert={invert} />} />
                {renderMarkers?.(first)}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        );
      })}
      {hover && hoverRow && (
        <div style={{
          position: "absolute", zIndex: 300, pointerEvents: "none",
          // Sparkline cards are narrow: drop the card under the chart, centred on the cursor and
          // kept inside the card, instead of beside the cursor where it would leave the card.
          ...(compact
            ? { top: height + 6, left: Math.max(0, Math.min(hover.x - 120, hover.w - 240)) }
            : { top: Math.max(0, Math.min(hover.y + 12, height - 60)),
                ...(hover.x > hover.w / 2 ? { right: Math.max(0, hover.w - hover.x + 14) } : { left: hover.x + 14 }) }),
        }}>
          <HoverCard row={hoverRow} metrics={shown} showPrev={hasGhost} />
        </div>
      )}
    </div>
  );
}
