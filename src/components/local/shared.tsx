// Local SEO UI (N4) — presentation helpers shared by the five tab cards. Pure presentation plus
// a fetch wrapper; no server imports. Mirrors the serpmon shared module's shape so the two read
// alike, but lives here: /local owns its own tokens and must not lean on another feature's files.

import type { CSSProperties } from "react";

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

export const btnDanger: CSSProperties = {
  ...btnGhost, color: "var(--color-danger)", borderColor: "var(--color-danger)",
};

export const btnDisabled = (disabled: boolean): CSSProperties =>
  disabled ? { opacity: 0.45, cursor: "default" } : {};

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

/** Two-column label+control row that still fits 360 px (labels above controls). */
export const fieldLabel: CSSProperties = {
  display: "block", fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)",
  marginBottom: 4, letterSpacing: "0.02em",
};

// ─── Status colours (never the only signal — every pill carries its text) ──────

export const STATUS_COLOR: Record<string, string> = {
  good: "#10B981",
  warn: "#F59E0B",
  bad: "#EF4444",
  mute: "var(--color-text-tertiary)",
};

export function statusPill(text: string, tone: "good" | "warn" | "bad" | "mute"): CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600,
    padding: "2px 9px", borderRadius: 20, whiteSpace: "nowrap",
    color: STATUS_COLOR[tone], background: "color-mix(in srgb, currentColor 10%, transparent)",
    border: `1px solid color-mix(in srgb, currentColor 35%, transparent)`,
  };
}

// ─── fetch ─────────────────────────────────────────────────────────────────────

/** POST/PUT/DELETE JSON; returns { ok, status, data } so callers can show route errors verbatim. */
export async function sendJson(
  url: string, method: "POST" | "PUT" | "DELETE", body?: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, {
      method,
      ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data: data as Record<string, unknown> };
  } catch {
    return { ok: false, status: 0, data: { error: "network_error" } };
  }
}

/** `{field}` / `{n}` placeholders in locale strings — `t()` returns them verbatim by design. */
export const fill = (s: string, vars: Record<string, string>) =>
  s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
