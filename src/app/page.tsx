"use client";

import { useState, useEffect, useMemo, useRef, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Search, Eye, EyeOff, Star, ExternalLink,
  ArrowUpDown, SlidersHorizontal, Sparkles, Percent, MoveUp,
  Globe, Monitor, FileText, ChevronDown, Check,
  Image, Video, Newspaper, Compass,
  Download, Tag, X, Loader2, RefreshCw,
} from "lucide-react";
import { AreaChart, Area, ResponsiveContainer, Tooltip } from "recharts";
import { usePrivacy } from "@/lib/PrivacyContext";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { useHealthStatus } from "@/components/SiteHealthPanel";
import { loadSyncedAt, rememberSyncedAt, fetchSyncState, watchSync, type SyncState } from "@/lib/syncedAt";
import { marketFor } from "@/lib/seo/market";
import { getAhrefsDrKey } from "@/lib/seo/keys";

// ─── Types ────────────────────────────────────────────────────────────────────
type Metric = "clicks" | "impressions" | "ctr" | "position";
type SortBy = "az" | "total" | "growth" | "growth_pct" | "decline" | "decline_imp" | "decline_pos" | "tags";
type Comparison = "disabled" | "previous" | "yoy" | "prev_month" | "custom";
type PeriodView = "day" | "week" | "month";
type SearchType = "web" | "discover" | "news" | "image" | "video";
type BrandedFilter = "all" | "branded" | "nonbranded";

// ─── Metric config ────────────────────────────────────────────────────────────
const MC = {
  clicks:      { color: "#3B82F6", bg: "rgba(59,130,246,0.12)"  },
  impressions: { color: "#8B5CF6", bg: "rgba(139,92,246,0.12)" },
  ctr:         { color: "#10B981", bg: "rgba(16,185,129,0.12)" },
  position:    { color: "#F59E0B", bg: "rgba(245,158,11,0.12)" },
} as const;

// ─── Mock data ────────────────────────────────────────────────────────────────
interface Pt {
  date: string;
  clicks: number; impressions: number; ctr: number; position: number;
  clicksC: number; impressionsC: number; ctrC: number; positionC: number;
  cN: number; iN: number; tN: number; pN: number;
  cCN: number; iCN: number; tCN: number; pCN: number;
}

function norm(arr: number[]): number[] {
  const lo = Math.min(...arr), hi = Math.max(...arr);
  return hi === lo ? arr.map(() => 50) : arr.map(v => Math.round(((v - lo) / (hi - lo)) * 85 + 5));
}

function periodToDays(period: string): number {
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
    ytd:          Math.floor((today.getTime() - new Date(today.getFullYear(), 0, 1).getTime()) / 86400000),
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

function makeSiteData(n = 14, startDate?: Date): { data: Pt[]; summary: Record<Metric, { value: number; change: number }> } {
  let c = 20 + Math.random() * 150,
      im = c * (12 + Math.random() * 25),
      t  = 2 + Math.random() * 12,
      p  = 5 + Math.random() * 35;

  const rc: number[] = [], ri: number[] = [], rt: number[] = [], rp: number[] = [];
  const rcC: number[] = [], riC: number[] = [], rtC: number[] = [], rpC: number[] = [];

  for (let i = 0; i < n; i++) {
    c  = Math.max(1,   c  + (Math.random() - 0.47) * 25);
    im = Math.max(10,  im + (Math.random() - 0.47) * 300);
    t  = Math.max(0.1, Math.min(50, t + (Math.random() - 0.5) * 2));
    p  = Math.max(1,   Math.min(100, p + (Math.random() - 0.5) * 3));
    rc.push(Math.round(c));   ri.push(Math.round(im));
    rt.push(+t.toFixed(1));   rp.push(+p.toFixed(1));
    const f = 0.45 + Math.random() * 0.65;
    rcC.push(Math.round(c * f));  riC.push(Math.round(im * f));
    rtC.push(+(t * f).toFixed(1)); rpC.push(+Math.min(100, p / f).toFixed(1));
  }

  const nC = norm(rc), nI = norm(ri), nT = norm(rt), nP = norm(rp);
  const nCC = norm(rcC), nIC = norm(riC), nTC = norm(rtC), nPC = norm(rpC);

  const base = startDate ? new Date(startDate) : (() => { const d = new Date(); d.setDate(d.getDate() - n); return d; })();

  const data: Pt[] = rc.map((_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: n > 365 ? "numeric" : undefined });
    return {
      date: dateStr,
      clicks: rc[i], impressions: ri[i], ctr: rt[i], position: rp[i],
      clicksC: rcC[i], impressionsC: riC[i], ctrC: rtC[i], positionC: rpC[i],
      cN: nC[i], iN: nI[i], tN: nT[i], pN: nP[i],
      cCN: nCC[i], iCN: nIC[i], tCN: nTC[i], pCN: nPC[i],
    };
  });

  const last = n - 1, mid = Math.floor(n / 2);
  const pct = (a: number, b: number) => b === 0 ? 0 : Math.round(((a - b) / b) * 100);
  return {
    data,
    summary: {
      clicks:      { value: rc[last],  change: pct(rc[last],  rc[mid]) },
      impressions: { value: ri[last],  change: pct(ri[last],  ri[mid]) },
      ctr:         { value: rt[last],  change: pct(rt[last],  rt[mid]) },
      position:    { value: rp[last],  change: pct(rp[last],  rp[mid]) },
    },
  };
}

function fmtK(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }
function fmtVal(m: Metric, v: number) {
  if (m === "ctr") return `${v}%`;
  if (m === "impressions") return fmtK(v);
  return String(v);
}
function pctStr(curr: number, prev: number, invert = false) {
  if (prev === 0) return "";           // no prev data — show nothing
  if (curr === 0 && prev === 0) return "";
  const p = Math.round(((curr - prev) / prev) * 100);
  const up = invert ? p < 0 : p >= 0;
  return `${up ? "↑" : "↓"}${Math.abs(p)}%`;
}

function getDomain(url: string) {
  return url.replace("sc-domain:", "").replace(/^https?:\/\//, "").replace(/\/$/, "");
}

// Deterministic branded ratio per site (0–1) based on URL hash
function brandedRatio(url: string): number {
  let h = 0;
  for (const c of url) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 100) / 100;
}

// ─── Filter chip ──────────────────────────────────────────────────────────────
function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "5px", padding: "3px 10px 3px 12px", borderRadius: "20px", background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.3)", fontSize: "12px", color: "#3B82F6", whiteSpace: "nowrap" }}>
      {label}
      <button onClick={onRemove} style={{ background: "none", border: "none", cursor: "pointer", color: "#60a5fa", padding: "0 0 0 2px", lineHeight: 1, fontSize: "14px", display: "flex", alignItems: "center" }}>×</button>
    </div>
  );
}

// ─── Export helpers ───────────────────────────────────────────────────────────
const EXPORT_COLS = [
  { key: "date",    rows: 7   },
  { key: "page",    rows: 35  },
  { key: "query",   rows: 200 },
  { key: "country", rows: 56  },
  { key: "device",  rows: 3   },
] as const;
type ExportCol = typeof EXPORT_COLS[number]["key"];

function generateCSV(domain: string, cols: Set<ExportCol>): string {
  const dimCols = EXPORT_COLS.filter(c => cols.has(c.key)).map(c => c.key);
  const header = [...dimCols, "Clicks", "Impressions", "CTR", "Avg Position"].join(",");
  const devices = ["MOBILE", "DESKTOP", "TABLET"];
  const countries = ["grc", "usa", "gbr", "deu", "fra"];
  const rows: string[] = [header];
  const today = new Date();
  const n = cols.has("query") ? 200 : cols.has("page") ? 35 : cols.has("country") ? 56 : 7;
  for (let i = 0; i < n; i++) {
    const d = new Date(today); d.setDate(today.getDate() - Math.floor(Math.random() * 90));
    const row: string[] = [];
    if (cols.has("date"))    row.push(`"${d.toISOString().split("T")[0]}"`);
    if (cols.has("page"))    row.push(`"https://${domain}/page-${i+1}/"`);
    if (cols.has("query"))   row.push(`"keyword ${i+1}"`);
    if (cols.has("country")) row.push(`"${countries[i % countries.length]}"`);
    if (cols.has("device"))  row.push(`"${devices[i % devices.length]}"`);
    const clicks = Math.floor(Math.random() * 50);
    const impr   = clicks * (5 + Math.floor(Math.random() * 20));
    const ctr    = impr > 0 ? +((clicks / impr) * 100).toFixed(2) : 0;
    const pos    = +(1 + Math.random() * 50).toFixed(1);
    row.push(String(clicks), String(impr), String(ctr), String(pos));
    rows.push(row.join(","));
  }
  return rows.join("\n");
}

function downloadCSV(domain: string, cols: Set<ExportCol>) {
  const csv  = generateCSV(domain, cols);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = `${domain}_${[...cols].join("_")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Advanced Export Modal ────────────────────────────────────────────────────
function ExportModal({ domain, onClose }: { domain: string; onClose: () => void }) {
  const { t } = useLanguage();
  const [selected, setSelected] = useState<Set<ExportCol>>(new Set());

  const colLabel: Record<ExportCol, string> = {
    date:    t("exportColDate"),
    page:    t("filterPage"),
    query:   t("filterQuery"),
    country: t("filterCountry"),
    device:  t("filterDevice"),
  };

  const toggle = (k: ExportCol) => setSelected(p => {
    const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n;
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: "16px", padding: "28px 32px", maxWidth: "640px", width: "90%", color: "#111", boxShadow: "0 20px 60px rgba(0,0,0,0.4)", border: "2px solid #3B82F6", position: "relative" }}
        onClick={e => e.stopPropagation()}>
        <button onClick={onClose} style={{ position: "absolute", top: "16px", right: "16px", background: "none", border: "none", cursor: "pointer", color: "#888" }}>
          <X size={20} />
        </button>
        <h2 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "8px" }}>{t("advancedExport")}</h2>
        <p style={{ fontSize: "14px", color: "#555", marginBottom: "24px" }}>{t("exportDesc")}</p>

        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", marginBottom: "28px" }}>
          {EXPORT_COLS.map(({ key, rows }) => {
            const active = selected.has(key);
            return (
              <label key={key} style={{ display: "flex", alignItems: "flex-start", gap: "8px", cursor: "pointer" }}>
                <div onClick={() => toggle(key)} style={{
                  width: "18px", height: "18px", borderRadius: "4px", flexShrink: 0, marginTop: "1px",
                  border: `2px solid ${active ? "#3B82F6" : "#d1d5db"}`,
                  background: active ? "#3B82F6" : "#fff",
                  display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
                }}>
                  {active && <Check size={11} color="#fff" strokeWidth={3} />}
                </div>
                <div>
                  <div style={{ fontSize: "14px", fontWeight: 600 }}>{colLabel[key]}</div>
                  <div style={{ fontSize: "12px", color: "#999" }}>{rows} {t("rows")}</div>
                </div>
              </label>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
          <button
            onClick={() => { if (selected.size > 0) { downloadCSV(domain, selected); onClose(); } }}
            style={{
              padding: "10px 22px", borderRadius: "8px", fontSize: "14px", fontWeight: 600, cursor: selected.size > 0 ? "pointer" : "not-allowed",
              background: selected.size > 0 ? "#4b5563" : "#9ca3af", color: "#fff", border: "none",
            }}
          >
            {t("exportToCSV")}
          </button>
          <p style={{ fontSize: "12px", color: "#888", flex: 1 }}>{t("exportWarning")}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────
function ChartTooltip({ active, payload }: any) {
  const { t } = useLanguage();
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload as Pt;
  if (!d) return null;
  const metricLabels: Record<Metric, string> = {
    clicks:      t("clicks"),
    impressions: t("impressions"),
    ctr:         "CTR",
    position:    t("avgPosition"),
  };
  const noPrev = (v: number) => v === 0;
  const prevStr = (v: number, fmt: (n: number) => string) => noPrev(v) ? "—" : fmt(v);
  const rows: { m: Metric; curr: string; prev: string; pct: string }[] = [
    { m: "clicks",      curr: String(d.clicks),    prev: prevStr(d.clicksC,     n => String(n)),          pct: pctStr(d.clicks,      d.clicksC) },
    { m: "impressions", curr: fmtK(d.impressions), prev: prevStr(d.impressionsC, n => fmtK(n)),           pct: pctStr(d.impressions, d.impressionsC) },
    { m: "ctr",         curr: `${d.ctr}%`,         prev: noPrev(d.ctrC) ? "—" : `${d.ctrC}%`,            pct: pctStr(d.ctr,         d.ctrC) },
    { m: "position",    curr: String(d.position),  prev: noPrev(d.positionC) ? "—" : String(d.positionC), pct: pctStr(d.position,    d.positionC, true) },
  ];
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "10px 14px", fontSize: "12px", color: "#111", minWidth: "210px", boxShadow: "0 4px 20px rgba(0,0,0,0.15)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 50px", gap: "2px 8px", marginBottom: "6px", paddingBottom: "6px", borderBottom: "1px solid #e5e7eb", color: "#888", fontSize: "11px" }}>
        <div />
        <div style={{ textAlign: "right", fontWeight: 500 }}>{d.date}</div>
        <div style={{ textAlign: "right", borderBottom: "2px dashed #ccc", paddingBottom: "2px" }}>{t("prev")}</div>
      </div>
      {rows.map(({ m, curr, prev, pct }) => (
        <div key={m} style={{ display: "grid", gridTemplateColumns: "1fr 90px 50px", gap: "2px 8px", marginBottom: "3px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
            <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: MC[m].color, flexShrink: 0, display: "inline-block" }} />
            <span style={{ color: "#555" }}>{metricLabels[m]}</span>
          </div>
          <div style={{ textAlign: "right", fontWeight: 600 }}>
            {curr}
            {pct && <span style={{ fontSize: "10px", marginLeft: "3px", color: pct.startsWith("↑") ? "#10B981" : "#EF4444" }}> {pct}</span>}
          </div>
          <div style={{ textAlign: "right", color: "#999" }}>{prev}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Multi-metric chart ───────────────────────────────────────────────────────
function MultiMetricChart({ data, activeMetrics, prevTrend = true }: { data: Pt[]; activeMetrics: Set<Metric>; prevTrend?: boolean }) {
  const metrics: { m: Metric; nKey: string; cKey: string }[] = [
    { m: "clicks",      nKey: "cN",  cKey: "cCN" },
    { m: "impressions", nKey: "iN",  cKey: "iCN" },
    { m: "ctr",         nKey: "tN",  cKey: "tCN" },
    { m: "position",    nKey: "pN",  cKey: "pCN" },
  ];
  return (
    <ResponsiveContainer width="100%" height={90}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          {metrics.map(({ m }) => (
            <linearGradient key={m} id={`g-${m}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={MC[m].color} stopOpacity={0.2} />
              <stop offset="100%" stopColor={MC[m].color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <Tooltip content={<ChartTooltip />} wrapperStyle={{ zIndex: 300 }} cursor={{ stroke: "#aaa", strokeWidth: 1, strokeDasharray: "3 2" }} />
        {prevTrend && metrics.map(({ m, cKey }) => activeMetrics.has(m) && (
          <Area key={`c-${m}`} type="monotone" dataKey={cKey}
            stroke={MC[m].color} strokeWidth={1} strokeDasharray="4 3"
            fill="none" dot={false} isAnimationActive={false} legendType="none" />
        ))}
        {metrics.map(({ m, nKey }) => activeMetrics.has(m) && (
          <Area key={m} type="monotone" dataKey={nKey}
            stroke={MC[m].color} strokeWidth={1.5}
            fill={`url(#g-${m})`} dot={false} isAnimationActive={false} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── MarketInput — two-letter market editor, mirrors TagInput's isolation ───
function MarketInput({ initialValue, onSave, onCancel, placeholder }: {
  initialValue: string;
  onSave: (v: string) => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  const { t } = useLanguage();
  const [value, setValue] = useState(initialValue);
  const valid = /^[a-z]{2}$/.test(value.trim()) || value.trim() === "";
  return (
    <div style={{ display: "flex", gap: "5px", alignItems: "center" }} onClick={e => e.stopPropagation()}>
      <input
        autoFocus
        value={value}
        maxLength={2}
        onChange={e => setValue(e.target.value.toLowerCase())}
        onKeyDown={e => {
          if (e.key === "Enter" && valid) { e.preventDefault(); onSave(value.trim()); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        placeholder={placeholder || t("siteMarketAuto")}
        style={{
          flex: 1, minWidth: 0, width: "80px", padding: "5px 9px",
          borderRadius: "7px", border: `1.5px solid ${valid ? "var(--color-accent-blue)" : "#ff9f0a"}`,
          background: "var(--color-bg)", color: "var(--color-text-primary)",
          fontSize: "13px", outline: "none", textTransform: "lowercase",
        }}
      />
      <button
        disabled={!valid}
        onClick={e => { e.stopPropagation(); onSave(value.trim()); }}
        style={{ padding: "5px 10px", borderRadius: "7px", border: "none", background: valid ? "var(--color-accent-blue)" : "var(--color-border)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: valid ? "pointer" : "default", flexShrink: 0 }}
      >✓</button>
      <button
        onClick={e => { e.stopPropagation(); onCancel(); }}
        style={{ padding: "5px 8px", borderRadius: "7px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: "13px", cursor: "pointer", flexShrink: 0 }}
      >✕</button>
    </div>
  );
}

// ─── TagInput — isolated component so typing doesn't re-render parent ────────
function TagInput({ initialValue, onSave, onCancel, placeholder }: {
  initialValue: string;
  onSave: (v: string) => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  const { t } = useLanguage();
  const [value, setValue] = useState(initialValue);
  return (
    <div
      style={{ display: "flex", gap: "5px", alignItems: "center" }}
      onClick={e => e.stopPropagation()}
    >
      <input
        autoFocus
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") { e.preventDefault(); onSave(value); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        placeholder={placeholder || t("tagsExample")}
        style={{
          flex: 1, minWidth: 0, padding: "5px 9px",
          borderRadius: "7px", border: "1.5px solid var(--color-accent-blue)",
          background: "var(--color-bg)", color: "var(--color-text-primary)",
          fontSize: "13px", outline: "none",
        }}
      />
      <button
        onClick={e => { e.stopPropagation(); onSave(value); }}
        style={{ padding: "5px 10px", borderRadius: "7px", border: "none", background: "var(--color-accent-blue)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
      >✓</button>
      <button
        onClick={e => { e.stopPropagation(); onCancel(); }}
        style={{ padding: "5px 8px", borderRadius: "7px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: "13px", cursor: "pointer", flexShrink: 0 }}
      >✕</button>
    </div>
  );
}

// ─── CardBtn — icon button with CSS tooltip ───────────────────────────────────
function CardBtn({ children, tooltip, onClick, active, activeColor }: {
  children: React.ReactNode;
  tooltip: string;
  onClick: (e: React.MouseEvent) => void;
  active?: boolean;
  activeColor?: string;
}) {
  return (
    <span style={{ position: "relative", display: "inline-flex" }} className="card-btn-wrap">
      <button
        onClick={onClick}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: "28px", height: "28px", borderRadius: "7px", border: "none",
          background: active ? `${activeColor ?? "var(--color-accent-blue)"}22` : "transparent",
          color: active ? (activeColor ?? "var(--color-accent-blue)") : "var(--color-text-secondary)",
          cursor: "pointer", transition: "background 0.15s, color 0.15s", flexShrink: 0,
        }}
        onMouseEnter={e => {
          if (!active) {
            e.currentTarget.style.background = "var(--color-border-soft)";
            e.currentTarget.style.color = "var(--color-text-primary)";
          }
          // show tooltip
          const tip = e.currentTarget.nextElementSibling as HTMLElement | null;
          if (tip) tip.style.opacity = "1";
        }}
        onMouseLeave={e => {
          if (!active) {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--color-text-secondary)";
          }
          const tip = e.currentTarget.nextElementSibling as HTMLElement | null;
          if (tip) tip.style.opacity = "0";
        }}
      >
        {children}
      </button>
      {/* Tooltip */}
      <span style={{
        position: "absolute", bottom: "calc(100% + 5px)", left: "50%",
        transform: "translateX(-50%)",
        background: "var(--color-text-primary)", color: "var(--color-bg)",
        fontSize: "11px", fontWeight: 500, padding: "4px 8px",
        borderRadius: "6px", whiteSpace: "nowrap",
        pointerEvents: "none", opacity: 0,
        transition: "opacity 0.15s", zIndex: 200,
      }}>
        {tooltip}
      </span>
    </span>
  );
}

// ─── Dropdown ─────────────────────────────────────────────────────────────────
function Dropdown({ trigger, children, align = "left" }: { trigger: React.ReactNode; children: React.ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Clamp panel inside viewport after it renders
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const panel = panelRef.current;
    const rect  = panel.getBoundingClientRect();
    const vw    = window.innerWidth;
    if (rect.right > vw - 8) {
      const overflow = rect.right - (vw - 8);
      panel.style.transform = `translateX(-${overflow}px)`;
    } else {
      panel.style.transform = "";
    }
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div onClick={() => setOpen(o => !o)}>{trigger}</div>
      {open && (
        <div ref={panelRef} style={{ position: "absolute", top: "calc(100% + 6px)", [align === "right" ? "right" : "left"]: 0, background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", boxShadow: "0 8px 32px rgba(0,0,0,0.25)", zIndex: 100, minWidth: "200px", maxWidth: "min(360px, calc(100vw - 16px))", clipPath: "inset(0 round 12px)" }}>
          {children}
        </div>
      )}
    </div>
  );
}

// Style helpers
const mi = (active = false): React.CSSProperties => ({
  display: "flex", alignItems: "center", gap: "10px", padding: "9px 14px", fontSize: "13px", cursor: "pointer", width: "100%",
  background: active ? "rgba(59,130,246,0.12)" : "transparent",
  color: active ? "#3B82F6" : "var(--color-text-primary)", transition: "background 0.1s",
});
const ms = (label: string) => (
  <div style={{ padding: "10px 14px 4px", fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
);
const md = <div style={{ height: "1px", background: "var(--color-border)", margin: "4px 0" }} />;
const tbBtn = (active = false): React.CSSProperties => ({
  display: "flex", alignItems: "center", gap: "6px", padding: "6px 13px",
  borderRadius: "9999px",                                       /* pill — matches period pills */
  border: `1px solid ${active ? "var(--color-accent-blue)" : "var(--color-border)"}`,
  background: active ? "rgba(var(--color-accent-blue-rgb,0,102,204), 0.12)" : "var(--color-card)",
  color: active ? "var(--color-accent-blue)" : "var(--color-text-secondary)",
  fontSize: "12px", fontWeight: active ? 700 : 500, cursor: "pointer", whiteSpace: "nowrap" as const,
});

// ─── Main page ────────────────────────────────────────────────────────────────
const DashGoogleIcon = ({ s = 14 }) => (<svg width={s} height={s} viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>);
const DashBingIcon = ({ s = 14 }) => (<svg width={s} height={s} viewBox="0 0 512 512"><polygon points="166.685,38.682 52.904,0 52.904,422.118 166.685,321.987" fill="#008373"/><polygon points="206.501,133.117 253.157,249.166 319.397,270.361 56.324,431.215 170.095,512 459.096,336.78 459.096,216.17" fill="#008373"/></svg>);
const DashYandexIcon = ({ s = 14 }) => (<svg width={s} height={s} viewBox="0 0 32 32"><path d="M21.88,2h-4c-4,0-8.07,3-8.07,9.62a8.33,8.33,0,0,0,4.14,7.66L9,28.13A1.25,1.25,0,0,0,9,29.4a1.21,1.21,0,0,0,1,.6h2.49a1.24,1.24,0,0,0,1.2-.75l4.59-9h.34v8.62A1.14,1.14,0,0,0,19.82,30H22a1.12,1.12,0,0,0,1.16-1.06V3.22A1.19,1.19,0,0,0,22,2ZM18.7,16.28h-.59c-2.3,0-3.66-1.87-3.66-5,0-3.9,1.73-5.29,3.34-5.29h.94Z" fill="#d61e3b"/></svg>);

function PortfolioPageContent() {
  const { t } = useLanguage();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Legacy: the striking/cannibalization/decay views moved to their own routes
  // (/striking, /cannibalization, /decay). Redirect old ?tab= bookmarks there.
  useEffect(() => {
    const legacy = searchParams.get("tab");
    if (legacy && legacy !== "sites") router.replace(`/${legacy}`);
    else if (legacy === "sites") router.replace("/");
  }, [searchParams, router]);
  const [sites, setSites]       = useState<any[]>([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState("");
  const { blur } = usePrivacy();
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // Archive of properties removed from Search Console — collapsed by default.
  const [showArchive, setShowArchive] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState<string | null>(null);
  // Ahrefs Domain Rating per domain (free public API, server-cached). License requires
  // visible "Domain Rating by Ahrefs" attribution wherever DR is shown.
  const [drMap, setDrMap] = useState<Record<string, number>>({});
  // True while the background DR backfill (below) is still working through the site list —
  // lets cards distinguish "still checking" from "checked, nothing found" instead of just
  // popping in whenever their chunk finishes, which reads as broken rather than loading.
  const [drLoading, setDrLoading] = useState(false);
  // Paid domain metrics, kept in a separate map from DR on purpose: DR is free and always
  // present, these are optional and may never arrive. Merging them would make one nullable
  // thing out of two with very different guarantees.
  const [domMap, setDomMap] = useState<Record<string, { refDomains: number | null; orgTraffic: number | null }>>({});
  const [siteTags, setSiteTags] = useState<Record<string, string[]>>({});
  const tagsInitialized = useRef(false);
  const [exportSite, setExportSite] = useState<string | null>(null);

  const [activeMetrics, setActiveMetrics] = useState<Set<Metric>>(new Set(["clicks", "impressions", "ctr", "position"]));
  const [sortBy, setSortBy] = useState<SortBy>(() => {
    if (typeof window !== "undefined") return (localStorage.getItem("gsc_sort") as SortBy) ?? "az";
    return "az";
  });
  const [accounts, setAccounts] = useState<any[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [editingTagSiteId, setEditingTagSiteId] = useState<string | null>(null);
  // Per-site market override, mirroring `editingTagSiteId`. The market drives which country the
  // keyword cache is filed under, so editing it is a correctness lever — not a preference.
  const [editingMarketId, setEditingMarketId] = useState<string | null>(null);
  // Market filter chip — null = show all. Special value "__unknown__" matches sites whose market
  // cannot be resolved, the same amber set the card highlights.
  const [activeMarket, setActiveMarket] = useState<string | null>(null);
  const [period, setPeriod]     = useState("7d");
  // Search-engine portfolio tabs. Google = local DB; Bing/Yandex = live, fetched on tab
  // click and cached per engine+period so switching back is instant.
  const [engine, setEngine] = useState<"google" | "bing" | "yandex">("google");
  const [altEngines, setAltEngines] = useState<("bing" | "yandex")[]>([]);
  const [engineCache, setEngineCache] = useState<Record<string, any[]>>({});
  const [engineSyncedAt, setEngineSyncedAt] = useState<Record<string, number>>({});
  const [engineAccounts, setEngineAccounts] = useState<Record<string, { name: string }[]>>({ bing: [], yandex: [] });
  const [engineLoading, setEngineLoading] = useState(false);
  const [periodView, setPeriodView] = useState<PeriodView>("day");
  const [comparison, setComparison] = useState<Comparison>("previous");
  const [prevTrend, setPrevTrend]   = useState(true);
  const [matchWd, setMatchWd]       = useState(true);
  const [showPct, setShowPct]       = useState(true);
  const [searchType, setSearchType] = useState<SearchType>("web");
  const [branded, setBranded]       = useState<BrandedFilter>("all");
  const [filterDimension, setFilterDimension] = useState<"query"|"page"|"country"|"device"|null>(null);
  const [filterText, setFilterText] = useState("");

  type SyncStatus = "idle" | "syncing" | "done" | "error" | "reauth";
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);

  // Asked of the server rather than of localStorage, so the label reflects the instance's last
  // sync rather than the last one this particular browser happened to watch finish. See
  // src/lib/syncedAt.ts.
  useEffect(() => {
    let cancelled = false;
    loadSyncedAt().then(d => { if (!cancelled && d) setSyncedAt(d); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    fetch('/api/gsc/accounts')
      .then(r => r.json())
      .then(d => { if (d.accounts) setAccounts(d.accounts); })
      .catch(() => {});
  }, []);

  const handleSetSortBy = (s: SortBy) => {
    setSortBy(s);
    localStorage.setItem("gsc_sort", s);
  };

  const [newSitesFound, setNewSitesFound] = useState(0);

  const portfolioUrl = (p = period) =>
    `/api/gsc/portfolio?period=${p}&matchWd=${matchWd}`;

  const refetchPortfolio = (p = period) => {
    fetch(portfolioUrl(p))
      .then(r => r.json())
      .then(d => {
        if (d.sites) {
          setNewSitesFound(prev => Math.max(0, (d.sites as any[]).length - sites.length));
          setSites(d.sites);
        }
      })
      .catch(() => {});
  };

  // On mount: discover sites only (fast, no sync)
  useEffect(() => {
    let ignore = false;
    fetch('/api/gsc/sites')
      .then(r => r.json())
      .then(d => {
        if (!ignore && d.sites?.length) {
          setSites(prev => {
            // Only update if we don't already have data, to avoid overwriting portfolio metrics
            if (prev.length > 0 && prev[0].hasData) return prev;
            return d.sites;
          });
          // Load tags from DB once on mount
          if (!tagsInitialized.current) {
            tagsInitialized.current = true;
            const tagsFromDb: Record<string, string[]> = {};
            for (const s of d.sites as any[]) {
              if (s.tags) {
                try {
                  const parsed = JSON.parse(s.tags);
                  if (Array.isArray(parsed)) tagsFromDb[s.id] = parsed;
                } catch {
                  tagsFromDb[s.id] = s.tags.split(",").map((t: string) => t.trim()).filter(Boolean);
                }
              }
            }
            setSiteTags(tagsFromDb);
          }
        }
      })
      .catch(() => {});
    return () => { ignore = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What a finished run means, in one place — shared by the button and by the resume effect
  // below, so a sync watched from a freshly opened tab ends exactly like one watched from the
  // tab that started it.
  const settleSync = (s: SyncState) => {
    refetchPortfolio();
    if (s.needsReauth) {
      setSyncStatus("reauth");
      setSyncWarning("reauth");
      setTimeout(() => setSyncStatus("idle"), 30_000);
    } else if (s.accountErrors > 0 && s.sitesSynced === 0) {
      setSyncStatus("error");
      setSyncWarning("error");
      setTimeout(() => setSyncStatus("idle"), 30_000);
    } else {
      // The server's completion time, not this tab's clock — the tab only hears about it on the
      // next poll, up to fifteen seconds later.
      const at = s.completedAt ?? new Date();
      setSyncedAt(at);
      rememberSyncedAt(at);
      setSyncStatus("done");
      setTimeout(() => setSyncStatus("idle"), 5_000);
    }
  };

  const stopWatch = useRef<(() => void) | null>(null);
  useEffect(() => () => { stopWatch.current?.(); }, []);

  const handleSync = () => {
    if (syncStatus === "syncing") return;
    setSyncStatus("syncing");
    setSyncWarning(null);

    // Also refresh the live Bing/Yandex portfolios so "Sync" updates every engine at once
    // and their tabs are ready (no per-tab reload). Runs in parallel with the GSC sync.
    refreshEngines();

    fetch('/api/gsc/sync', { method: 'POST' })
      .then(r => r.json())
      .then(() => {
        stopWatch.current?.();
        stopWatch.current = watchSync(settleSync, () => setSyncStatus("idle"));
      })
      .catch(() => setSyncStatus("idle"));
  };

  // A sync outlives the page that started it: it runs in the server process, not in the tab. So
  // a reload, or a different browser entirely, picks the spinner back up rather than showing an
  // idle button while two hundred properties are still being fetched one by one.
  useEffect(() => {
    let cancelled = false;
    fetchSyncState().then(s => {
      if (cancelled || !s?.syncing) return;
      setSyncStatus("syncing");
      stopWatch.current?.();
      stopWatch.current = watchSync(settleSync, () => setSyncStatus("idle"));
    });
    return () => { cancelled = true; };
    // settleSync closes over setState functions and refetchPortfolio, all of which are recreated
    // every render; listing it would restart the watcher on each one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch real data from portfolio API whenever period or comparison settings change
  useEffect(() => {
    setLoading(true);
    fetch(portfolioUrl(period))
      .then(r => r.json())
      .then(d => { if (d.sites) setSites(d.sites); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [period, matchWd]);

  // Which engine tabs to show (owner keys live in localStorage, same as the site page).
  useEffect(() => {
    const has = (e: string) => {
      if (localStorage.getItem(`seoKey_${e}`)) return true;
      try { return (JSON.parse(localStorage.getItem(`seoKey_${e}_accounts_list`) || "[]") as any[]).length > 0; } catch { return false; }
    };
    const list: ("bing" | "yandex")[] = [];
    if (has("bing")) list.push("bing");
    if (has("yandex")) list.push("yandex");
    setAltEngines(list);
    // Connected accounts per engine (name from Settings), mirroring the Google accounts bar.
    const accsOf = (e: string): { name: string }[] => {
      let arr: any[] = [];
      try { arr = JSON.parse(localStorage.getItem(`seoKey_${e}_accounts_list`) || "[]"); } catch { arr = []; }
      const out = arr.filter(a => a?.key).map(a => ({ name: a.name || a.email || (e === "bing" ? "Bing" : "Yandex") }));
      if (!out.length && localStorage.getItem(`seoKey_${e}`)) out.push({ name: "Default" });
      return out;
    };
    setEngineAccounts({ bing: accsOf("bing"), yandex: accsOf("yandex") });
  }, []);

  const engineKey = `${engine}_${period}`;

  // Fetch one engine's portfolio. Normally serves the stored server-side snapshot instantly;
  // pass force=true (Sync / Refresh) to rebuild from the live APIs.
  const loadEngine = (eng: "bing" | "yandex", p = period, setLoading = false, force = false) => {
    const key = `${eng}_${p}`;
    if (setLoading) setEngineLoading(true);
    return fetch(`/api/gsc/portfolio-engine?engine=${eng}&period=${p}${force ? "&refresh=1" : ""}`)
      .then(r => r.json())
      .then(d => { if (d.sites) { setEngineCache(c => ({ ...c, [key]: d.sites })); setEngineSyncedAt(t => ({ ...t, [key]: d.cachedAt ? new Date(d.cachedAt).getTime() : Date.now() })); } })
      .catch(() => {})
      .finally(() => { if (setLoading) setEngineLoading(false); });
  };
  // Rebuild every configured engine for the current period (used by the global Sync button).
  const refreshEngines = (p = period) => { altEngines.forEach(eng => loadEngine(eng, p, engine === eng, true)); };

  // Lazy-load a live Bing/Yandex portfolio when its tab is first opened.
  useEffect(() => {
    if (engine === "google" || engineCache[engineKey]) return;
    loadEngine(engine, period, true);
  }, [engine, period]); // eslint-disable-line react-hooks/exhaustive-deps

  // The dataset the whole dashboard renders from — Google (DB) or the active engine (cache).
  const activeSites = engine === "google" ? sites : (engineCache[engineKey] ?? []);

  // sitesWithData = sites already have real .data and .summary from the API
  // Fall back to fake data only if the site has no real metrics yet
  const sitesWithData = useMemo(() => {
    const days = periodToDays(period);
    const maxPoints = 90;
    const n = Math.min(days, maxPoints);
    const yd = new Date(); yd.setDate(yd.getDate() - 1);
    const startDate = new Date(yd);
    startDate.setDate(yd.getDate() - n + 1);

    return activeSites.map(s => {
      if (s.hasData && s.data?.length > 0) {
        // Real data: normalise chart arrays the same way the fake data does
        return s;
      }
      // No data synced yet — show placeholder zeros instead of fake numbers
      const emptyData = Array.from({ length: n }, (_, i) => {
        const d = new Date(startDate); d.setDate(startDate.getDate() + i);
        return {
          date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          clicks: 0, impressions: 0, ctr: 0, position: 0,
          clicksC: 0, impressionsC: 0, ctrC: 0, positionC: 0,
          cN: 50, iN: 50, tN: 50, pN: 50,
          cCN: 50, iCN: 50, tCN: 50, pCN: 50,
        };
      });
      return {
        ...s,
        data: emptyData,
        summary: {
          clicks:      { value: 0, change: 0 },
          impressions: { value: 0, change: 0 },
          ctr:         { value: 0, change: 0 },
          position:    { value: 0, change: 0 },
        },
      };
    });
  }, [activeSites, period]);
  const activeFilterCount = [
    branded !== "all",
    filterDimension !== null && filterText.trim() !== "",
    !!activeTag,
    !!activeMarket,
  ].filter(Boolean).length;

  // Fetch Ahrefs DR for all dashboard domains (chunked; server caches 7 days).
  useEffect(() => {
    if (!sites.length) return;
    const domains = [...new Set(sites.map(s => getDomain(s.url).toLowerCase().replace(/^www\./, "")).filter(d => d.includes(".")))];
    setDrLoading(true);
    (async () => {
      try {
        for (let i = 0; i < domains.length; i += 100) {
          try {
            const res = await fetch(`/api/dr?domains=${encodeURIComponent(domains.slice(i, i + 100).join(","))}`, { headers: { "x-ahrefs-dr-key": getAhrefsDrKey() } });
            if (!res.ok) continue;
            const d = await res.json();
            const add: Record<string, number> = {};
            Object.entries(d.ratings || {}).forEach(([k, v]: [string, any]) => { add[k] = Number(v.dr); });
            setDrMap(prev => ({ ...prev, ...add }));
          } catch { /* best-effort */ }
        }
      } finally {
        // Whatever is still missing after this is a real "no rating", not a pending one — cards
        // stop pulsing and fall back to showing nothing, same as before this loading state existed.
        setDrLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sites.length]);

  // Referring domains and organic traffic, read from the metric cache only — this call never
  // reaches a provider and never spends anything (see /api/metrics/domain). Whatever is there
  // was put there by an import or by an explicit fetch elsewhere; if nothing is, the cards look
  // exactly as they did before this existed.
  useEffect(() => {
    if (!sites.length) return;
    const domains = [...new Set(sites.map(s => getDomain(s.url).toLowerCase().replace(/^www\./, "")).filter(d => d.includes(".")))];
    (async () => {
      for (let i = 0; i < domains.length; i += 200) {
        try {
          const res = await fetch("/api/metrics/domain", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domains: domains.slice(i, i + 200), fetch: false }),
          });
          if (!res.ok) continue;
          const d = await res.json();
          const add: Record<string, { refDomains: number | null; orgTraffic: number | null }> = {};
          Object.entries(d.metrics || {}).forEach(([k, v]: [string, any]) => {
            if (v?.refDomains != null || v?.orgTraffic != null) {
              add[k] = { refDomains: v.refDomains ?? null, orgTraffic: v.orgTraffic ?? null };
            }
          });
          setDomMap(prev => ({ ...prev, ...add }));
        } catch { /* the card is complete without these */ }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sites.length]);

  // Resolve a site's market the same way the card chip does: explicit override, then ccTLD, then
  // null. Kept as a helper so the filter and the totals row answer the same question the card does.
  const marketOf = (s: any) => marketFor({ url: s.url, siteId: s.siteId, market: s.market });
  // `__unknown__` is the active-market value for the amber set — sites whose market cannot be
  // resolved and which therefore file paid keyword data under the wrong country (or refuse it).
  const marketMatch = (s: any) => {
    if (!activeMarket) return true;
    const m = marketOf(s);
    return activeMarket === "__unknown__" ? m === null : m === activeMarket;
  };

  const filtered = sitesWithData
    .filter(s => {
      const domain = getDomain(s.url).toLowerCase();
      const tagsStr = (siteTags[s.id] || []).join(" ").toLowerCase();
      const searchLower = search.toLowerCase();

      if (!domain.includes(searchLower) && !tagsStr.includes(searchLower)) return false;
      if (branded === "branded"    && brandedRatio(s.url) <  0.45) return false;
      if (branded === "nonbranded" && brandedRatio(s.url) >= 0.45) return false;
      if (activeTag && !(siteTags[s.id] || []).includes(activeTag)) return false;
      if (activeMarket && !marketMatch(s)) return false;
      // Portfolio dimension filters work on domain/position, so they apply to every engine.
      if (filterText.trim() && filterText !== "__longtail__") {
        const txt = filterText.trim().toLowerCase();
        if (filterDimension === "country") {
          // Match the resolved market (override + ccTLD), falling back to the TLD as a textual
          // hint — so "gr" finds both a `.gr` domain and a `.com` site whose market is set to gr.
          const m = marketOf(s);
          const tld = domain.split(".").pop() ?? "";
          if (!(m === txt || tld.includes(txt))) return false;
        } else if (filterDimension === "query" || filterDimension === "page") {
          if (!domain.includes(txt)) return false;
        }
      }
      // Long Tail preset on portfolio: filter sites where avg position > 10 (tail traffic proxy)
      if (filterDimension === "query" && filterText === "__longtail__") {
        const pos = s.summary?.position?.value ?? 0;
        if (pos > 0 && pos <= 10) return false;
      }
      return true;
    })
    .sort((a, b) => {
      // Active tag: sites with this tag always float to top
      if (activeTag) {
        const aHas = (siteTags[a.id] || []).includes(activeTag);
        const bHas = (siteTags[b.id] || []).includes(activeTag);
        if (aHas && !bHas) return -1;
        if (!aHas && bHas) return 1;
      }
      switch (sortBy) {
        case "az":
          return getDomain(a.url).localeCompare(getDomain(b.url));
        case "total":
          return b.summary.clicks.value - a.summary.clicks.value;
        case "growth":
          return (b.summary.clicks.value * b.summary.clicks.change / 100)
               - (a.summary.clicks.value * a.summary.clicks.change / 100);
        case "growth_pct":
          return b.summary.clicks.change - a.summary.clicks.change;
        case "decline":
          // Most negative clicks change first; sites with 0 clicks go last
          if (a.summary.clicks.value === 0 && b.summary.clicks.value === 0) return 0;
          if (a.summary.clicks.value === 0) return 1;
          if (b.summary.clicks.value === 0) return -1;
          return a.summary.clicks.change - b.summary.clicks.change;
        case "decline_imp":
          // Most negative impressions change first; sites with 0 impressions go last
          if (a.summary.impressions.value === 0 && b.summary.impressions.value === 0) return 0;
          if (a.summary.impressions.value === 0) return 1;
          if (b.summary.impressions.value === 0) return -1;
          return a.summary.impressions.change - b.summary.impressions.change;
        case "decline_pos":
          // Biggest position drop first (position increased = got worse); sites with no data go last
          if (a.summary.position.value === 0 && b.summary.position.value === 0) return 0;
          if (a.summary.position.value === 0) return 1;
          if (b.summary.position.value === 0) return -1;
          // Higher change = position got worse (e.g. +5 means dropped 5 spots)
          return b.summary.position.change - a.summary.position.change;
        case "tags": {
          const aTag = siteTags[a.id]?.[0]?.toLowerCase() || "zzz";
          const bTag = siteTags[b.id]?.[0]?.toLowerCase() || "zzz";
          return aTag.localeCompare(bTag) || getDomain(a.url).localeCompare(getDomain(b.url));
        }
        default:
          return 0;
      }
    });
  // Properties that Google no longer returns are archived, not deleted. They are
  // pulled out of every live group so they stop skewing the portfolio totals.
  const isArchived  = (s: { archivedAt?: string | null }) => Boolean(s.archivedAt);
  const archivedSites = filtered.filter(isArchived);
  const liveFiltered  = filtered.filter(s => !isArchived(s));
  const favSites    = liveFiltered.filter(s => favorites.has(s.id) && !hidden.has(s.id));
  const restSites   = liveFiltered.filter(s => !favorites.has(s.id) && !hidden.has(s.id));
  const hiddenSites = liveFiltered.filter(s => hidden.has(s.id));

  // ─── Totals from visible (filtered) sites — respects search/tag/market/branded filters ──
  // When a tag or market is active, totals are computed only over sites matching it
  const visibleForTotals = [...favSites, ...restSites].filter(
    s => (!activeTag || (siteTags[s.id] || []).includes(activeTag))
      && (!activeMarket || marketMatch(s))
  );
  const totalClicks      = visibleForTotals.reduce((s, site) => s + (site.summary?.clicks?.value ?? 0), 0);
  const totalImpressions = visibleForTotals.reduce((s, site) => s + (site.summary?.impressions?.value ?? 0), 0);
  const withCtr = visibleForTotals.filter(s => (s.summary?.ctr?.value ?? 0) > 0);
  const avgCtr  = withCtr.length > 0 ? +(withCtr.reduce((s, site) => s + site.summary.ctr.value, 0) / withCtr.length).toFixed(2) : 0;
  const withPos = visibleForTotals.filter(s => (s.summary?.position?.value ?? 0) > 0);
  const avgPos  = withPos.length > 0 ? +(withPos.reduce((s, site) => s + site.summary.position.value, 0) / withPos.length).toFixed(1) : 0;

  // Bring an archived property back into the live list. Useful when a domain was
  // only temporarily unverified in GSC — the next sync would restore it anyway.
  const restoreSite = async (id: string) => {
    setArchiveBusy(id);
    try {
      const res = await fetch("/api/gsc/sites", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, archived: false }),
      });
      if (res.ok) setSites(prev => prev.map(s => s.id === id ? { ...s, archivedAt: null } : s));
    } catch { /* leave the row as-is; the next sync will reconcile */ }
    finally { setArchiveBusy(null); }
  };

  // Permanent removal. Cascades to metrics, audits, keywords and backlinks,
  // so it is gated behind an explicit confirm.
  const deleteSite = async (id: string, domain: string) => {
    if (!window.confirm(`${t("archiveDeleteConfirm")}\n\n${domain}`)) return;
    setArchiveBusy(id);
    try {
      const res = await fetch(`/api/gsc/sites?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok) setSites(prev => prev.filter(s => s.id !== id));
    } catch { /* no-op: the row stays, user can retry */ }
    finally { setArchiveBusy(null); }
  };

  const toggleMetric = (m: Metric) => setActiveMetrics(p => { const n = new Set(p); n.has(m) ? n.delete(m) : n.add(m); return n; });
  const toggleFav    = (id: string) => setFavorites(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleHide   = (id: string) => setHidden(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // ─── Period groups (uses t() for labels) ──────────────────────────────────
  const fmt    = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const today     = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const ago   = (n: number) => { const d = new Date(yesterday); d.setDate(yesterday.getDate() - n + 1); return d; };
  const mAgo  = (n: number) => { const d = new Date(yesterday); d.setMonth(d.getMonth() - n); return d; };
  const yAgo  = (n: number) => { const d = new Date(yesterday); d.setFullYear(d.getFullYear() - n); return d; };
  const r     = (a: Date, b: Date) => `${fmt(a)} – ${fmt(b)}`;

  const periodGroups = [
    [
      { label: fmtDay(yesterday), value: "yesterday", desc: "" },
      { label: t("period7d"),   value: "7d",  desc: r(ago(7),  yesterday) },
      { label: t("period14d"),  value: "14d", desc: r(ago(14), yesterday) },
      { label: t("period28d"),  value: "28d", desc: r(ago(28), yesterday) },
    ],
    [
      { label: t("lastWeek"),    value: "last_week",    desc: "" },
      { label: t("thisMonth"),   value: "this_month",   desc: "" },
      { label: t("lastMonth"),   value: "last_month",   desc: "" },
    ],
    [
      { label: t("thisQuarter"), value: "this_quarter", desc: "" },
      { label: t("lastQuarter"), value: "last_quarter", desc: "" },
      { label: t("yearToDate"),  value: "ytd",          desc: "" },
    ],
    [
      { label: t("period3m"),  value: "3m",  desc: r(mAgo(3),  yesterday) },
      { label: t("period6m"),  value: "6m",  desc: r(mAgo(6),  yesterday) },
      { label: t("period8m"),  value: "8m",  desc: r(mAgo(8),  yesterday) },
      { label: t("period12m"), value: "12m", desc: r(mAgo(12), yesterday) },
      { label: t("period16m"), value: "16m", desc: r(mAgo(16), yesterday) },
    ],
    [
      { label: t("period2y"), value: "2y",     desc: r(yAgo(2), yesterday) },
      { label: t("period3y"), value: "3y",     desc: r(yAgo(3), yesterday) },
      { label: t("custom"),   value: "custom", desc: "" },
    ],
  ];

  const getPeriodLabel = (v: string) => {
    for (const g of periodGroups) for (const p of g) if (p.value === v) return p.label;
    return v;
  };

  const metricLabels: Record<Metric, string> = {
    clicks:      t("clicks"),
    impressions: t("impressions"),
    ctr:         "CTR",
    position:    t("avgPosition"),
  };

  const sortLabels: Record<SortBy, string> = {
    "az":          t("sortAZ"),
    "total":       t("sortTotal"),
    "growth":      t("sortGrowth"),
    "growth_pct":  t("sortGrowthPct"),
    "decline":     t("sortDecline"),
    "decline_imp": t("sortDeclineImp"),
    "decline_pos": t("sortDeclinePos"),
    "tags":        t("sortTags"),
  };

  // Sort dropdown
  const SortDd = (
    <Dropdown trigger={<button style={tbBtn()}><ArrowUpDown size={13} /> {t("sort")}</button>}>
      {(["az","total","growth","growth_pct","decline","decline_imp","decline_pos","tags"] as SortBy[]).map(v => (
        <button key={v} style={mi(sortBy===v)} onClick={() => handleSetSortBy(v)}>
          {sortLabels[v]}{sortBy===v && <Check size={12} style={{marginLeft:"auto"}} />}
        </button>
      ))}
      {md}{ms(t("metric"))}
      {(["clicks","impressions","ctr","position"] as Metric[]).map(m => (
        <button key={m} style={mi(activeMetrics.has(m))} onClick={() => toggleMetric(m)}>
          <span style={{color:MC[m].color}}>●</span> {metricLabels[m]}
          {activeMetrics.has(m) && <Check size={12} style={{marginLeft:"auto"}} />}
        </button>
      ))}
    </Dropdown>
  );

  // Filter dropdown
  const filterDims = [
    { v: "query"   as const, l: t("filterQuery"),   i: <Search size={13}/> },
    { v: "page"    as const, l: t("filterPage"),    i: <FileText size={13}/> },
    { v: "country" as const, l: t("filterCountry"), i: <Globe size={13}/> },
    { v: "device"  as const, l: t("filterDevice"),  i: <Monitor size={13}/> },
  ];
  const filterPlaceholders: Record<string, string> = {
    query:   "e.g. casino, shop…",
    page:    "e.g. /blog, /product…",
    country: "e.g. gr, de, com…",
    device:  "",
  };
  const deviceOptions = [
    { v: "all",     l: t("all") },
    { v: "mobile",  l: t("deviceMobile") },
    { v: "desktop", l: t("deviceDesktop") },
    { v: "tablet",  l: t("deviceTablet") },
  ];

  const FilterDd = (
    <Dropdown trigger={
      <button style={tbBtn(activeFilterCount > 0)}>
        <SlidersHorizontal size={13} /> {t("filter")}
        {activeFilterCount > 0 && (
          <span style={{ background: "#3B82F6", color: "#fff", borderRadius: "10px", padding: "0 6px", fontSize: "11px", fontWeight: 700, marginLeft: "2px" }}>
            {activeFilterCount}
          </span>
        )}
      </button>
    }>
      {/* Dimension filters */}
      {ms(t("filter"))}
      {filterDims.map(({ v, l, i }) => (
        <button key={v} style={mi(filterDimension === v)} onClick={() => {
          if (filterDimension === v) { setFilterDimension(null); setFilterText(""); }
          else { setFilterDimension(v); setFilterText(""); }
        }}>
          {i} {l}
          {filterDimension === v && <Check size={12} style={{ marginLeft: "auto" }} />}
        </button>
      ))}

      {/* Text input for Query / Page / Country */}
      {filterDimension && filterDimension !== "device" && (
        <div style={{ padding: "4px 14px 10px" }}>
          <input
            autoFocus
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
            placeholder={filterPlaceholders[filterDimension]}
            style={{ width: "100%", padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none", boxSizing: "border-box" }}
          />
        </div>
      )}

      {/* Device pills */}
      {filterDimension === "device" && (
        <div style={{ padding: "4px 14px 10px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {deviceOptions.map(({ v, l }) => (
            <button key={v} onClick={() => setFilterText(v === "all" ? "" : v)} style={{ padding: "4px 10px", borderRadius: "20px", fontSize: "12px", fontWeight: 500, cursor: "pointer", border: `1px solid ${filterText === (v === "all" ? "" : v) ? "#3B82F6" : "var(--color-border)"}`, background: filterText === (v === "all" ? "" : v) ? "rgba(59,130,246,0.1)" : "transparent", color: filterText === (v === "all" ? "" : v) ? "#3B82F6" : "var(--color-text-secondary)" }}>
              {l}
            </button>
          ))}
        </div>
      )}

      {md}{ms(t("brandedQueries"))}
      <div style={{ padding: "6px 14px 10px", display: "flex", gap: "6px" }}>
        {(["all", "branded", "nonbranded"] as BrandedFilter[]).map(v => {
          const lbl = v === "all" ? t("all") : v === "branded" ? `✦ ${t("branded")}` : `◎ ${t("nonBranded")}`;
          return (
            <button key={v} onClick={() => setBranded(v)} style={{ padding: "4px 10px", borderRadius: "20px", fontSize: "12px", fontWeight: 500, cursor: "pointer", border: `1px solid ${branded === v ? "#3B82F6" : "var(--color-border)"}`, background: branded === v ? "rgba(59,130,246,0.1)" : "transparent", color: branded === v ? "#3B82F6" : "var(--color-text-secondary)" }}>
              {lbl}
            </button>
          );
        })}
      </div>

      {/* Tag filter section — only shown when user has tags */}
      {(() => {
        const allTags = [...new Set(Object.values(siteTags).flat())].sort();
        if (!allTags.length) return null;
        return (
          <>
            {md}{ms(t("tags"))}
            <div style={{ padding: "4px 14px 10px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {allTags.map(tag => {
                const isActive = activeTag === tag;
                return (
                  <button key={tag} onClick={() => setActiveTag(isActive ? null : tag)} style={{
                    padding: "4px 10px", borderRadius: "20px", fontSize: "12px", fontWeight: 500, cursor: "pointer",
                    border: `1px solid ${isActive ? "var(--color-accent-blue)" : "var(--color-border)"}`,
                    background: isActive ? "rgba(var(--color-accent-blue-rgb,0,102,204),0.12)" : "transparent",
                    color: isActive ? "var(--color-accent-blue)" : "var(--color-text-secondary)",
                  }}>
                    🏷 {tag}
                    {isActive && <span style={{ marginLeft: "5px", fontWeight: 700 }}>✓</span>}
                  </button>
                );
              })}
            </div>
          </>
        );
      })()}

      {/* Market filter — derived from the resolved market (override + ccTLD), so a `.com` site set
          to `gr` appears under gr, not under "com". `__unknown__` groups the amber set: sites the
          keyword cache cannot file correctly until a human picks a market. */}
      {(() => {
        const counts = new Map<string, number>();
        for (const s of sites) {
          const m = marketOf(s);
          const key = m === null ? "__unknown__" : m;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        if (counts.size <= 1) return null; // one bucket = nothing to filter between
        const entries = [...counts.entries()].sort((a, b) =>
          a[0] === "__unknown__" ? 1 : b[0] === "__unknown__" ? -1 : a[0].localeCompare(b[0]),
        );
        return (
          <>
            {md}{ms(t("siteMarket"))}
            <div style={{ padding: "4px 14px 10px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {entries.map(([key, n]) => {
                const unknown = key === "__unknown__";
                const isActive = activeMarket === key;
                return (
                  <button key={key} onClick={() => setActiveMarket(isActive ? null : key)} style={{
                    padding: "4px 10px", borderRadius: "20px", fontSize: "12px", fontWeight: 500, cursor: "pointer",
                    border: `1px solid ${isActive ? "#ff9f0a" : "var(--color-border)"}`,
                    background: isActive ? "rgba(255,159,10,0.16)" : "transparent",
                    color: isActive ? "#ff9f0a" : "var(--color-text-secondary)",
                  }}>
                    {unknown ? t("siteMarketUnknown") : key.toUpperCase()} <span style={{ opacity: 0.6 }}>{n}</span>
                    {isActive && <span style={{ marginLeft: "5px", fontWeight: 700 }}>✓</span>}
                  </button>
                );
              })}
            </div>
          </>
        );
      })()}

      {md}{ms(t("presetFilters"))}
      <button style={mi(filterDimension === "query" && filterText === "?")}
        onClick={() => { setFilterDimension("query"); setFilterText("?"); }}>
        <Search size={13}/> {t("peopleAlsoAsk")}
      </button>
      <button style={mi(filterDimension === "query" && filterText === "__longtail__")}
        onClick={() => { setFilterDimension("query"); setFilterText("__longtail__"); }}>
        <FileText size={13}/> {t("longTailKeywords")}
      </button>

      {/* Reset */}
      {activeFilterCount > 0 && (
        <>
          {md}
          <button style={{ ...mi(), color: "#EF4444" }} onClick={() => { setBranded("all"); setFilterDimension(null); setFilterText(""); setActiveTag(null); setActiveMarket(null); }}>
            <X size={13}/> Reset filters
          </button>
        </>
      )}
    </Dropdown>
  );

  // Period dropdown
  const PeriodDd = (
    <Dropdown trigger={<button style={{...tbBtn(),gap:"8px"}}>{getPeriodLabel(period)} <ChevronDown size={13}/></button>} align="right">
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",minWidth:"460px"}}>
        {/* Left: comparison */}
        <div style={{borderRight:"1px solid var(--color-border)"}}>
          {ms(t("comparisonPeriod"))}
          {([
            {l: t("compDisabled"),   v:"disabled"},
            {l: t("compPrevious"),   v:"previous"},
            {l: t("compYoy"),        v:"yoy"},
            {l: t("compPrevMonth"),  v:"prev_month"},
            {l: t("custom"),         v:"custom"},
          ] as {l:string;v:Comparison}[]).map(({l,v}) => (
            <button key={v} style={{...mi(comparison===v),fontWeight:comparison===v?600:400,color:comparison===v?"#3B82F6":"var(--color-text-secondary)"}} onClick={()=>setComparison(v)}>{l}</button>
          ))}
          {md}{ms(t("comparisonSettings"))}
          {([
            {l: t("prevTrendLine"), val:prevTrend, set:setPrevTrend},
            {l: t("matchWeekdays"), val:matchWd,   set:setMatchWd},
            {l: t("showChangePct"), val:showPct,   set:setShowPct},
          ]).map(({l,val,set}) => (
            <button key={l} style={mi()} onClick={()=>set(!val)}>
              <div style={{width:"16px",height:"16px",borderRadius:"4px",flexShrink:0,border:`2px solid ${val?"#3B82F6":"var(--color-border)"}`,background:val?"#3B82F6":"transparent",display:"flex",alignItems:"center",justifyContent:"center"}}>
                {val && <Check size={10} color="#fff" />}
              </div>
              {l}
            </button>
          ))}
          {md}{ms(t("searchType"))}
          {([
            {l: t("searchTypeWeb"),      v:"web",      i:<Globe size={13}/>},
            {l: t("searchTypeDiscover"), v:"discover", i:<Compass size={13}/>},
            {l: t("searchTypeNews"),     v:"news",     i:<Newspaper size={13}/>},
            {l: t("searchTypeImage"),    v:"image",    i:<Image size={13}/>},
            {l: t("searchTypeVideo"),    v:"video",    i:<Video size={13}/>},
          ] as {l:string;v:SearchType;i:React.ReactNode}[]).map(({l,v,i}) => (
            <button key={v} style={mi(searchType===v)} onClick={()=>setSearchType(v)}>{i} {l}{searchType===v&&<Check size={12} style={{marginLeft:"auto"}}/>}</button>
          ))}
        </div>
        {/* Right: periods */}
        <div style={{minWidth:0,display:"flex",flexDirection:"column"}}>
          <div style={{display:"flex",borderBottom:"1px solid var(--color-border)",padding:"6px 8px",gap:"4px"}}>
            {([
              {v:"day",   l: t("periodDay")},
              {v:"week",  l: t("periodWeek")},
              {v:"month", l: t("periodMonth")},
            ] as {v:PeriodView;l:string}[]).map(({v,l}) => (
              <button key={v} onClick={()=>setPeriodView(v)} style={{flex:1,padding:"5px 0",borderRadius:"6px",fontSize:"13px",fontWeight:periodView===v?600:400,cursor:"pointer",background:periodView===v?"rgba(59,130,246,0.12)":"transparent",color:periodView===v?"#3B82F6":"var(--color-text-secondary)",border:"none",transition:"all 0.15s"}}>
                {l}
              </button>
            ))}
          </div>
          <div className="period-scroll" style={{maxHeight:"420px",overflowY:"auto",scrollbarGutter:"stable",width:"100%"}}>
            {periodGroups.map((grp, gi) => (
              <div key={gi}>
                {grp.map(({label,value,desc}) => {
                  const active = period===value;
                  return (
                    <button key={value} style={{...mi(active),flexDirection:"column",alignItems:"flex-start",gap:"1px",padding:"8px 16px"}} onClick={()=>setPeriod(value)}>
                      <span style={{fontWeight:active?700:400,fontSize:"13px"}}>{label}</span>
                      {desc && <span style={{fontSize:"11px",color:"var(--color-text-secondary)",marginTop:"1px"}}>{desc}</span>}
                    </button>
                  );
                })}
                {gi < periodGroups.length-1 && md}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Dropdown>
  );

  // Site card
  function SiteCard({ site }: { site: any }) {
    const domain = getDomain(site.url);
    const isFav  = favorites.has(site.id);
    const sum: Record<Metric,{value:number;change:number}> = site.summary;
    const healthStatus = useHealthStatus(site.siteDbId ?? null);

    const declineChange =
      sortBy === "decline"     ? sum.clicks.change :
      sortBy === "decline_imp" ? sum.impressions.change :
      sortBy === "decline_pos" ? sum.position.change :
      0;
    const isDeclineMode = sortBy === "decline" || sortBy === "decline_imp" || sortBy === "decline_pos";
    // For position: positive change = got worse, so highlight when change > 0
    const isFalling = isDeclineMode && (
      sortBy === "decline_pos" ? declineChange > 0 : declineChange < 0
    );
    const declineBorder = isFalling
      ? { borderColor: `rgba(239,68,68,${Math.min(0.75, 0.25 + Math.abs(declineChange) / 100 * 0.5)})` }
      : {};

    return (
      <div onClick={() => router.push(`/site/${encodeURIComponent(domain)}`)} className="card" style={{padding:"14px 16px",display:"flex",flexDirection:"column",gap:"8px",cursor:"pointer",textDecoration:"none",color:"inherit",...declineBorder}}>
        {/* Header */}
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:"8px"}}>
          {/* Domain (name row + DR line underneath — the badge no longer squeezes the name) */}
          <div style={{display:"flex",flexDirection:"column",gap:"3px",minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:"6px",minWidth:0}}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/favicon?domain=${domain}`} width={16} height={16} alt=""
                style={{borderRadius:"3px",flexShrink:0,filter:blur?"blur(5px)":"none",transition:"filter 0.25s"}} onError={e=>((e.target as HTMLImageElement).style.display="none")} />
              <span style={{fontWeight:500,fontSize:"13px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",filter:blur?"blur(5px)":"none",transition:"filter 0.25s"}}>
                {domain}
              </span>
              <a href={`https://${domain}`} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{color:"var(--color-text-secondary)",flexShrink:0}}>
                <ExternalLink size={10}/>
              </a>
              {/* Health dot */}
              {healthStatus && (
                <span
                  title={healthStatus === "error" ? "Health issue detected" : healthStatus === "warn" ? "Health warning" : "All checks passed"}
                  style={{
                    width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                    background: healthStatus === "error" ? "#EF4444" : healthStatus === "warn" ? "#F59E0B" : "#10B981",
                    boxShadow: `0 0 0 2px ${healthStatus === "error" ? "rgba(239,68,68,0.25)" : healthStatus === "warn" ? "rgba(245,158,11,0.25)" : "rgba(16,185,129,0.25)"}`,
                  }}
                />
              )}
            </div>
            {(() => {
              const key = domain.toLowerCase().replace(/^www\./,"");
              const dr = drMap[key];
              const dm = domMap[key];
              // While the dashboard-wide DR backfill is still running, an unloaded card pulses
              // instead of just staying silent — otherwise cards popping in over the first
              // minute or two (Ahrefs is rate-limited on purpose) reads as some sites being
              // broken rather than everything still loading.
              const drPending = dr == null && drLoading;
              if (dr == null && !dm && !drPending) return null;
              const chip: React.CSSProperties = {fontSize:"10px",fontWeight:700,padding:"1px 6px",borderRadius:"6px",filter:blur?"blur(4px)":"none",transition:"filter 0.25s"};
              return (
                <div style={{display:"flex",gap:"4px",alignSelf:"flex-start",marginLeft:"22px",flexWrap:"wrap"}}>
                  {/* DR is the free, always-available number and keeps its own styling. The
                      optional paid metrics sit beside it in a muted chip so their absence
                      reads as "not loaded" rather than "broken". */}
                  {dr != null && (
                    <span title="Domain Rating by Ahrefs (ahrefs.com)" style={{...chip,background:"rgba(58,87,252,0.12)",color:"#3A57FC"}}>
                      DR {Math.round(dr)}
                    </span>
                  )}
                  {drPending && (
                    <span title="Domain Rating by Ahrefs — checking…" className="dr-pulse" style={{...chip,background:"rgba(58,87,252,0.06)",color:"var(--color-text-tertiary)"}}>
                      DR
                    </span>
                  )}
                  {dm?.refDomains != null && (
                    <span title={t("dashRefDomains")} style={{...chip,background:"rgba(255,255,255,0.06)",color:"var(--color-text-secondary)"}}>
                      RD {fmtK(Math.round(dm.refDomains))}
                    </span>
                  )}
                  {dm?.orgTraffic != null && (
                    <span title={t("dashOrgTraffic")} style={{...chip,background:"rgba(255,255,255,0.06)",color:"var(--color-text-secondary)"}}>
                      OT {fmtK(Math.round(dm.orgTraffic))}
                    </span>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Metrics 2×2 */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"3px 14px",flexShrink:0}}>
            {(["clicks","impressions","ctr","position"] as Metric[]).map(m => {
              if (!activeMetrics.has(m)) return null;
              const {value,change} = sum[m];
              const good  = m==="position" ? change<=0 : change>=0;
              const arrow = m==="position" ? (change<0?"↑":"↓") : (change>=0?"↑":"↓");
              return (
                <div key={m} style={{display:"flex",alignItems:"center",gap:"4px",fontSize:"12px",whiteSpace:"nowrap"}}>
                  <span style={{color:MC[m].color,fontSize:"10px",fontWeight:700}}>
                    {m==="clicks"?"✦":m==="impressions"?"◉":m==="ctr"?"%":"↑"}
                  </span>
                  <span style={{fontWeight:600,filter:blur?"blur(5px)":"none",transition:"filter 0.25s"}}>{fmtVal(m,value)}</span>
                  {change !== 0 && showPct && (
                    <span style={{fontSize:"10px",color:good?"#10B981":"#EF4444",fontWeight:500,filter:blur?"blur(5px)":"none",transition:"filter 0.25s"}}>
                      {arrow}{Math.abs(change)}%
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Chart */}
        <MultiMetricChart data={site.data} activeMetrics={activeMetrics} prevTrend={prevTrend} />

        {/* Footer: tags and 4 action icons */}
        <div style={{display:"flex",flexDirection:"column",gap:"6px",paddingTop:"2px"}} onClick={e=>e.stopPropagation()}>

          {/* Inline tag editor (shown when editing this site) */}
          {editingTagSiteId === site.id && (
            <TagInput
              initialValue={(siteTags[site.id] || []).join(", ")}
              onSave={v => {
                const newTags = v.split(",").map(x => x.trim()).filter(Boolean);
                setSiteTags(prev => ({ ...prev, [site.id]: newTags }));
                setEditingTagSiteId(null);
                fetch("/api/gsc/tags", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ siteId: site.id, tags: newTags }),
                }).catch(() => {});
              }}
              onCancel={() => setEditingTagSiteId(null)}
              placeholder={t("tagsPrompt") || t("tagsExample")}
            />
          )}

          {/* Inline market editor — two-letter ISO code, or empty to fall back to the ccTLD. */}
          {editingMarketId === site.id && (
            <MarketInput
              initialValue={site.market || ""}
              onSave={v => {
                setEditingMarketId(null);
                fetch("/api/gsc/market", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ siteId: site.id, market: v }),
                }).then(r => r.json()).then(d => {
                  // Optimistic local update so the chip reflects the resolved market immediately,
                  // without a full portfolio refetch. The server echoes back the effective value.
                  if (d?.ok) setSites(prev => prev.map(s => s.id === site.id ? { ...s, market: d.market } : s));
                }).catch(() => {});
              }}
              onCancel={() => setEditingMarketId(null)}
              placeholder={t("siteMarketAuto")}
            />
          )}

          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            {/* Tags display */}
            <div style={{display:"flex",gap:"4px",flexWrap:"wrap",flex:1,minWidth:0,marginRight:"8px",alignItems:"center"}}>
              {(() => {
                // The market chip: a resolved gl code (from override or ccTLD) shows muted; an
                // unknown market shows amber, because keyword data will be filed under the wrong
                // country — or refused outright — until a human picks one. Click opens the inline
                // editor — the chip is the only entry point, so it must read as interactive.
                const effective = marketFor({ url: site.url, siteId: site.siteId, market: site.market });
                const unknown = effective === null;
                const editing = editingMarketId === site.id;
                return (
                  <span
                    title={unknown ? t("siteMarketUnknown") : `${t("siteMarket")}: ${effective.toUpperCase()} — ${t("siteMarketEdit")}`}
                    onClick={e => { e.preventDefault(); e.stopPropagation(); setEditingMarketId(editing ? null : site.id); }}
                    style={{
                      fontSize: "10px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px",
                      whiteSpace: "nowrap", cursor: "pointer",
                      textTransform: unknown ? "none" : "uppercase",
                      background: unknown ? "rgba(255,159,10,0.16)" : "rgba(139,92,246,0.12)",
                      color: unknown ? "#ff9f0a" : "#8B5CF6",
                      border: unknown ? "1px dashed rgba(255,159,10,0.5)" : "1px solid transparent",
                      outline: editing ? "1.5px solid #8B5CF6" : "none",
                      outlineOffset: "1px",
                    }}
                  >
                    {unknown ? `⚠ ${t("siteMarketSet")}` : effective}
                  </span>
                );
              })()}
              {(siteTags[site.id] || []).map(tag => {
                const isActive = activeTag === tag;
                return (
                  <span key={tag}
                    title={isActive ? t("tagFilterRemove") : t("tagFilterApply")}
                    onClick={e => { e.preventDefault(); e.stopPropagation(); setActiveTag(isActive ? null : tag); }}
                    style={{fontSize:"10px",fontWeight:600,padding:"2px 6px",borderRadius:"4px",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:"80px",cursor:"pointer",transition:"all 0.15s",
                      background: isActive ? "var(--color-accent-blue)" : "rgba(0,102,204,0.10)",
                      color:      isActive ? "#fff" : "var(--color-accent-blue)",
                      outline:    isActive ? "2px solid var(--color-accent-blue)" : "none",
                      outlineOffset: "1px",
                    }}>
                    {tag}
                  </span>
                );
              })}
            </div>

            {/* Action buttons */}
            <div style={{display:"flex",gap:"2px",flexShrink:0}}>
              {/* site: search in the active engine (Google / Bing / Yandex) */}
              {(() => {
                const dom = encodeURIComponent(domain.replace(/^www\./, ""));
                const es = engine === "bing"
                  ? { label: "b", color: "#00809D", url: `https://www.bing.com/search?q=site:${dom}`, name: "Bing" }
                  : engine === "yandex"
                  ? { label: "Я", color: "#FC3F1D", url: `https://yandex.com/search/?text=site:${dom}`, name: "Яндекс" }
                  : { label: "G", color: "var(--color-text-secondary)", url: `https://www.google.com/search?q=site:${dom}`, name: "Google" };
                return (
                  <CardBtn
                    tooltip={`site:${domain} — ${es.name}`}
                    onClick={e => { e.stopPropagation(); window.open(es.url, "_blank", "noreferrer"); }}
                  >
                    <span style={{ fontSize: "11px", fontWeight: 800, fontFamily: "sans-serif", color: es.color }}>{es.label}</span>
                  </CardBtn>
                );
              })()}

              {/* Export */}
              <CardBtn
                tooltip={t("advancedExport")}
                onClick={e => { e.stopPropagation(); setExportSite(domain); }}
              >
                <Download size={14}/>
              </CardBtn>

              {/* Tag */}
              <CardBtn
                tooltip={t("tagsPrompt")}
                active={editingTagSiteId === site.id}
                activeColor="var(--color-accent-blue)"
                onClick={e => {
                  e.stopPropagation();
                  if (editingTagSiteId === site.id) { setEditingTagSiteId(null); return; }
                  setEditingTagSiteId(site.id);
                }}
              >
                <Tag size={14}/>
              </CardBtn>

              {/* Hide / unhide */}
              <CardBtn
                tooltip={hidden.has(site.id) ? t("unhideSite") : t("hideSite")}
                active={hidden.has(site.id)}
                activeColor="var(--color-accent-blue)"
                onClick={e => { e.stopPropagation(); toggleHide(site.id); }}
              >
                <EyeOff size={14}/>
              </CardBtn>

              {/* Favourite */}
              <CardBtn
                tooltip={isFav ? t("removeFromFavorites") : t("addToFavorites")}
                active={isFav}
                activeColor="var(--color-accent-orange)"
                onClick={e => { e.stopPropagation(); toggleFav(site.id); }}
              >
                <Star size={14} fill={isFav ? "var(--color-accent-orange)" : "none"}/>
              </CardBtn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="main-content">
      <style>{`
        @keyframes gsc-spin { to { transform: rotate(360deg); } }
        .period-scroll::-webkit-scrollbar { width: 6px; }
        .period-scroll::-webkit-scrollbar-track { background: var(--color-bg-secondary, #1e2130); border-radius: 3px; }
        .period-scroll::-webkit-scrollbar-thumb { background: var(--color-border); border-radius: 3px; }
        .period-scroll::-webkit-scrollbar-thumb:hover { background: var(--color-text-secondary); }
      `}</style>

      {/* ─── Search-engine tabs ─── */}
      {altEngines.length > 0 && (
        <div style={{display:"flex",gap:"2px",background:"rgba(255,255,255,0.06)",borderRadius:"10px",padding:"3px",width:"fit-content",marginBottom:"10px"}}>
          {(["google", ...altEngines] as ("google"|"bing"|"yandex")[]).map(id => (
            <button key={id} onClick={() => setEngine(id)}
              style={{display:"inline-flex",alignItems:"center",gap:"6px",padding:"7px 15px",borderRadius:"7px",fontSize:"12px",fontWeight:700,cursor:"pointer",border:"none",background:engine===id?"var(--color-card)":"transparent",color:engine===id?"var(--color-text-primary)":"var(--color-text-secondary)"}}>
              {id==="google"?<DashGoogleIcon/>:id==="bing"?<DashBingIcon/>:<DashYandexIcon/>}
              {id==="google"?"Google":id==="bing"?"Bing":"Яндекс"}
            </button>
          ))}
        </div>
      )}

      {/* ─── Accounts bar (Google) / Engine source bar (Bing·Yandex) ─── */}
      {engine === "google" ? (accounts.length > 0 && (
        <div style={{marginBottom:"10px",padding:"10px 14px",borderRadius:"12px",background:"var(--color-card)",border:"1px solid var(--color-border)",display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap"}}>
          <span style={{fontSize:"11px",fontWeight:700,color:"var(--color-text-secondary)",textTransform:"uppercase",letterSpacing:"0.06em",whiteSpace:"nowrap",marginRight:"2px"}}>{t("googleAccountsLabel")}</span>
          <div style={{display:"flex",alignItems:"center",gap:"6px",padding:"4px 12px",borderRadius:"20px",fontSize:"12px",fontWeight:600,cursor:"default",border:"1px solid rgba(59,130,246,0.4)",background:"rgba(59,130,246,0.12)",color:"#3B82F6",whiteSpace:"nowrap"}}>
            {t("allSitesSection")} (<span style={{filter:blur?"blur(5px)":"none",transition:"filter 0.25s"}}>{sites.length}</span>)
          </div>
          {accounts.map(acc => (
            <div key={acc.id} style={{display:"flex",alignItems:"center",gap:"5px",padding:"4px 10px",borderRadius:"20px",fontSize:"12px",background:"var(--color-bg-secondary,rgba(255,255,255,0.04))",border:"1px solid var(--color-border)"}}>
              {acc.picture
                ? <img src={acc.picture} width={14} height={14} alt="" style={{borderRadius:"50%",flexShrink:0,filter:blur?"blur(5px)":"none",transition:"filter 0.25s"}} onError={e=>((e.target as HTMLImageElement).style.display="none")} />
                : <span style={{width:14,height:14,borderRadius:"50%",background:"#4b5563",display:"inline-block",flexShrink:0}}/>
              }
              <span style={{color:"var(--color-text-secondary)",maxWidth:"200px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",filter:blur?"blur(5px)":"none",transition:"filter 0.25s"}}>{acc.email}</span>
            </div>
          ))}
          <a href="/settings" style={{display:"flex",alignItems:"center",gap:"4px",padding:"4px 10px",borderRadius:"20px",fontSize:"12px",fontWeight:500,color:"#3B82F6",border:"1px solid rgba(59,130,246,0.25)",background:"transparent",textDecoration:"none",whiteSpace:"nowrap",cursor:"pointer"}}>
            {t("addGoogleAccount")}
          </a>
        </div>
      )) : (
        <div style={{marginBottom:"10px",padding:"10px 14px",borderRadius:"12px",background:"var(--color-card)",border:"1px solid var(--color-border)",display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap"}}>
          <span style={{display:"flex",alignItems:"center",gap:"6px",fontSize:"11px",fontWeight:700,color:engine==="bing"?"#00809D":"#FC3F1D",textTransform:"uppercase",letterSpacing:"0.06em",whiteSpace:"nowrap",marginRight:"2px"}}>
            {engine==="bing"?<DashBingIcon/>:<DashYandexIcon/>} {t("googleAccountsLabel").replace(/Google/gi, engine==="bing"?"Bing":"Яндекс")}
          </span>
          <div style={{display:"flex",alignItems:"center",gap:"6px",padding:"4px 12px",borderRadius:"20px",fontSize:"12px",fontWeight:600,cursor:"default",border:`1px solid ${engine==="bing"?"rgba(0,128,115,0.4)":"rgba(252,63,29,0.4)"}`,background:engine==="bing"?"rgba(0,128,115,0.12)":"rgba(252,63,29,0.12)",color:engine==="bing"?"#00809D":"#FC3F1D",whiteSpace:"nowrap"}}>
            {t("allSitesSection")} (<span style={{filter:blur?"blur(5px)":"none",transition:"filter 0.25s"}}>{activeSites.length}</span>)
          </div>
          {(engineAccounts[engine] || []).map((acc,i) => (
            <div key={i} style={{display:"flex",alignItems:"center",gap:"5px",padding:"4px 10px",borderRadius:"20px",fontSize:"12px",background:"var(--color-bg-secondary,rgba(255,255,255,0.04))",border:"1px solid var(--color-border)"}}>
              {engine==="bing"?<DashBingIcon s={12}/>:<DashYandexIcon s={12}/>}
              <span style={{color:"var(--color-text-secondary)",maxWidth:"200px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",filter:blur?"blur(5px)":"none",transition:"filter 0.25s"}}>{acc.name}</span>
            </div>
          ))}
          <a href="/settings" style={{display:"flex",alignItems:"center",gap:"4px",padding:"4px 10px",borderRadius:"20px",fontSize:"12px",fontWeight:500,color:engine==="bing"?"#00809D":"#FC3F1D",border:`1px solid ${engine==="bing"?"rgba(0,128,115,0.25)":"rgba(252,63,29,0.25)"}`,background:"transparent",textDecoration:"none",whiteSpace:"nowrap",cursor:"pointer"}}>
            + {engine==="bing"?"Bing":"Яндекс"} {t("account")}
          </a>
          {engineLoading && <><span style={{flex:1}}/><span style={{display:"inline-flex",alignItems:"center",gap:"6px",fontSize:"12px",color:"var(--color-text-secondary)"}}><Loader2 size={13} className="spin"/> {t("dashEngineLoading")}</span></>}
        </div>
      )}



      {(
        <>
          {/* ─── Period quick buttons + Metric text toggles ─── */}
          <div style={{display:"flex",alignItems:"center",gap:"6px",flexWrap:"wrap",marginBottom:"8px"}}>
        {/* Quick period buttons */}
        {(["7d","28d","3m","6m","12m","16m"] as string[]).map(p => {
          const active = period === p;
          return (
            <button key={p} onClick={() => setPeriod(p)} style={{padding:"6px 13px",borderRadius:"9999px",fontSize:"12px",fontWeight:active?700:500,cursor:"pointer",border:`1px solid ${active?"var(--color-accent-blue)":"var(--color-border)"}`,background:active?"rgba(0,102,204,0.12)":"var(--color-card)",color:active?"var(--color-accent-blue)":"var(--color-text-secondary)",transition:"all 0.15s",whiteSpace:"nowrap"}}>
              {getPeriodLabel(p)}
            </button>
          );
        })}
        {/* More periods */}
        {PeriodDd}

        <div style={{flex:1,minWidth:"8px"}}/>

        {/* Metric toggles with text labels — same icons as on cards */}
        {([
          {m:"clicks"      as Metric, icon:"✦", label:t("clicks"),      color:"#3B82F6", bg:"rgba(59,130,246,0.12)"},
          {m:"impressions" as Metric, icon:"◉", label:t("impressions"), color:"#8B5CF6", bg:"rgba(139,92,246,0.12)"},
          {m:"ctr"         as Metric, icon:"%", label:"CTR",             color:"#10B981", bg:"rgba(16,185,129,0.12)"},
          {m:"position"    as Metric, icon:"↑", label:t("avgPosition"),  color:"#F59E0B", bg:"rgba(245,158,11,0.12)"},
        ]).map(({m, icon, label, color, bg}) => {
          const active = activeMetrics.has(m);
          return (
            <button key={m} onClick={() => toggleMetric(m)} style={{display:"flex",alignItems:"center",gap:"5px",padding:"6px 13px",borderRadius:"20px",fontSize:"12px",fontWeight:active?700:500,cursor:"pointer",border:`1px solid ${active?color:"var(--color-border)"}`,background:active?bg:"var(--color-card)",color:active?color:"var(--color-text-secondary)",transition:"all 0.15s",whiteSpace:"nowrap"}}>
              <span style={{fontWeight:800,fontSize:"11px",lineHeight:1}}>{icon}</span>
              {label}
            </button>
          );
        })}
      </div>

      {/* ─── Search + Sort + Filter + Sync ─── */}
      <div style={{display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap"}}>
        <div style={{position:"relative",flex:"1 1 180px"}}>
          <Search size={14} style={{position:"absolute",left:"10px",top:"50%",transform:"translateY(-50%)",color:"var(--color-text-secondary)"}}/>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder={t("searchSites")}
            style={{width:"100%",padding:"7px 12px 7px 32px",borderRadius:"8px",border:"1px solid var(--color-border)",background:"var(--color-card)",color:"var(--color-text-primary)",fontSize:"13px",outline:"none"}}/>
        </div>
        {SortDd}
        {FilterDd}

        {/* ── Sync — the shared "refresh everything" button (GSC + Bing + Yandex) ── */}
        {<button
          onClick={handleSync}
          disabled={syncStatus === "syncing"}
          title={syncedAt ? `${t("dashLastSync")} ${syncedAt.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })} ${syncedAt.toLocaleDateString("ru", { day: "numeric", month: "short" })}` : t("dashSyncGscTitle")}
          style={{
            display: "flex", alignItems: "center", gap: "6px",
            padding: "6px 12px", borderRadius: "8px", fontSize: "12px", fontWeight: 500,
            border: "1px solid var(--color-border)",
            background: syncStatus === "done" ? "rgba(16,185,129,0.08)" : syncStatus === "syncing" ? "rgba(59,130,246,0.08)" : (syncStatus === "reauth" || syncStatus === "error") ? "rgba(239,68,68,0.08)" : "var(--color-card)",
            color: syncStatus === "done" ? "#10B981" : syncStatus === "syncing" ? "#60a5fa" : (syncStatus === "reauth" || syncStatus === "error") ? "#EF4444" : "var(--color-text-secondary)",
            cursor: syncStatus === "syncing" ? "not-allowed" : "pointer",
            whiteSpace: "nowrap", transition: "all 0.2s",
          }}
        >
          {syncStatus === "done" ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          ) : (syncStatus === "reauth" || syncStatus === "error") ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              style={{ flexShrink: 0, animation: syncStatus === "syncing" ? "gsc-spin 1.2s linear infinite" : "none" }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
          )}
          {syncStatus === "syncing" ? t("idxSyncing")
            : syncStatus === "done" ? `${t("dashDone")} · ${syncedAt?.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })}`
            : syncStatus === "reauth" ? t("dashReauthNeeded")
            : syncStatus === "error" ? t("dashSyncErrorShort")
            : syncedAt ? syncedAt.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })
            : t("dashSyncGsc")}
        </button>}
      </div>

      {/* ── Sync warning banner ── */}
      {syncWarning && (
        <div style={{ margin: "8px 0 0", padding: "10px 16px", borderRadius: "10px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", display: "flex", alignItems: "center", gap: "10px" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div style={{ flex: 1 }}>
            {syncWarning === "reauth" ? (
              <>
                <span style={{ fontSize: "13px", fontWeight: 600, color: "#EF4444" }}>{t("dashSyncFailedReauth")}</span>
                <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginLeft: "6px" }}>
                  {t("dashGoToSettings1")} <a href="/settings" style={{ color: "#3B82F6", textDecoration: "underline" }}>{t("navSettings")}</a> {t("dashGoToSettings2")}
                </span>
              </>
            ) : (
              <span style={{ fontSize: "13px", fontWeight: 600, color: "#EF4444" }}>{t("dashSyncErrorsLog")}</span>
            )}
          </div>
          <button onClick={() => setSyncWarning(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: "2px" }}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* Active filter chips */}
      {(activeFilterCount > 0 || activeTag) && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" }}>
          {activeTag && (
            <FilterChip
              label={`🏷 ${activeTag}`}
              onRemove={() => setActiveTag(null)}
            />
          )}
          {branded !== "all" && (
            <FilterChip
              label={branded === "branded" ? `✦ ${t("branded")}` : `◎ ${t("nonBranded")}`}
              onRemove={() => setBranded("all")}
            />
          )}
          {filterDimension && filterText.trim() && (
            <FilterChip
              label={`${filterDimension}: ${filterText.trim()}`}
              onRemove={() => { setFilterDimension(null); setFilterText(""); }}
            />
          )}
        </div>
      )}

      {/* ─── Totals row (respects tag/search filter) ─── */}
      {!loading && visibleForTotals.length > 0 && (
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"8px",marginTop:"12px"}}>
          {([
            {label:t("totalClicks"),      icon:"✦", color:"#3B82F6", bg:"rgba(59,130,246,0.06)", value: fmtK(totalClicks),          sub: t("fromNSites").replace("{n}", String(visibleForTotals.length))},
            {label:t("totalImpressions"), icon:"◉", color:"#8B5CF6", bg:"rgba(139,92,246,0.06)", value: fmtK(totalImpressions),      sub: t("fromNSites").replace("{n}", String(visibleForTotals.length))},
            {label:t("averageCTR"),       icon:"%", color:"#10B981", bg:"rgba(16,185,129,0.06)", value: `${avgCtr}%`,                sub: withCtr.length > 0 ? t("acrossNSites").replace("{n}", String(withCtr.length)) : t("noData")},
            {label:t("averagePosition"),  icon:"↑", color:"#F59E0B", bg:"rgba(245,158,11,0.06)", value: avgPos > 0 ? String(avgPos) : "—", sub: withPos.length > 0 ? t("acrossNSites").replace("{n}", String(withPos.length)) : t("noData")},
          ]).map(({label, icon, color, bg, value, sub}) => (
            <div key={label} style={{padding:"12px 16px",borderRadius:"12px",background:"var(--color-card)",border:"1px solid var(--color-border)"}}>
              <div style={{display:"flex",alignItems:"center",gap:"6px",marginBottom:"6px"}}>
                <span style={{fontWeight:800,fontSize:"12px",color,lineHeight:1}}>{icon}</span>
                <span style={{fontSize:"11px",color:"var(--color-text-secondary)",fontWeight:500}}>{label}</span>
              </div>
              <div style={{fontSize:"22px",fontWeight:700,color:"var(--color-text-primary)",lineHeight:1,letterSpacing:"-0.5px",filter:blur?"blur(6px)":"none",transition:"filter 0.25s"}}>{value}</div>
              <div style={{fontSize:"11px",color:"var(--color-text-secondary)",marginTop:"4px",filter:blur?"blur(5px)":"none",transition:"filter 0.25s"}}>{sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Body */}
      {(engine === "google" && loading) || (engine !== "google" && engineLoading && activeSites.length === 0) ? (
        <div style={{textAlign:"center",color:"var(--color-text-secondary)",padding:"80px 0",fontSize:"14px",display:"flex",alignItems:"center",justifyContent:"center",gap:"8px"}}>
          {engine !== "google" && <Loader2 size={16} className="spin"/>}{engine === "google" ? t("loadingSites") : t("dashEngineLoading")}
        </div>
      ) : (engine === "google" ? sites.length === 0 : activeSites.length === 0) ? (
        <div style={{textAlign:"center",color:"var(--color-text-secondary)",padding:"80px 0",fontSize:"14px"}}>
          {engine === "google"
            ? <>{t("noSitesYet")} <a href="/settings" style={{color:"var(--color-accent-purple)"}}>{t("connectGoogleAccount")}</a></>
            : t("seEngineNoData")}
        </div>
      ) : (
        <>
          {favSites.length>0 && (
            <section>
              <div style={{fontSize:"11px",color:"var(--color-text-secondary)",fontWeight:600,marginBottom:"12px",textTransform:"uppercase",letterSpacing:"0.07em"}}>⭐ {t("favoritesSection")} (<span style={{filter:blur?"blur(4px)":"none",transition:"filter 0.25s"}}>{favSites.length}</span>)</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))",gap:"12px"}}>
                {favSites.map((s,i)=><SiteCard key={s.id||i} site={s}/>)}
              </div>
            </section>
          )}
          <section>
            <div style={{fontSize:"11px",color:"var(--color-text-secondary)",fontWeight:600,marginBottom:"12px",textTransform:"uppercase",letterSpacing:"0.07em",display:"flex",alignItems:"center",gap:"8px"}}>
              <span>{t("allSitesSection")} (<span style={{filter:blur?"blur(4px)":"none",transition:"filter 0.25s"}}>{restSites.length}</span>)</span>
              {Object.keys(drMap).length > 0 && (
                <span style={{marginLeft:"auto",fontWeight:400,textTransform:"none",letterSpacing:0}}>
                  Domain Rating by <a href="https://ahrefs.com/" target="_blank" rel="noreferrer" style={{color:"var(--color-accent-blue)"}}>Ahrefs</a>
                </span>
              )}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))",gap:"12px"}}>
              {restSites.map((s,i)=><SiteCard key={s.id||i} site={s}/>)}
            </div>
          </section>

          {hiddenSites.length>0 && (
            <section>
              <div style={{fontSize:"11px",color:"var(--color-text-secondary)",fontWeight:600,marginBottom:"12px",textTransform:"uppercase",letterSpacing:"0.07em",opacity:0.6}}>🙈 {t("hiddenSection")} ({hiddenSites.length})</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))",gap:"12px",opacity:0.5}}>
                {hiddenSites.map((s,i)=><SiteCard key={s.id||i} site={s}/>)}
              </div>
            </section>
          )}

          {/* Archive — properties no longer returned by Search Console. Collapsed by
              default so replaced domains stop cluttering the dashboard, but their
              history stays in the database until deleted by hand. */}
          {archivedSites.length>0 && (
            <section style={{marginTop:"8px"}}>
              <button
                className="archive-toggle"
                onClick={()=>setShowArchive(v=>!v)}
                aria-expanded={showArchive}
              >
                <span className={showArchive ? "archive-caret open" : "archive-caret"}>▸</span>
                <span>🗄 {t("archiveSection")}</span>
                <span className="archive-count" style={{filter:blur?"blur(4px)":"none",transition:"filter 0.25s"}}>
                  {archivedSites.length}
                </span>
              </button>
              {showArchive && (
                <>
                  <div className="archive-hint">{t("archiveHint")}</div>
                  <div className="archive-list">
                    {archivedSites.map((s,i)=>(
                      <div key={s.id||i} className={archiveBusy===s.id ? "archive-row busy" : "archive-row"}>
                        <span className="archive-domain" style={{filter:blur?"blur(4px)":"none",transition:"filter 0.25s"}}>
                          {getDomain(s.url)}
                        </span>
                        {s.archivedAt && (
                          <span className="archive-date">
                            {new Date(s.archivedAt).toLocaleDateString()}
                          </span>
                        )}
                        <button
                          className="archive-btn"
                          onClick={()=>restoreSite(s.id)}
                          disabled={archiveBusy===s.id}
                        >{t("archiveRestore")}</button>
                        <button
                          className="archive-btn danger"
                          onClick={()=>deleteSite(s.id, getDomain(s.url))}
                          disabled={archiveBusy===s.id}
                        >{t("archiveDelete")}</button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}
        </>
      )}
      </>
      )}

      {/* Export modal */}
      {exportSite && <ExportModal domain={exportSite} onClose={()=>setExportSite(null)} />}
    </div>
  );
}

export default function PortfolioPage() {
  return (
    <Suspense fallback={
      <div style={{ padding: "40px", textAlign: "center", color: "var(--color-text-secondary)" }}>
        <div style={{ width: "24px", height: "24px", border: "2px solid var(--color-border)", borderTopColor: "#3B82F6", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 10px" }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        Loading page content...
      </div>
    }>
      <PortfolioPageContent />
    </Suspense>
  );
}
