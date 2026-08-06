"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { ScatterChart, Scatter, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { withShare, isGuestView } from "@/lib/shareParam";
import { getMetricsCreds } from "@/lib/seo/metricsClient";

// ─── Types ─────────────────────────────────────────────────────────────────────
type HeatMetric = "clicks" | "impressions";
type HeatPeriod = "month" | "week";

interface PageRow { url: string; vals: number[]; siteName?: string }
interface DecayRow {
  page: string; url: string;
  clicksLast2m: number; clicksLast2mPct: number;
  clicksYoY: number | null; clicks: number;
  status: "Warning" | "Critical";
  siteId?: string; siteName?: string;
}
interface DecayData {
  pages: PageRow[]; cols: string[]; years?: (number | undefined)[];
  allVals: number[]; decay: DecayRow[];
}

// ─── Color helpers ─────────────────────────────────────────────────────────────
function heatColor(val: number, max: number, threshold: number): string {
  if (max === 0 || val === 0) return "rgba(59,130,246,0.04)";
  const ratio = Math.min(1, val / max);
  if (ratio < threshold / 100) return "rgba(59,130,246,0.06)";
  const alpha = 0.12 + ratio * 0.82;
  const r = Math.round(59  + (20  - 59)  * ratio);
  const g = Math.round(130 + (70  - 130) * ratio);
  const b = Math.round(246 + (190 - 246) * ratio);
  return `rgba(${r},${g},${b},${alpha})`;
}

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ─── How it works block ────────────────────────────────────────────────────────
function HowItWorks() {
  const { t } = useLanguage();
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px",
      padding: "24px 28px", borderBottom: "1px solid var(--color-border)",
      background: "var(--color-card)",
    }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
          <div style={{ width: "28px", height: "28px", borderRadius: "6px", background: "rgba(59,130,246,0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("cdmHowItWorks")}</span>
        </div>
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "8px" }}>
          {[t("cdmHowItWorks1"), t("cdmHowItWorks2"), t("cdmHowItWorks3")].map((text, i) => (
            <li key={i} style={{ display: "flex", gap: "10px", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: "1.55" }}>
              <span style={{ width: "18px", height: "18px", borderRadius: "50%", background: "rgba(59,130,246,0.1)", color: "#3B82F6", fontSize: "11px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: "1px" }}>{i + 1}</span>
              {text}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
          <div style={{ width: "28px", height: "28px", borderRadius: "6px", background: "rgba(16,185,129,0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          </div>
          <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("cdmWhatToDo")}</span>
        </div>
        <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "8px" }}>
          {[t("cdmWhatToDo1"), t("cdmWhatToDo2"), t("cdmWhatToDo3"), t("cdmWhatToDo4")].map((text, i) => (
            <li key={i} style={{ display: "flex", gap: "10px", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: "1.55" }}>
              <span style={{ width: "18px", height: "18px", borderRadius: "50%", background: "rgba(16,185,129,0.1)", color: "#10B981", fontSize: "11px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: "1px" }}>{i + 1}</span>
              {text}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// ─── Decaying Pages Table ──────────────────────────────────────────────────────
function DecayingPagesTable({ rows }: { rows: DecayRow[] }) {
  const { t } = useLanguage();
  const [rowsPerPage, setRowsPerPage] = useState(5);
  const visible = rows.slice(0, rowsPerPage);

  const statusColor = (s: DecayRow["status"]) =>
    s === "Critical" ? "#EF4444" : "#F59E0B";

  // Demand verdicts, keyed by URL. Fetched one page at a time on click rather than for the
  // whole table: most decaying pages never get investigated, and each check is a floored
  // request whether you look at the answer or not.
  const [demand, setDemand] = useState<Record<string, { keyword: string; trendPct: number | null; err?: string }>>({});
  const [demandBusy, setDemandBusy] = useState<string | null>(null);

  async function checkDemand(row: DecayRow) {
    if (demandBusy || !row.siteId) return;
    setDemandBusy(row.url);
    try {
      const creds = getMetricsCreds();
      const res = await fetch("/api/metrics/demand", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteId: row.siteId, url: row.url,
          country: localStorage.getItem("seoMetricsCountry") || "us",
          fetch: true, provider: creds.provider, apiKey: creds.apiKey, baseUrl: creds.baseUrl, cap: creds.cap,
        }),
      });
      const d = await res.json();
      setDemand(prev => ({ ...prev, [row.url]: { keyword: d.keyword ?? "", trendPct: d.trendPct ?? null, err: d.error } }));
    } catch {
      setDemand(prev => ({ ...prev, [row.url]: { keyword: "", trendPct: null, err: "failed" } }));
    }
    setDemandBusy(null);
  }

  if (rows.length === 0) {
    return (
      <div style={{ padding: "20px 28px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-secondary)", fontSize: "13px", textAlign: "center" }}>
        No declining pages detected in this period.
      </div>
    );
  }

  return (
    <div style={{ padding: "20px 28px", borderBottom: "1px solid var(--color-border)" }}>
      <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "14px" }}>
        {t("cdmTableTitle")}
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 140px 110px 80px 120px 90px",
        padding: "8px 12px",
        background: "var(--color-bg)", borderRadius: "8px 8px 0 0",
        border: "1px solid var(--color-border)", borderBottom: "none",
        fontSize: "12px", fontWeight: 600, color: "var(--color-text-secondary)",
      }}>
        <div>{t("cdmPage")}</div>
        <div style={{ textAlign: "right" }}>{t("cdmClicksLast2m")}</div>
        <div style={{ textAlign: "right" }}>{t("cdmClicksYoY")}</div>
        <div style={{ textAlign: "right" }}>{t("clicks")}</div>
        <div style={{ textAlign: "right" }} title={t("cdmDemandHint")}>{t("cdmDemand")}</div>
        <div style={{ textAlign: "right" }}>{t("cdmStatus")}</div>
      </div>

      <div className="privacy-blur-all" style={{ border: "1px solid var(--color-border)", borderRadius: "0 0 8px 8px", overflow: "hidden" }}>
        {visible.map((row, i) => (
          <div key={row.url} style={{
            display: "grid", gridTemplateColumns: "1fr 140px 110px 80px 120px 90px",
            padding: "12px 12px",
            borderBottom: i < visible.length - 1 ? "1px solid var(--color-border)" : "none",
            background: i % 2 === 0 ? "var(--color-card)" : "rgba(255,255,255,0.02)",
            alignItems: "center", fontSize: "13px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0, overflow: "hidden" }}>
              <span style={{ color: "#3B82F6", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.url}>
                {row.page}
              </span>
              {row.siteName && (
                <span style={{ fontSize: "10px", color: "var(--color-text-secondary)", background: "rgba(255,255,255,0.06)", padding: "2px 6px", borderRadius: "4px", flexShrink: 0 }} title={row.siteName}>
                  {row.siteName}
                </span>
              )}
              {!isGuestView() && (
                <Link href={`/seo-tools/rewrite?url=${encodeURIComponent(row.url)}`} title={t("cdmRewrite")}
                  onClick={e => e.stopPropagation()}
                  style={{ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0, padding: "2px 7px", borderRadius: "6px", border: "1px solid var(--color-border)", color: "#34c759", fontSize: "10px", fontWeight: 700, textDecoration: "none" }}>
                  <RefreshCw size={11} /> {t("cdmRewrite")}
                </Link>
              )}
            </div>

            <div style={{ textAlign: "right", color: "#EF4444", fontWeight: 600 }}>
              <span style={{ fontSize: "11px" }}>↘</span>{" "}
              {Math.abs(row.clicksLast2m)} ({Math.abs(row.clicksLast2mPct)}%)
            </div>

            <div style={{ textAlign: "right" }}>
              {row.clicksYoY === null
                ? <span style={{ color: "var(--color-text-secondary)" }}>—</span>
                : <span style={{ color: row.clicksYoY < 0 ? "#EF4444" : "#10B981" }}>
                    {row.clicksYoY > 0 ? "+" : ""}{row.clicksYoY}%
                  </span>
              }
            </div>

            <div style={{ textAlign: "right", color: "var(--color-text-secondary)" }}>{row.clicks}</div>

            {/* Demand: the missing half of the diagnosis. Clicks falling with demand flat is a
                ranking problem; clicks falling with demand is the market, and no rewrite fixes
                that. Nothing is fetched until asked. */}
            <div style={{ textAlign: "right", fontSize: "12px" }}>
              {isGuestView() ? <span style={{ color: "var(--color-text-secondary)" }}>—</span>
                : demand[row.url] ? (
                  // Volume history is Ahrefs-only. Saying so beats an em dash: on Semrush the dash
                  // is indistinguishable from "we checked and demand is flat", which is the
                  // opposite of what happened. The other three Ahrefs-only screens already say
                  // this; this was the one that stayed quiet.
                  demand[row.url].err === "provider_unsupported"
                    ? <span title={t("blpAhrefsOnly")} style={{ color: "var(--color-text-tertiary)", fontSize: "11px" }}>Ahrefs</span>
                  : demand[row.url].err ? <span style={{ color: "var(--color-text-secondary)" }}>—</span>
                  : demand[row.url].trendPct == null ? <span style={{ color: "var(--color-text-secondary)" }}>—</span>
                  : (
                    <span title={demand[row.url].keyword}
                      style={{ fontWeight: 700, color: demand[row.url].trendPct! <= -15 ? "var(--color-warning)" : "var(--color-success)" }}>
                      {demand[row.url].trendPct! > 0 ? "+" : ""}{demand[row.url].trendPct}%
                      <span style={{ display: "block", fontSize: "10px", fontWeight: 400, color: "var(--color-text-secondary)" }}>
                        {demand[row.url].trendPct! <= -15 ? t("cdmDemandFalling") : t("cdmDemandStable")}
                      </span>
                    </span>
                  )
                ) : (
                  <button className="metric-chip" onClick={e => { e.stopPropagation(); checkDemand(row); }}
                    disabled={demandBusy === row.url}
                    style={{ border: "1px solid var(--color-border)", background: "transparent", fontWeight: 500, cursor: "pointer" }}>
                    {demandBusy === row.url ? "…" : t("cdmDemandLoad")}
                  </button>
                )}
            </div>

            <div style={{ textAlign: "right" }}>
              <span style={{
                display: "inline-block", padding: "3px 10px", borderRadius: "20px",
                fontSize: "12px", fontWeight: 600,
                color: statusColor(row.status),
                background: `${statusColor(row.status)}18`,
                border: `1px solid ${statusColor(row.status)}40`,
              }}>{row.status}</span>
            </div>
          </div>
        ))}

        <div style={{
          padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "var(--color-bg)", borderTop: "1px solid var(--color-border)",
          fontSize: "12px", color: "var(--color-text-secondary)",
        }}>
          <span>{t("cdmShowingRows").replace("{start}", "1").replace("{end}", String(visible.length)).replace("{total}", String(rows.length))}</span>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span>{t("cdmRowsPerPage")}</span>
            <select value={rowsPerPage} onChange={e => setRowsPerPage(Number(e.target.value))}
              style={{ padding: "3px 8px", borderRadius: "6px", fontSize: "12px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", cursor: "pointer", outline: "none" }}>
              {[5, 10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Heatmap ───────────────────────────────────────────────────────────────────
function Heatmap({
  domain, siteDbId,
}: { domain: string; siteDbId: string }) {
  const { t } = useLanguage();

  const [metric,    setMetric]    = useState<HeatMetric>("clicks");
  const [period,    setPeriod]    = useState<HeatPeriod>("month");
  const [threshold, setThreshold] = useState(30);
  const [data,      setData]      = useState<DecayData | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState("");

  const fetchData = useCallback(async (m: HeatMetric, p: HeatPeriod) => {
    if (!siteDbId) return;
    setLoading(true); setError("");
    try {
      const res = await fetch(withShare(
        `/api/gsc/decay?siteId=${encodeURIComponent(siteDbId)}&metric=${m}&period=${p}&cols=16&top=20`
      ));
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setData(json);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }, [siteDbId]);

  useEffect(() => { fetchData(metric, period); }, [metric, period, fetchData]);

  const cols    = data?.cols    ?? [];
  const years   = data?.years   ?? [];
  const pages   = data?.pages   ?? [];
  const allVals = data?.allVals ?? [];

  // Year groups for header
  const yearGroups = useMemo(() => {
    if (period !== "month" || !years.length) return [];
    const groups: { year: string; count: number }[] = [];
    let cur = String(years[0]); let cnt = 0;
    for (const y of years) {
      if (String(y) === cur) cnt++;
      else { groups.push({ year: cur, count: cnt }); cur = String(y); cnt = 1; }
    }
    if (cnt) groups.push({ year: cur, count: cnt });
    return groups;
  }, [years, period]);

  const globalMax = Math.max(0, ...allVals, ...pages.flatMap(r => r.vals));

  const cellStyle = (val: number): React.CSSProperties => ({
    width: "42px", minWidth: "42px", height: "32px",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: "10px", fontWeight: val > 0 ? 600 : 400,
    color: val > 0 ? "var(--color-text-primary)" : "rgba(255,255,255,0.2)",
    background: heatColor(val, globalMax, threshold),
    borderRadius: "4px", transition: "background 0.2s", cursor: "default",
  });

  const isEmpty = !loading && pages.length === 0 && !error;

  return (
    <div style={{ padding: "20px 28px" }}>
      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: "4px" }}>
          {(["clicks", "impressions"] as HeatMetric[]).map(m => (
            <button key={m} onClick={() => setMetric(m)} style={{
              display: "flex", alignItems: "center", gap: "6px",
              padding: "6px 13px", borderRadius: "8px", fontSize: "13px", fontWeight: 500,
              cursor: "pointer", border: `1px solid ${metric === m ? "#3B82F6" : "var(--color-border)"}`,
              background: metric === m ? "rgba(59,130,246,0.1)" : "var(--color-card)",
              color: metric === m ? "#3B82F6" : "var(--color-text-secondary)", transition: "all 0.15s",
            }}>
              {m === "clicks"
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              }
              {m === "clicks" ? t("clicks") : t("impressions")}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: "4px" }}>
          {(["month", "week"] as HeatPeriod[]).map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              padding: "6px 13px", borderRadius: "8px", fontSize: "13px", fontWeight: period === p ? 700 : 400,
              cursor: "pointer",
              background: period === p ? "#fff" : "transparent",
              color: period === p ? "#111" : "var(--color-text-secondary)",
              border: `1px solid ${period === p ? "rgba(0,0,0,0.15)" : "var(--color-border)"}`,
              transition: "all 0.15s",
            }}>{p === "month" ? t("periodMonth") : t("periodWeek")}</button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginLeft: "4px" }}>
          <span style={{ fontSize: "13px", color: "var(--color-text-secondary)", fontWeight: 500 }}>{t("cdmThreshold")}</span>
          <input type="range" min={0} max={90} step={5} value={threshold}
            onChange={e => setThreshold(Number(e.target.value))}
            style={{ width: "120px", accentColor: "#3B82F6", cursor: "pointer" }} />
          <span style={{ fontSize: "12px", color: "#3B82F6", fontWeight: 700, minWidth: "30px" }}>{threshold}%</span>
        </div>

        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
            <div style={{ width: "14px", height: "14px", border: "2px solid var(--color-border)", borderTopColor: "#3B82F6", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            Loading…
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}
      </div>

      {error && (
        <div style={{ padding: "10px 14px", borderRadius: "8px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", fontSize: "12px", color: "#f87171", marginBottom: "12px" }}>
          {error}
        </div>
      )}

      {isEmpty && (
        <div style={{ padding: "32px 0", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          No data yet — sync GSC data first to see the heatmap.
        </div>
      )}

      {/* Heatmap table */}
      {pages.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="privacy-sensitive" style={{ borderCollapse: "separate", borderSpacing: "3px", width: "100%" }}>
            <thead>
              {period === "month" && yearGroups.length > 0 && (
                <tr>
                  <th style={{ minWidth: "200px" }} />
                  {yearGroups.map(({ year, count }) => (
                    <th key={year} colSpan={count} style={{
                      textAlign: "center", fontSize: "12px", fontWeight: 700,
                      color: "var(--color-text-secondary)", paddingBottom: "4px", letterSpacing: "0.04em",
                    }}>{year}</th>
                  ))}
                  <th style={{ minWidth: "60px" }} />
                </tr>
              )}
              <tr>
                <th style={{ textAlign: "left", fontSize: "11px", color: "var(--color-text-secondary)", fontWeight: 600, paddingBottom: "6px", paddingRight: "12px", minWidth: "200px" }}>
                  {(domain || "PORTFOLIO").toUpperCase()}
                </th>
                {cols.map((c, ci) => (
                  <th key={ci} style={{ textAlign: "center", fontSize: "10px", color: "var(--color-text-secondary)", fontWeight: 500, paddingBottom: "6px", minWidth: "42px", width: "42px" }}>
                    {c}
                  </th>
                ))}
                <th style={{ textAlign: "center", fontSize: "11px", fontWeight: 700, color: "var(--color-text-secondary)", paddingBottom: "6px", paddingLeft: "8px" }}>{t("cdmTotal")}</th>
              </tr>
            </thead>
            <tbody>
              {/* All pages row */}
              <tr>
                <td style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", paddingRight: "12px", paddingBottom: "3px" }}>{t("cdmAllPages")}</td>
                {allVals.map((v, ci) => (
                  <td key={ci} style={{ padding: "1px" }}>
                    <div style={cellStyle(v)}>{fmt(v)}</div>
                  </td>
                ))}
                <td style={{ padding: "1px 1px 1px 8px" }}>
                  <div style={{ ...cellStyle(allVals.reduce((a, b) => a + b, 0)), width: "52px", minWidth: "52px", background: "rgba(59,130,246,0.15)", fontWeight: 700 }}>
                    {fmt(allVals.reduce((a, b) => a + b, 0))}
                  </div>
                </td>
              </tr>
              {/* Page rows */}
              {pages.map((p) => {
                const total = p.vals.reduce((a, b) => a + b, 0);
                return (
                  <tr key={p.url}>
                    <td style={{ fontSize: "12px", color: "#3B82F6", fontWeight: 500, paddingRight: "12px", paddingBottom: "3px", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "4px" }}>
                      <span title={p.url}>{p.url}</span>
                      {p.siteName && (
                        <span style={{ fontSize: "9px", color: "var(--color-text-secondary)", background: "rgba(255,255,255,0.05)", padding: "1px 5px", borderRadius: "3px", flexShrink: 0 }}>
                          {p.siteName}
                        </span>
                      )}
                    </td>
                    {p.vals.map((v: number, ci: number) => (
                      <td key={ci} style={{ padding: "1px" }}>
                        <div style={cellStyle(v)}>{v === 0 ? <span style={{ opacity: 0.25 }}>·</span> : fmt(v)}</div>
                      </td>
                    ))}
                    <td style={{ padding: "1px 1px 1px 8px" }}>
                      <div style={{ ...cellStyle(total), width: "52px", minWidth: "52px", fontWeight: 700 }}>{fmt(total)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Position Decay Scatter Plot ──────────────────────────────────────────────
function PositionDecayScatter({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  const [points, setPoints] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [periods, setPeriods] = useState<{ previous: string; current: string } | null>(null);

  useEffect(() => {
    if (!siteDbId) return;
    setLoading(true); setError(""); setReason("");
    fetch(withShare(`/api/gsc/decay/position?siteId=${encodeURIComponent(siteDbId)}`))
      .then(r => r.json())
      .then(d => {
        if (d.error) setError(d.error);
        else { setPoints(d.points ?? []); setReason(d.reason ?? ""); setPeriods(d.periods ?? null); }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [siteDbId]);

  if (loading) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "var(--color-text-secondary)" }}>
        <div style={{ width: "24px", height: "24px", border: "2px solid var(--color-border)", borderTopColor: "#3B82F6", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 10px" }} />
        Loading scatter plot...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "#EF4444" }}>
        Error: {error}
      </div>
    );
  }

  return (
    <div style={{ padding: "20px 28px" }}>
      <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "14px" }}>
        {t("cdmScatterTitle") || "Position Decay Scatter Plot (Last 30 Days vs Previous 30 Days)"}
      </div>
      <p style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", marginBottom: "20px", lineHeight: "1.6" }}>
        {t("cdmScatterDesc") || "X-axis is the query position 30-60 days ago. Y-axis is today's position. The diagonal represents no change. Points above the diagonal represent search queries that declined; points below improved."}
      </p>

      {periods && (
        <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "-12px", marginBottom: "16px" }}>
          {periods.previous} → {periods.current}
        </div>
      )}

      {points.length === 0 ? (
        // One generic sentence used to cover every cause. Naming the cause matters: "connect a
        // Google account" and "this site has no query with 10+ impressions in both windows" call
        // for completely different actions.
        <div style={{ padding: "40px", textAlign: "center", color: "var(--color-text-secondary)", fontSize: "13px", lineHeight: 1.6 }}>
          {reason === "no_google_account"
            ? t("cdmScatterNoAccount")
            : t("cdmScatterNoOverlap")}
        </div>
      ) : (
        <div style={{ height: "420px", background: "var(--color-bg)", borderRadius: "8px", padding: "16px", border: "1px solid var(--color-border)" }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis 
                type="number" 
                dataKey="prevPos" 
                name="Position 30d Ago" 
                domain={[1, 100]} 
                reversed={true}
                tick={{ fill: "var(--color-text-secondary)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis 
                type="number" 
                dataKey="currPos" 
                name="Current Position" 
                domain={[1, 100]} 
                reversed={true}
                tick={{ fill: "var(--color-text-secondary)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip 
                cursor={{ strokeDasharray: '3 3' }} 
                contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const data = payload[0].payload;
                    const diff = data.currPos - data.prevPos;
                    return (
                      <div style={{ padding: "8px 12px" }}>
                        <div style={{ fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "4px" }}>{data.query}</div>
                        <div style={{ color: "var(--color-text-secondary)" }}>{t("prevPosition") || "Position 30d Ago"}: <b style={{ color: "var(--color-text-primary)" }}>{data.prevPos}</b></div>
                        <div style={{ color: "var(--color-text-secondary)" }}>{t("currPosition") || "Current Position"}: <b style={{ color: "var(--color-text-primary)" }}>{data.currPos}</b></div>
                        <div style={{ marginTop: "4px", color: diff > 0 ? "#EF4444" : "#10B981", fontWeight: 600 }}>
                          {diff > 0 ? `Dropped by ${diff.toFixed(1)} positions` : diff < 0 ? `Improved by ${Math.abs(diff).toFixed(1)} positions` : "No change"}
                        </div>
                        <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "4px" }}>Clicks: {data.clicks.toLocaleString()} | Impr: {data.impressions.toLocaleString()}</div>
                      </div>
                    );
                  }
                  return null;
                }}
              />
              <Scatter name="Queries" data={points}>
                {points.map((entry, index) => {
                  const isDecayed = entry.currPos > entry.prevPos;
                  const isCritical = isDecayed && (entry.currPos - entry.prevPos >= 5);
                  const color = isCritical ? "#EF4444" : isDecayed ? "#F59E0B" : "#10B981";
                  return <Cell key={`cell-${index}`} fill={color} style={{ cursor: "pointer" }} />;
                })}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ─── Main export ───────────────────────────────────────────────────────────────
export default function ContentDecayMap({ domain, siteDbId }: { domain: string; siteDbId: string }) {
  const { t } = useLanguage();

  const [metric,    setMetric]    = useState<HeatMetric>("clicks");
  const [period,    setPeriod]    = useState<HeatPeriod>("month");
  const [data,      setData]      = useState<DecayData | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [view,      setView]      = useState<"heatmap" | "scatter">("heatmap");
  // The portfolio page passes "all"; the scatter is a single-property view (see the toggle below).
  const isPortfolio = siteDbId === "all";

  const fetchData = useCallback(async (m: HeatMetric, p: HeatPeriod) => {
    if (!siteDbId) return;
    setLoading(true);
    try {
      const res = await fetch(withShare(
        `/api/gsc/decay?siteId=${encodeURIComponent(siteDbId)}&metric=${m}&period=${p}&cols=16&top=20`
      ));
      const json = await res.json();
      if (res.ok) setData(json);
    } catch {}
    setLoading(false);
  }, [siteDbId]);

  useEffect(() => { fetchData(metric, period); }, [metric, period, fetchData]);

  return (
    <div style={{
      border: "1px solid var(--color-border)", borderRadius: "12px",
      overflow: "hidden", marginTop: "20px", background: "var(--color-card)",
    }}>
      <HowItWorks />
      <DecayingPagesTable rows={data?.decay ?? []} />
      
      {/* Toggle View buttons.
          The scatter plots one site's queries by rank, which only means something within a single
          property: position 3 on one site and position 30 on another describe different SERPs and
          share no axis. On the portfolio page it would also fan out into two live Search Console
          calls per site. Offering it there would be both misleading and slow, so it is offered
          only where it applies. */}
      <div style={{ display: "flex", gap: "10px", padding: "16px 28px", borderBottom: "1px solid var(--color-border)", background: "rgba(255,255,255,0.01)", alignItems: "center" }}>
        {(isPortfolio ? (["heatmap"] as const) : (["heatmap", "scatter"] as const)).map(v => (
          <button key={v} onClick={() => setView(v)} style={{
            padding: "6px 16px", borderRadius: "8px", fontSize: "13px", fontWeight: 600,
            cursor: "pointer", border: `1px solid ${view === v ? "#3B82F6" : "var(--color-border)"}`,
            background: view === v ? "rgba(59,130,246,0.1)" : "transparent",
            color: view === v ? "#3B82F6" : "var(--color-text-secondary)", transition: "all 0.15s"
          }}>
            {v === "heatmap" ? (t("cdmViewHeatmap") || "Heatmap View") : (t("cdmViewScatter") || "Decay Scatter Plot")}
          </button>
        ))}
        {isPortfolio && (
          <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{t("cdmScatterPerSiteOnly")}</span>
        )}
      </div>

      {view === "heatmap" || isPortfolio ? (
        <Heatmap domain={domain} siteDbId={siteDbId} />
      ) : (
        <PositionDecayScatter siteDbId={siteDbId} />
      )}
    </div>
  );
}
