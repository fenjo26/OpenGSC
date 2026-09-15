// SERP Monitor UI — styles and small building blocks shared by the project list, the project
// page and its three tabs. Pure presentation plus fetch/date helpers; no server imports, no
// hooks — everything here is safe to call from any client component.

import type { CSSProperties, ReactNode } from "react";

/** The i18n shape every serpmon component wants: keys arrive as strings (problem codes are
 *  appended at runtime), so each component narrows `t` once through this adapter. */
export type Tr = (k: string) => string;

export const trOf = (t: (k: never) => string): Tr => (k: string) => t(k as never) as string;

// ─── Buttons ───────────────────────────────────────────────────────────────────

export const btnPrimary: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 16px", borderRadius: 9,
  border: "none", background: "var(--color-accent-blue)", color: "#fff",
  fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
};

export const btnGhost: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8,
  border: "1px solid var(--color-border)", background: "transparent",
  color: "var(--color-text-secondary)", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
  whiteSpace: "nowrap",
};

export const btnGhostDisabled = (disabled: boolean): CSSProperties =>
  disabled ? { ...btnGhost, opacity: 0.45, cursor: "default" } : btnGhost;

export const btnDanger: CSSProperties = {
  ...btnGhost, color: "var(--color-danger)", borderColor: "var(--color-danger)",
};

export const inputStyle: CSSProperties = {
  padding: "8px 12px", borderRadius: 8, border: "1px solid var(--color-border)",
  background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: 12.5,
  outline: "none", boxSizing: "border-box",
};

export const thStyle: CSSProperties = {
  padding: "9px 12px", fontWeight: 600, whiteSpace: "nowrap", textAlign: "left",
  fontSize: 11.5, color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)",
};

export const tdStyle: CSSProperties = {
  padding: "9px 12px", color: "var(--color-text-secondary)", whiteSpace: "nowrap", fontSize: 12.5,
  borderBottom: "1px solid var(--color-border-soft)",
};

export const tdNum: CSSProperties = { ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" };
export const thNum: CSSProperties = { ...thStyle, textAlign: "right" };

/** A disabled-looking button that is actually clickable is how "nothing happened" reports are
 *  born; the pager uses this instead of the disabled attribute alone. */
export function pagerBtn(disabled: boolean): CSSProperties {
  return {
    border: "1px solid var(--color-border)", borderRadius: 7, background: "transparent",
    color: disabled ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
    padding: "5px 12px", fontSize: 12, cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

// ─── Fetch helpers ─────────────────────────────────────────────────────────────

export interface ApiBody {
  error?: string;
  notMigrated?: boolean;
}

/** GET that returns the parsed body and never throws for HTTP error statuses — the caller
 *  decides what a 4xx means. Network failures still throw. */
export async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, body };
}

/** POST/PUT/DELETE with a JSON body; same contract as getJson. */
export async function sendJson(
  url: string, method: string, payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, body };
}

// ─── Dates and numbers ─────────────────────────────────────────────────────────

/** "Sep 15, 2026" — the repo's chart/table date style. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "Sep 15, 14:05" — run times where the day alone is not enough. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    ", " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Compact relative age ("5m", "3h", "2d") — deliberately language-neutral, the absolute time
 *  always travels in the element's title. Works for future timestamps too (next run). */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  const a = Math.abs(diff);
  const m = Math.floor(a / 60_000);
  const sign = diff < 0 ? "" : "+";
  if (m < 1) return sign + "<1m";
  if (m < 60) return `${sign}${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${sign}${h}h`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${sign}${d}d`;
  return `${sign}${Math.floor(d / 30)}mo`;
}

/** Volatility 0..1 as "0.42"; null → em dash. */
export function fmtVol(v: number | null | undefined): string {
  return v == null ? "—" : v.toFixed(2);
}

/** Percent share (shareHigh 0..1) as "12%". */
export function fmtShare(v: number | null | undefined): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

// ─── Small visual pieces ───────────────────────────────────────────────────────

/** Horizontal 0..1 volatility bar with the number next to it. */
export function VolBar({ v, width = 54 }: { v: number | null; width?: number }) {
  if (v == null) return <span style={{ color: "var(--color-text-tertiary)" }}>—</span>;
  const pct = Math.max(0, Math.min(1, v));
  // Green at calm, red as the SERP churns — the two semantic colours the brief allows.
  const hue = 130 - Math.round(pct * 105); // 130 (green) → 25 (orange/red)
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title={v.toFixed(3)}>
      <span style={{
        display: "inline-block", width, height: 6, borderRadius: 3,
        background: "var(--color-border-soft)", overflow: "hidden", flexShrink: 0,
      }}>
        <span style={{
          display: "block", width: `${Math.round(pct * 100)}%`, height: "100%",
          background: `hsl(${hue} 70% 45%)`, borderRadius: 3,
        }} />
      </span>
      <span style={{ fontSize: 11.5, fontVariantNumeric: "tabular-nums", color: "var(--color-text-secondary)" }}>
        {v.toFixed(2)}
      </span>
    </span>
  );
}

/** Snapshot status word (OK / Partial / Failed) with its problem code as the tooltip. */
export function StatusChip({ status, problem, tr }: { status: string; problem?: string | null; tr: Tr }) {
  const map: Record<string, { key: string; color: string }> = {
    ok: { key: "serpmonStatusOk", color: "var(--color-success)" },
    partial: { key: "serpmonStatusPartial", color: "var(--color-accent-orange)" },
    failed: { key: "serpmonStatusFailed", color: "var(--color-danger)" },
  };
  const it = map[status] ?? { key: "", color: "var(--color-text-tertiary)" };
  return (
    <span title={problem ? problemLabel(problem, tr) : undefined}
      style={{ fontSize: 11, fontWeight: 600, color: it.color, whiteSpace: "nowrap" }}>
      {it.key ? tr(it.key) : status}
    </span>
  );
}

/** Problem code → localized sentence; unknown codes show raw (they are stable ids). */
export function problemLabel(problem: string, tr: Tr): string {
  return tr(`serpmonProblem_${problem}`);
}

/** Inline sparkline for a project's volatility series (nulls break the line, like the big
 *  charts). Hand-rolled SVG — at 96×22 a ResponsiveContainer costs more than it is worth,
 *  same trade as DrSparkline. Fixed 0..1 scale so cards are comparable at a glance. */
export function VolSparkline({ series, width = 96, height = 22 }: { series: (number | null)[]; width?: number; height?: number }) {
  const pts = series
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v != null);
  if (pts.length < 2) {
    return <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>—</span>;
  }
  const pad = 2;
  const x = (i: number) => pad + (i / Math.max(1, series.length - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - Math.max(0, Math.min(1, v))) * (height - pad * 2);
  // Consecutive non-null indices form one polyline; a null cuts the line.
  const segments: string[][] = [];
  for (let k = 0; k < pts.length; k++) {
    const pt = `${x(pts[k].i).toFixed(1)},${y(pts[k].v).toFixed(1)}`;
    const prev = k > 0 ? pts[k - 1] : null;
    if (prev && prev.i === pts[k].i - 1 && segments.length) segments[segments.length - 1].push(pt);
    else segments.push([pt]);
  }
  return (
    <svg width={width} height={height} style={{ display: "block" }} aria-hidden>
      {segments.map((s, k) => (
        <polyline key={k} points={s.join(" ")} fill="none"
          stroke="var(--color-accent-blue)" strokeWidth="1.5"
          strokeLinejoin="round" strokeLinecap="round" />
      ))}
    </svg>
  );
}

/** A one-line error/notice strip rendered ABOVE the tables — API failures must be visible,
 *  never a silent empty table. */
export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8,
      border: "1px solid var(--color-danger)", color: "var(--color-danger)",
      fontSize: 12.5, wordBreak: "break-all",
    }}>
      {children}
    </div>
  );
}
