"use client";

// Alternative search-engine view for the site dashboard: when the engine switcher is
// set to Bing or Yandex, this replaces the GSC chart block with LIVE data from that
// engine's webmaster API. Shows everything the APIs give: clicks, impressions, CTR,
// weighted average position, traffic chart, top queries (and top pages + index/crawl
// stats for Bing, SQI + site diagnostics for Yandex). Refetches when the Sync-all
// button bumps refreshKey. Setup guide: docs/SEARCH-ENGINES-SETUP.md.

import { useEffect, useMemo, useState } from "react";
import { ComposedChart, Line, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Loader2, AlertTriangle, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { severityMeta, problemLabel } from "@/lib/yandexDiagnostics";
import { resolveEngineKey } from "@/lib/engineKeys";
import { withShare, isGuestView } from "@/lib/shareParam";
import { buildCandleRows } from "@/lib/chartCandles";
import { CandlePanes, useChartTypePref } from "@/components/CandleChartParts";

export type AltEngine = "bing" | "yandex";
export type EngineMetric = "clicks" | "impressions" | "ctr" | "position";

const card: React.CSSProperties = { background: "var(--color-card)", borderRadius: "12px", padding: "16px", border: "1px solid var(--color-border)" };

interface Row { key: string; clicks: number; impressions: number; position?: number }
interface Point { date: string; clicks: number; impressions: number; ctr: number; position: number | null }
type CmpPoint = Point & { clicksC: number | null; impressionsC: number | null; ctrC: number | null; positionC: number | null };

// Lifted to the parent so it can render the same compact KPI row (with period-over-period
// deltas) that the Google view shows in the header.
export interface EngineSummary {
  clicks: number; impressions: number; ctr: number; position: number | null;
  dClicks: number; dImpr: number; dCtr: number; dPos: number; hasCmp: boolean;
}

// Chart tooltip that shows only the current period (hides the dashed comparison series).
// Reads the whole datum rather than payload dataKeys: the position series use function dataKeys
// whose stringification is not a field name.
function EngTooltip({ active, payload, label, t }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload ?? {};
  const rows = [
    { key: "clicks", v: d.clicks },
    { key: "impressions", v: d.impressions },
    { key: "ctr", v: d.ctr },
    { key: "position", v: d.position },
  ].filter(r => r.v != null);
  if (!rows.length) return null;
  const nm = (k: string) => k === "ctr" ? "CTR" : k === "position" ? t("avgPosition") : k === "clicks" ? t("clicks") : t("impressions");
  const fmt = (k: string, v: any) => k === "ctr" ? `${v}%` : k === "position" ? Number(v).toFixed(1) : Number(v).toLocaleString();
  return (
    <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "8px", fontSize: "12px", padding: "8px 10px" }}>
      <div style={{ fontWeight: 600, marginBottom: "4px", color: "var(--color-text-primary)" }}>{label}</div>
      {rows.map(r => (
        <div key={r.key} style={{ color: "var(--color-text-primary)" }}>{nm(r.key)}: {fmt(r.key, r.v)}</div>
      ))}
    </div>
  );
}

// Bing's OData JSON dates arrive as "/Date(1610000000000)/" OR with a timezone offset
// "/Date(1760166000000-0700)/" — parse the millisecond epoch, ignore the offset suffix.
function parseBingDate(v: any): string {
  const m = String(v ?? "").match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
  const d = m ? new Date(parseInt(m[1], 10)) : new Date(v);
  return isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
}

const pct = (clicks: number, impr: number) => (impr ? `${(Math.round((clicks / impr) * 1000) / 10).toFixed(1)}%` : "—");

// CSV download (mirrors the Google tables' exporter).
function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const lines = [headers.join(","), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Same metric colors as the Google (GSC) chart so the Bing/Yandex view feels identical.
const EC: Record<EngineMetric, string> = {
  clicks: "#3B82F6",       // blue
  impressions: "#8B5CF6",  // purple
  ctr: "#10B981",          // green
  position: "#F59E0B",     // amber
};

type SortKey = "key" | "clicks" | "impressions" | "ctr" | "position";

function StatCard({ val, label, hint }: { val: string | number; label: string; hint?: string }) {
  return (
    <div style={card} title={hint}>
      <div style={{ fontSize: "22px", fontWeight: 800, color: "var(--color-text-primary)" }}>{val}</div>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: "4px" }}>
        {label}
        {hint && <span style={{ width: 13, height: 13, borderRadius: "50%", border: "1px solid var(--color-border)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "9px", fontWeight: 700, cursor: "help", flexShrink: 0 }}>i</span>}
      </div>
    </div>
  );
}

const PER_PAGE = 10;

function RowsTable({ title, rows, keyLabel, t, csvName }: { title: string; rows: Row[]; keyLabel: string; t: any; csvName: string }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "clicks", dir: "desc" });
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    const val = (r: Row, k: SortKey) => k === "key" ? r.key.toLowerCase() : k === "ctr" ? (r.impressions ? r.clicks / r.impressions : 0) : k === "position" ? (r.position ?? 999) : (r as any)[k] ?? 0;
    return [...rows].sort((a, b) => {
      const va = val(a, sort.key), vb = val(b, sort.key);
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [rows, sort]);

  const pageCount = Math.ceil(sorted.length / PER_PAGE);
  const pageRows = sorted.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  const setSortKey = (k: SortKey) => { setSort(s => s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "key" || k === "position" ? "asc" : "desc" }); setPage(0); };

  if (!rows.length) return null;

  const Th = ({ k, label, align = "right" }: { k: SortKey; label: string; align?: "left" | "right" }) => (
    <th onClick={() => setSortKey(k)} style={{ padding: align === "left" ? "8px 16px" : "8px 8px", fontWeight: 600, textAlign: align, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", color: sort.key === k ? "var(--color-accent-blue)" : "var(--color-text-secondary)" }}>
      {label}{sort.key === k ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
    </th>
  );

  return (
    <div style={{ ...card, padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 16px", borderBottom: "1px solid var(--color-border)" }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{sorted.length}</div>
          <button onClick={() => downloadCsv(csvName, [keyLabel, t("clicks"), t("impressions"), "CTR", t("avgPosition")], sorted.map(r => [r.key, r.clicks, r.impressions, pct(r.clicks, r.impressions), r.position != null ? Number(r.position).toFixed(1) : ""]))}
            title={t("exportCsv")} style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "4px 10px", borderRadius: "7px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>
            <Download size={12} /> {t("exportCsv")}
          </button>
        </div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <Th k="key" label={keyLabel} align="left" />
            <Th k="clicks" label={t("clicks")} />
            <Th k="impressions" label={t("impressions")} />
            <Th k="ctr" label="CTR" />
            <Th k="position" label={t("avgPosition")} />
          </tr>
        </thead>
        <tbody>
          {pageRows.map(r => (
            <tr key={r.key} style={{ borderTop: "1px solid var(--color-border)" }}>
              <td style={{ padding: "7px 16px", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-text-primary)" }}>{r.key}</td>
              <td style={{ padding: "7px 8px", textAlign: "right", fontWeight: 600, color: "var(--color-text-primary)" }}>{r.clicks.toLocaleString()}</td>
              <td style={{ padding: "7px 8px", textAlign: "right", color: "var(--color-text-secondary)" }}>{r.impressions.toLocaleString()}</td>
              <td style={{ padding: "7px 8px", textAlign: "right", color: "var(--color-text-secondary)" }}>{pct(r.clicks, r.impressions)}</td>
              <td style={{ padding: "7px 16px", textAlign: "right", color: "var(--color-text-secondary)" }}>{r.position != null ? Number(r.position).toFixed(1) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {pageCount > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", padding: "10px", borderTop: "1px solid var(--color-border)" }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={{ background: "none", border: "none", cursor: page === 0 ? "default" : "pointer", color: page === 0 ? "var(--color-border)" : "var(--color-text-secondary)", display: "flex" }}><ChevronLeft size={16} /></button>
          <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{page + 1} / {pageCount}</span>
          <button onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1} style={{ background: "none", border: "none", cursor: page >= pageCount - 1 ? "default" : "pointer", color: page >= pageCount - 1 ? "var(--color-border)" : "var(--color-text-secondary)", display: "flex" }}><ChevronRight size={16} /></button>
        </div>
      )}
    </div>
  );
}

export default function EngineView({ engine, domain, siteDbId, refreshKey, metrics, days, onSummary }: { engine: AltEngine; domain: string; siteDbId: string; refreshKey: number; metrics?: Set<string>; days?: number; onSummary?: (s: EngineSummary | null) => void }) {
  const { t, language } = useLanguage() as any;
  const lang = (language === "ru" || language === "uk" ? language : "en") as "en" | "ru" | "uk";
  // Which metric lines to draw — driven by the shared toolbar toggles; default: all on.
  const active = metrics ?? new Set<string>(["clicks", "impressions", "ctr", "position"]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [series, setSeries] = useState<Point[]>([]);
  const [queries, setQueries] = useState<Row[]>([]);
  const [pages, setPages] = useState<Row[]>([]);
  const [meta, setMeta] = useState<Record<string, any>>({});
  const [problems, setProblems] = useState<{ code: string; severity: string }[]>([]);
  const [tab, setTab] = useState<"queries" | "pages">("queries");

  const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/.*$/, "");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr("");
      try {
        const guest = isGuestView();
        if (engine === "bing") {
          // Owner: key from localStorage. Guest (share link): resolved server-side from the
          // owner's saved settings via the shareToken, so no client key is needed.
          const apiKey = guest ? "" : resolveEngineKey("bing", siteDbId);
          if (!guest && !apiKey) { setErr(t("seNeedKey")); setLoading(false); return; }
          const url = withShare(`/api/indexing/bing?siteUrl=${encodeURIComponent(`https://${cleanDomain}/`)}&siteId=${encodeURIComponent(siteDbId)}${apiKey ? `&apiKey=${encodeURIComponent(apiKey)}` : ""}`);
          const d = await fetch(url).then(r => r.json());
          if (cancelled) return;
          if (d.error) { setErr(String(d.error)); }
          else {
            // Bing's JSON keys are PascalCase but casing/shape has drifted across API
            // versions — read defensively (any-case) so a renamed field never blanks the view.
            const g = (o: any, ...keys: string[]) => { for (const k of keys) { if (o?.[k] != null) return o[k]; const lk = Object.keys(o ?? {}).find(x => x.toLowerCase() === k.toLowerCase()); if (lk != null && o[lk] != null) return o[lk]; } return undefined; };
            const num = (v: any) => { const n = Number(v); return isFinite(n) ? n : 0; };
            setSeries((d.traffic ?? []).map((r: any) => {
              const clicks = num(g(r, "Clicks")), impressions = num(g(r, "Impressions"));
              const posv = Number(g(r, "AvgImpressionPosition", "AvgClickPosition", "Position"));
              return { date: parseBingDate(g(r, "Date")), clicks, impressions, ctr: impressions ? Math.round((clicks / impressions) * 1000) / 10 : 0, position: isFinite(posv) && posv > 0 ? Math.round(posv * 10) / 10 : null };
            }));
            setQueries((d.queries ?? []).slice(0, 25).map((q: any) => ({ key: String(g(q, "Query") ?? ""), clicks: num(g(q, "Clicks")), impressions: num(g(q, "Impressions")), position: g(q, "AvgImpressionPosition", "AvgClickPosition", "Position") })));
            setPages((d.pages ?? []).slice(0, 25).map((p: any) => ({ key: String(g(p, "Query", "Page", "Url") ?? "").replace(/^https?:\/\/[^/]+/, "") || "/", clicks: num(g(p, "Clicks")), impressions: num(g(p, "Impressions")), position: g(p, "AvgImpressionPosition", "Position") })));
            const cr = d.crawl;
            const crawlErrors = cr ? num(g(cr, "Code4xx", "Code400")) + num(g(cr, "Code5xx", "Code500")) || g(cr, "CrawlErrors") : undefined;
            setMeta({ inIndex: cr ? g(cr, "InIndex") : undefined, crawlErrors, blockedByRobots: cr ? g(cr, "BlockedByRobotsTxt") : undefined });
            setProblems([]);
          }
        } else {
          const token = guest ? "" : resolveEngineKey("yandex", siteDbId);
          if (!guest && !token) { setErr(t("seNeedToken")); setLoading(false); return; }
          const url = withShare(`/api/indexing/yandex?siteUrl=${encodeURIComponent(cleanDomain)}&siteId=${encodeURIComponent(siteDbId)}&days=56${token ? `&token=${encodeURIComponent(token)}` : ""}`);
          const d = await fetch(url).then(r => r.json());
          if (cancelled) return;
          if (d.error) { setErr(d.error === "host_not_found" ? t("seYandexHostNotFound") : d.error === "host_not_verified" ? t("seYandexHostNotVerified") : String(d.error)); }
          else {
            setSeries((d.series ?? []).map((r: any) => {
              const clicks = Number(r.clicks) || 0, impressions = Number(r.impressions) || 0;
              return { date: String(r.date).slice(0, 10), clicks, impressions, ctr: impressions ? Math.round((clicks / impressions) * 1000) / 10 : 0, position: r.position != null ? Number(r.position) : null };
            }));
            setQueries((d.queries ?? []).map((q: any) => ({ key: q.query_text, clicks: q.indicators?.TOTAL_CLICKS ?? 0, impressions: q.indicators?.TOTAL_SHOWS ?? 0, position: q.indicators?.AVG_SHOW_POSITION ?? undefined })));
            setPages([]);
            setMeta({ sqi: d.summary?.sqi, inSearch: d.summary?.searchable_pages_count, excluded: d.summary?.excluded_pages_count });
            setProblems(d.problems ?? []);
          }
        }
      } catch (e: any) { if (!cancelled) setErr(String(e?.message ?? e)); }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [engine, cleanDomain, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Trim trailing "lag" days that have no data reported yet, so the chart ends at the last
  // real day (like the Google view) instead of flat-lining to today. Interior zeros stay.
  const trimmed = useMemo(() => {
    let end = series.length;
    while (end > 0 && series[end - 1].clicks === 0 && series[end - 1].impressions === 0) end--;
    return series.slice(0, end);
  }, [series]);

  const win = days && days > 0 ? days : trimmed.length;
  const curArr = useMemo(() => trimmed.slice(-win), [trimmed, win]);
  const prevArr = useMemo(() => trimmed.slice(-2 * win, -win), [trimmed, win]);

  // Merge the current window with the previous equal-length window so the chart can draw a
  // dashed "previous period" line in the same colors (matching the Google comparison).
  const view = useMemo<CmpPoint[]>(() => {
    const off = curArr.length - prevArr.length; // align a shorter prev window to the tail
    return curArr.map((p, i) => {
      const c = prevArr[i - off];
      return { ...p, clicksC: c?.clicks ?? null, impressionsC: c?.impressions ?? null, ctrC: c?.ctr ?? null, positionC: c?.position ?? null };
    });
  }, [curArr, prevArr]);

  // Candlestick view (Settings → Preferences), same as the Google chart. Engine dates are already
  // ISO strings, so the label and the snap date are the same field.
  const chartTypePref = useChartTypePref();
  const candleMode = chartTypePref === "candle";
  const candleData = useMemo(() => buildCandleRows(
    view,
    [
      { key: "clicks",      value: r => r.clicks,      prev: r => r.clicksC },
      { key: "impressions", value: r => r.impressions, prev: r => r.impressionsC },
      { key: "ctr",         value: r => r.ctr,         prev: r => r.ctrC },
      { key: "position",    value: r => r.position,    prev: r => r.positionC },
    ],
    r => r.date,
    r => r.date,
  ), [view]);

  const sumK = (arr: Point[], k: "clicks" | "impressions") => arr.reduce((s, r) => s + (r[k] || 0), 0);
  const totClicks = sumK(curArr, "clicks"), totImpr = sumK(curArr, "impressions");
  const prevClicks = sumK(prevArr, "clicks"), prevImpr = sumK(prevArr, "impressions");
  const anyPos = view.some(p => p.position != null);
  const anyCmp = prevArr.length > 0 && view.some(p => p.clicksC != null || p.impressionsC != null);

  // Impression-weighted average position from the daily series when present, else the
  // top-query approximation (neither API exposes a sitewide daily position for every day).
  const dailyPos = (arr: Point[]) => {
    const pts = arr.filter(p => p.position != null && p.impressions > 0);
    return pts.length ? pts.reduce((s, p) => s + (p.position as number) * p.impressions, 0) / pts.reduce((s, p) => s + p.impressions, 0) : null;
  };
  const posRows = queries.filter(q => q.position != null && q.impressions > 0);
  const wAvgPosQ = posRows.length ? (posRows.reduce((s, q) => s + (q.position as number) * q.impressions, 0) / posRows.reduce((s, q) => s + q.impressions, 0)) : null;
  const curPos = dailyPos(curArr) ?? wAvgPosQ;
  const prevPos = dailyPos(prevArr);
  const curCtr = totImpr ? (totClicks / totImpr) * 100 : 0;
  const prevCtr = prevImpr ? (prevClicks / prevImpr) * 100 : 0;
  const pctChg = (cur: number, prev: number) => (prev ? Math.round(((cur - prev) / prev) * 100) : 0);

  // Push the summary + deltas up so the parent header can render the same KPI row as Google.
  useEffect(() => {
    if (loading || err || !series.length) { onSummary?.(null); return; }
    onSummary?.({
      clicks: totClicks, impressions: totImpr, ctr: Math.round(curCtr * 100) / 100, position: curPos != null ? Math.round(curPos * 10) / 10 : null,
      dClicks: pctChg(totClicks, prevClicks), dImpr: pctChg(totImpr, prevImpr), dCtr: pctChg(curCtr, prevCtr),
      dPos: curPos != null && prevPos != null ? pctChg(curPos, prevPos) : 0, hasCmp: prevArr.length > 0,
    });
  }, [loading, err, totClicks, totImpr, curCtr, curPos, prevClicks, prevImpr, prevCtr, prevPos, series.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Clear the lifted summary when this view unmounts (switching back to Google).
  useEffect(() => () => onSummary?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div style={{ ...card, textAlign: "center", padding: "48px" }}><Loader2 size={20} className="spin" style={{ color: "var(--color-text-secondary)" }} /></div>;
  if (err) return (
    <div style={{ ...card, display: "flex", alignItems: "center", gap: "8px", color: "#f87171", fontSize: "13px", flexWrap: "wrap" }}>
      <AlertTriangle size={14} /> {err} — <a href={`/settings?tab=${engine}`} style={{ color: "var(--color-accent-blue)" }}>{engine === "bing" ? t("seNeedKey") : t("seNeedToken")}</a>
      <a href="https://github.com/fenjo26/opengsc/blob/main/docs/SEARCH-ENGINES-SETUP.md" target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)" }}>{t("seSetupGuide")}</a>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px" }}>
        <StatCard val={totClicks.toLocaleString()} label={t("clicks")} />
        <StatCard val={totImpr.toLocaleString()} label={t("impressions")} />
        <StatCard val={pct(totClicks, totImpr)} label="CTR" />
        {curPos != null && <StatCard val={`≈ ${curPos.toFixed(1)}`} label={t("avgPosition")} hint={t("seAvgPosNote")} />}
        {meta.sqi != null && <StatCard val={meta.sqi} label={t("seSqiLabel")} />}
        {meta.inSearch != null && <StatCard val={Number(meta.inSearch).toLocaleString()} label={t("seYandexInSearch")} />}
        {meta.excluded != null && <StatCard val={Number(meta.excluded).toLocaleString()} label={t("seYandexExcluded")} />}
        {meta.inIndex != null && <StatCard val={Number(meta.inIndex).toLocaleString()} label={t("seBingInIndex")} />}
        {meta.crawlErrors != null && <StatCard val={Number(meta.crawlErrors).toLocaleString()} label={t("seBingCrawlErrors")} />}
      </div>

      {/* Empty state — connected but no data yet (e.g. freshly verified site) */}
      {!series.length && !queries.length && (
        <div style={{ ...card, textAlign: "center", padding: "28px", color: "var(--color-text-secondary)", fontSize: "13px" }}>
          {t("seEngineNoData")}
        </div>
      )}

      {/* Yandex site diagnostics */}
      {problems.length > 0 && (
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("seYandexProblems")}</div>
          {problems.map(p => {
            const sev = severityMeta(p.severity, lang);
            return (
              <div key={p.code} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}>
                <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "5px", background: sev.bg, color: sev.color, whiteSpace: "nowrap", flexShrink: 0 }}>{sev.label}</span>
                <span style={{ color: "var(--color-text-primary)" }}>{problemLabel(p.code, lang)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Chart — identical to the GSC view: clicks + impressions as filled areas, CTR &
          average position as lines; candles when the operator picked them in Preferences.
          Which metrics show is driven by the shared toolbar toggles (same 4 icon buttons
          as Google), so the two views behave the same. */}
      {view.length > 0 && (
        <div style={card}>
          {candleMode ? (
            <CandlePanes
              rows={candleData}
              metrics={(["clicks", "impressions", "ctr", "position"] as EngineMetric[])
                .filter(m => active.has(m) && (m !== "position" || anyPos))
                .map(m => ({
                  key: m,
                  color: EC[m],
                  kind: m === "ctr" ? "pct" as const : m === "position" ? "pos" as const : "count" as const,
                  label: m === "ctr" ? "CTR" : m === "position" ? t("avgPosition") : m === "clicks" ? t("clicks") : t("impressions"),
                }))}
              showPrev={anyCmp}
              height={active.size > 2 ? 340 : 260}
            />
          ) : (
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={view as any} margin={{ top: 8, right: 4, bottom: 0, left: -8 }}>
              <defs>
                {(["clicks", "impressions"] as EngineMetric[]).map(m => (
                  <linearGradient key={m} id={`eng-${m}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={EC[m]} stopOpacity={0.18} />
                    <stop offset="100%" stopColor={EC[m]} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }} axisLine={false} tickLine={false} minTickGap={24} />
              <YAxis yAxisId="left" tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }} axisLine={false} tickLine={false} width={40} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }} axisLine={false} tickLine={false} width={44} />
              {/* Position's own hidden axis, reversed so rank 1 sits at the top (same as the
                  Google view). */}
              <YAxis yAxisId="pos" reversed hide domain={[1, "dataMax"]} />
              <Tooltip
                content={<EngTooltip t={t} />}
              />
              <>
              {/* Previous-period comparison (dashed, thin, same colors) — drawn underneath. */}
              {anyCmp && active.has("clicks") && <Line yAxisId="left" type="monotone" dataKey="clicksC" stroke={EC.clicks} strokeWidth={1} strokeDasharray="4 3" dot={false} connectNulls legendType="none" />}
              {anyCmp && active.has("impressions") && <Line yAxisId="right" type="monotone" dataKey="impressionsC" stroke={EC.impressions} strokeWidth={1} strokeDasharray="4 3" dot={false} connectNulls legendType="none" />}
              {anyCmp && active.has("ctr") && <Line yAxisId="left" type="monotone" dataKey="ctrC" stroke={EC.ctr} strokeWidth={1} strokeDasharray="4 3" dot={false} connectNulls legendType="none" />}
              {anyCmp && active.has("position") && anyPos && <Line yAxisId="pos" type="monotone" dataKey={(d: CmpPoint) => d.positionC ?? null} stroke={EC.position} strokeWidth={1} strokeDasharray="4 3" dot={false} connectNulls legendType="none" />}
              {active.has("clicks") && <Area yAxisId="left" type="monotone" dataKey="clicks" name={t("clicks")} stroke={EC.clicks} strokeWidth={2} fill="url(#eng-clicks)" dot={false} />}
              {active.has("impressions") && <Area yAxisId="right" type="monotone" dataKey="impressions" name={t("impressions")} stroke={EC.impressions} strokeWidth={2} fill="url(#eng-impressions)" dot={false} />}
              {active.has("ctr") && <Line yAxisId="left" type="monotone" dataKey="ctr" name="CTR" stroke={EC.ctr} strokeWidth={1.5} dot={false} />}
              {active.has("position") && anyPos && <Line yAxisId="pos" type="monotone" dataKey={(d: CmpPoint) => d.position ?? null} name={t("avgPosition")} stroke={EC.position} strokeWidth={1.5} dot={false} connectNulls />}
              </>
            </ComposedChart>
          </ResponsiveContainer>
          )}
        </div>
      )}

      {/* Queries / Pages */}
      {pages.length > 0 && (
        <div style={{ display: "flex", gap: "2px", background: "rgba(255,255,255,0.06)", borderRadius: "8px", padding: "3px", width: "fit-content" }}>
          {(["queries", "pages"] as const).map(id => (
            <button key={id} onClick={() => setTab(id)}
              style={{ padding: "5px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: tab === id ? "var(--color-card)" : "transparent", color: tab === id ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}>
              {id === "queries" ? t("seTopQueries") : t("seTopPages")}
            </button>
          ))}
        </div>
      )}
      {tab === "queries" || !pages.length
        ? <RowsTable title={`${t("seTopQueries")} — ${engine === "bing" ? "Bing" : t("seEngineYandex")}`} rows={queries} keyLabel={t("seQuery")} t={t} csvName={`${engine}-queries-${cleanDomain}.csv`} />
        : <RowsTable title={`${t("seTopPages")} — Bing`} rows={pages} keyLabel="URL" t={t} csvName={`${engine}-pages-${cleanDomain}.csv`} />}
    </div>
  );
}
