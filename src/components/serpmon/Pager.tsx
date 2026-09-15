"use client";

// Shared pager for the serpmon tables: prev/next, a jump-to-page input and a page-size select.
// The jump input remounts on page change (key={page}) instead of syncing state in an effect —
// the value is always the real page, and typing a number + Enter/blur lands on it, clamped.

import { pagerBtn } from "./shared";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { trOf } from "./shared";

export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

export function Pager({ page, pageSize, total, onPage, onPageSize, extra }: {
  page: number;                          // 0-based
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
  /** Anything to render on the left (e.g. the "{shown} of {total}" counter). */
  extra?: React.ReactNode;
}) {
  const { t } = useLanguage();
  const tr = trOf(t);
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  const jumpTo = (el: HTMLInputElement) => {
    const n = parseInt(el.value, 10);
    if (Number.isFinite(n)) onPage(Math.min(Math.max(n - 1, 0), lastPage));
  };
  const inputStyle: React.CSSProperties = {
    width: 46, textAlign: "center", padding: "3px 4px", borderRadius: 6,
    border: "1px solid var(--color-border)", background: "var(--color-card)",
    color: "var(--color-text-primary)", fontSize: 12,
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {extra}
      <button onClick={() => onPage(page - 1)} disabled={page === 0} style={pagerBtn(page === 0)}>
        ← {tr("serpmonPrev")}
      </button>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}
        title={tr("serpmonPageOf").replace("{n}", String(page + 1)).replace("{m}", String(lastPage + 1))}>
        <input key={page} defaultValue={String(page + 1)} aria-label={tr("serpmonPageOf")}
          onBlur={e => jumpTo(e.currentTarget)}
          onKeyDown={e => { if (e.key === "Enter") jumpTo(e.currentTarget); }}
          style={inputStyle} />
        / {lastPage + 1}
      </span>
      <button onClick={() => onPage(page + 1)} disabled={page >= lastPage} style={pagerBtn(page >= lastPage)}>
        {tr("serpmonNext")} →
      </button>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 5, marginLeft: "auto", whiteSpace: "nowrap" }}>
        {tr("serpmonPerPage")}
        <select value={pageSize} onChange={e => onPageSize(Number(e.target.value))}
          style={{
            padding: "3px 6px", borderRadius: 6, border: "1px solid var(--color-border)",
            background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: 12, cursor: "pointer",
          }}>
          {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </div>
  );
}
