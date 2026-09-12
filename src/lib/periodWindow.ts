// The GSC window is one concept that three routes (/api/gsc/portfolio, /api/gsc/portfolio-engine,
// /api/gsc/site) each used to speak through a private periodToDays with the same key map — a
// vocabulary drift waiting to happen. One pure module here instead: a period key from
// GSC_PERIODS, plus the optional custom range (?start=&end=) that "custom" resolves to.
// Server-safe: no client imports (the "use client" route trap), no globals — date math only.

export const DAY_MS = 86_400_000;

// Ceiling for a manually-picked range: the widest preset (3y). The presets are the contract —
// custom may reach exactly as far, no tighter cap.
export const MAX_CUSTOM_SPAN_DAYS = 1095;

export function periodToDays(period: string): number {
  const today = new Date();
  const map: Record<string, number> = {
    yesterday:    1,
    "7d":         7,
    "14d":        14,
    "28d":        28,
    last_week:    7,
    this_month:   today.getDate(),
    last_month:   new Date(today.getFullYear(), today.getMonth(), 0).getDate(),
    this_quarter: 90,
    last_quarter: 90,
    ytd:          Math.floor((today.getTime() - new Date(today.getFullYear(), 0, 1).getTime()) / DAY_MS),
    "3m":         90,
    "6m":         180,
    "8m":         240,
    "12m":        365,
    "16m":        480,
    "2y":         730,
    "3y":         1095,
  };
  return map[period] ?? 28;
}

export interface GscWindow {
  start: Date;   // midnight of the first day
  end: Date;     // end-of-day of the last day
  days: number;  // calendar dates in the window — the step a "previous period" sits behind
  startStr?: string; // "YYYY-MM-DD" of the resolved window — set only for custom, for callers
  endStr?: string;   // (engine APIs) that speak calendar strings and must not re-derive them
                     // from local instants (a negative UTC offset shifts an end-of-day Date to
                     // the next calendar day)
}

const isoDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v).getTime());

const midnight  = (d: Date) => { d.setHours(0, 0, 0, 0); return d; };
const endOfDay  = (d: Date) => { d.setHours(23, 59, 59, 999); return d; };
// Local calendar date of an instant, as an exact day-math anchor (both endpoints anchored the
// same way, so timezone offsets cancel in the difference).
const dayAnchor = (d: Date) => new Date(d.toDateString()).getTime();

// GSC 'final' data lags ~2 days, so every window ends there. "custom" without two valid
// dates falls back to the 28-day default like any unknown key — the UI never sends one
// (it applies the range only when both inputs are filled), so this only guards hand-edited URLs.
export function resolveWindow(period: string, startStr?: string | null, endStr?: string | null): GscWindow {
  if (period === "custom" && isoDate(startStr) && isoDate(endStr)) {
    // "T00:00" (no Z) parses as LOCAL midnight — the picked calendar dates must stay those
    // calendar dates in every timezone, unlike bare "YYYY-MM-DD" which parses as UTC.
    const end = endOfDay(new Date(`${endStr}T00:00`));
    const start = midnight(new Date(`${startStr}T00:00`));
    let days = Math.round((new Date(endStr).getTime() - new Date(startStr).getTime()) / DAY_MS) + 1;
    let startStr2 = startStr;
    if (days < 1) { start.setTime(new Date(endStr).getTime()); midnight(start); startStr2 = endStr; days = 1; }
    if (days > MAX_CUSTOM_SPAN_DAYS) {
      // Keep the picked end; an over-long span slides its start forward rather than
      // silently shrinking what was asked for. String math on UTC anchors — no local TZ.
      start.setTime(new Date(endStr).getTime() - (MAX_CUSTOM_SPAN_DAYS - 1) * DAY_MS);
      midnight(start);
      startStr2 = new Date(new Date(endStr).getTime() - (MAX_CUSTOM_SPAN_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
      days = MAX_CUSTOM_SPAN_DAYS;
    }
    return { start, end, days, startStr: startStr2, endStr };
  }

  const end = endOfDay(new Date());
  end.setDate(end.getDate() - 2);
  const days = periodToDays(period);
  const start = midnight(new Date(end));
  start.setDate(end.getDate() - days + 1);
  return { start, end, days };
}

// Child-tab routes that think in days (cluster metrics, branded report, GA4) take a custom
// window as ?days=N — the only part of it those pipelines need. Clamped to the preset
// ceiling; anything invalid (or absent) keeps the route's period-derived default.
export function daysParam(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_CUSTOM_SPAN_DAYS) : null;
}

export type ComparisonMode = "disabled" | "previous" | "yoy" | "prev_month";
export const COMPARISON_MODES: ReadonlySet<string> = new Set<string>([
  "disabled", "previous", "yoy", "prev_month",
]);

// The window a metric is compared against. All modes give a window the same length as the
// current one: "previous" sits immediately before it, "yoy" the same dates a year earlier,
// "prev_month" the same day-of-month one calendar month back. Match Weekdays then slides any
// mode so both windows end on the same weekday — the sparkline overlay pairs day-for-day.
export function previousWindow(w: GscWindow, comparison: string, matchWd: boolean): GscWindow | null {
  if (!COMPARISON_MODES.has(comparison) || comparison === "disabled") return null;

  const end = new Date(w.end);
  const start = new Date(w.start);
  if (comparison === "yoy") {
    end.setFullYear(end.getFullYear() - 1);
    start.setFullYear(start.getFullYear() - 1);
  } else if (comparison === "prev_month") {
    end.setMonth(end.getMonth() - 1);
    start.setMonth(start.getMonth() - 1);
  } else {
    end.setDate(end.getDate() - w.days);
    start.setDate(start.getDate() - w.days);
  }

  if (matchWd) {
    const shift = (w.end.getDay() - end.getDay() + 7) % 7;
    if (shift > 0) {
      end.setDate(end.getDate() + shift);
      start.setDate(start.getDate() + shift);
    }
  }

  const days = Math.round((dayAnchor(end) - dayAnchor(start)) / DAY_MS) + 1;
  return { start: midnight(start), end: endOfDay(end), days };
}

// How many days a current-window date must step back to land on its comparison-window twin —
// the alignment the previous-trend sparkline is drawn with.
export function comparisonShift(current: GscWindow, prev: GscWindow): number {
  return Math.round((dayAnchor(current.start) - dayAnchor(prev.start)) / DAY_MS);
}
