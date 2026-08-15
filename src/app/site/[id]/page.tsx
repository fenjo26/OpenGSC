"use client";

import { Fragment, useState, useMemo, useRef, useEffect, useCallback } from "react";
import ContentDecayMap from "@/components/ContentDecayMap";
import KeywordCannibalization from "@/components/KeywordCannibalization";
import StrikingDistanceKeywords from "@/components/StrikingDistanceKeywords";
import SiteSettingsTab from "@/components/SiteSettingsTab";
import CtrBenchmark from "@/components/CtrBenchmark";
import { SiteHealthPanel } from "@/components/SiteHealthPanel";
import { ClarityPanel } from "@/components/ClarityPanel";
import RankTracker from "@/components/RankTracker";
import SiteAuditPanel from "@/components/SiteAuditPanel";
import EngineView, { type AltEngine, type EngineSummary } from "@/components/EngineView";
import SearchEnginesPanel from "@/components/SearchEnginesPanel";
import { withShare } from "@/lib/shareParam";
import { loadSyncedAt, rememberSyncedAt, fetchSyncState, watchSync, type SyncState } from "@/lib/syncedAt";
import AeoTracker from "@/components/AeoTracker";
import {
  ALGO_UPDATES, ALGO_UPDATE_COLORS, snapToChartLabel, snapBackToChartLabel, updateEnd,
  algoChartLabel, algoImpact, withNeighbours, type AlgoImpactResult,
  type AlgoUpdate, type AlgoUpdateType,
} from "@/lib/algoUpdates";
import { useParams, useRouter } from "next/navigation";
import { usePrivacy } from "@/lib/PrivacyContext";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getTaskCreds, getAhrefsDrKey } from "@/lib/seo/keys";
import TrafficChip from "@/components/TrafficChip";
import BacklinkProfile from "@/components/BacklinkProfile";
import {
  ArrowLeft, Sparkles, Eye, Percent, MoveUp,
  SlidersHorizontal, ChevronDown, Smartphone, Monitor, Tablet,
  Users, Activity, Zap, DollarSign, Link2, Check,
  FileText, Globe, Search, ArrowLeftRight, BookmarkCheck, Calendar, X, Download,
  ChevronLeft, ChevronRight, ExternalLink, Pencil, Trash2,
} from "lucide-react";
import {
  ComposedChart, LineChart, AreaChart, Area, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, ReferenceLine, ReferenceArea,
} from "recharts";

// ─── Types ────────────────────────────────────────────────────────────────────
type Metric = "clicks" | "impressions" | "ctr" | "position";

// ─── Colors ───────────────────────────────────────────────────────────────────
const C = {
  clicks:      "#3B82F6",
  impressions: "#8B5CF6",
  ctr:         "#10B981",
  position:    "#F59E0B",
};

// ─── Period options (module-level so all sub-components can reference) ────────
// `label` holds an i18n KEY, not display text — the constant is module-level (above any React
// context), so it cannot call t() itself. Every render site wraps it: t(opt.label). This keeps
// the shared list in one place while each dropdown translates for the active language.
const PERIOD_OPTIONS: { key: string; label: string }[] = [
  { key: "yesterday",    label: "periodOneDayLatest" },
  { key: "7d",           label: "period7Days"         },
  { key: "14d",          label: "period14Days"         },
  { key: "28d",          label: "period28Days"        },
  { key: "last_week",    label: "periodLastWeek"      },
  { key: "this_month",   label: "periodThisMonth"     },
  { key: "last_month",   label: "periodLastMonth"     },
  { key: "this_quarter", label: "periodThisQuarter"   },
  { key: "last_quarter", label: "periodLastQuarter"   },
  { key: "ytd",          label: "periodYtd"           },
  { key: "3m",           label: "period3Months"       },
  { key: "6m",           label: "period6Months"       },
  { key: "8m",           label: "period8Months"       },
  { key: "12m",          label: "period12Months"      },
  { key: "16m",          label: "period16Months"      },
  { key: "2y",           label: "period2Years"        },
  { key: "3y",           label: "period3Years"        },
];

const PERIOD_GROUPS = [
  ["7d", "14d", "28d", "last_week", "this_month", "last_month"],
  ["this_quarter", "last_quarter", "ytd", "3m", "6m", "8m", "12m", "16m"],
  ["2y", "3y"],
];

// Approximate trailing-day count for a period key — used to slice the Bing/Yandex series
// so the shared period dropdown affects those charts too.
function periodToDays(period: string): number {
  switch (period) {
    case "yesterday": return 1;
    case "7d": case "last_week": return 7;
    case "14d": return 14;
    case "28d": return 28;
    case "this_month": case "last_month": return 30;
    case "this_quarter": case "last_quarter": case "3m": return 90;
    case "6m": return 180;
    case "8m": return 240;
    case "ytd": return Math.max(7, Math.ceil((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000));
    case "12m": return 365;
    case "16m": return 480;
    case "2y": return 730;
    case "3y": return 1095;
    default: return 28;
  }
}

// Known Google algorithm updates now live in src/lib/algoUpdates.ts
// (typed core/spam/discover list with per-type colors, sundios-style).

// ─── Country code helpers (GSC returns ISO 3166-1 alpha-3 codes) ──────────────
const ISO3_TO_ISO2: Record<string, string> = {
  grc:"gr", usa:"us", cyp:"cy", tur:"tr", mkd:"mk", swe:"se", ita:"it",
  srb:"rs", irl:"ie", gbr:"gb", deu:"de", fra:"fr", esp:"es", pol:"pl",
  rou:"ro", nld:"nl", bel:"be", aut:"at", che:"ch", prt:"pt", nor:"no",
  dnk:"dk", fin:"fi", cze:"cz", hun:"hu", bgr:"bg", hrv:"hr", svk:"sk",
  svn:"si", alb:"al", bih:"ba", mne:"me", mda:"md", ltu:"lt", lva:"lv",
  est:"ee", rus:"ru", ukr:"ua", blr:"by", geo:"ge", arm:"am", aze:"az",
  aus:"au", can:"ca", bra:"br", arg:"ar", mex:"mx", chn:"cn", jpn:"jp",
  kor:"kr", ind:"in", idn:"id", pak:"pk", sau:"sa", are:"ae", isr:"il",
  egy:"eg", zaf:"za", nga:"ng", ken:"ke", mar:"ma", col:"co", chl:"cl",
  per:"pe", tha:"th", vnm:"vn", phl:"ph", mys:"my", sgp:"sg", nzl:"nz",
  irn:"ir", irq:"iq", lbn:"lb", jor:"jo", kwt:"kw", qat:"qa", bhr:"bh",
  omn:"om", dza:"dz", tun:"tn", lby:"ly", sdn:"sd", eth:"et", tza:"tz",
  uga:"ug", gha:"gh", cmr:"cm", ven:"ve", ecu:"ec", ury:"uy", pry:"py",
  bol:"bo", gtm:"gt", cri:"cr", pan:"pa", dom:"do", cub:"cu", hti:"ht",
  twn:"tw", hkg:"hk", lka:"lk", bgd:"bd", npl:"np", mmr:"mm", khm:"kh",
  lao:"la", mnl:"ph", uzb:"uz", kaz:"kz", tkm:"tm", tad:"tj", kgz:"kg",
  afg:"af", pse:"ps", yem:"ye", syr:"sy",
};

const ISO3_NAMES: Record<string, string> = {
  grc:"Greece", usa:"United States", cyp:"Cyprus", tur:"Türkiye",
  mkd:"North Macedonia", swe:"Sweden", ita:"Italy", srb:"Serbia",
  irl:"Ireland", gbr:"United Kingdom", deu:"Germany", fra:"France",
  esp:"Spain", pol:"Poland", rou:"Romania", nld:"Netherlands",
  bel:"Belgium", aut:"Austria", che:"Switzerland", prt:"Portugal",
  nor:"Norway", dnk:"Denmark", fin:"Finland", cze:"Czech Republic",
  hun:"Hungary", bgr:"Bulgaria", hrv:"Croatia", svk:"Slovakia",
  svn:"Slovenia", alb:"Albania", bih:"Bosnia", mne:"Montenegro",
  mda:"Moldova", ltu:"Lithuania", lva:"Latvia", est:"Estonia",
  rus:"Russia", ukr:"Ukraine", blr:"Belarus", geo:"Georgia",
  arm:"Armenia", aze:"Azerbaijan", aus:"Australia", can:"Canada",
  bra:"Brazil", arg:"Argentina", mex:"Mexico", chn:"China",
  jpn:"Japan", kor:"South Korea", ind:"India", idn:"Indonesia",
  pak:"Pakistan", sau:"Saudi Arabia", are:"UAE", isr:"Israel",
  egy:"Egypt", zaf:"South Africa", nga:"Nigeria", ken:"Kenya",
  mar:"Morocco", col:"Colombia", chl:"Chile", per:"Peru",
  tha:"Thailand", vnm:"Vietnam", phl:"Philippines", mys:"Malaysia",
  sgp:"Singapore", nzl:"New Zealand", irn:"Iran", irq:"Iraq",
  lbn:"Lebanon", jor:"Jordan", kwt:"Kuwait", qat:"Qatar",
  dza:"Algeria", tun:"Tunisia", ven:"Venezuela",
};

function iso3ToFlag(code: string): string {
  const iso2 = ISO3_TO_ISO2[code.toLowerCase()];
  if (!iso2) return "🌐";
  return [...iso2.toUpperCase()].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join("");
}

// ISO3 → localized country name. Intl.DisplayNames translates an ISO2 (region) code into the
// active UI language natively in the browser — no per-country keys in the locale files for ~80
// countries. The static ISO3_NAMES table stays as the fallback for an unknown code or an older
// engine without DisplayNames, so the function never returns empty.
//
// DisplayNames is typed here locally (not via lib.dom) because the TS lib version bundled with
// this project does not ship it, so the cast avoids `any` without claiming a runtime that isn't
// feature-checked at the call site.
interface DisplayNamesCtor {
  new (locale?: string, options?: { type: string }): { of: (code: string) => string };
}
function iso3ToName(code: string, locale?: string): string {
  const iso3 = code.toLowerCase();
  const iso2 = ISO3_TO_ISO2[iso3];
  const DN = (Intl as { DisplayNames?: DisplayNamesCtor }).DisplayNames;
  if (iso2 && typeof Intl !== "undefined" && typeof DN === "function") {
    try {
      const dn = new DN(locale || undefined, { type: "region" });
      const name = dn.of(iso2.toUpperCase());
      if (name && name !== iso2.toUpperCase()) return name;
    } catch { /* fall through to the static table */ }
  }
  return ISO3_NAMES[iso3] ?? code.toUpperCase();
}

// ─── Mock data ────────────────────────────────────────────────────────────────
function rnd(lo: number, hi: number) { return lo + Math.random() * (hi - lo); }
function rndInt(lo: number, hi: number) { return Math.round(rnd(lo, hi)); }

function makeChartData(days = 7) {
  const today = new Date();
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today); d.setDate(today.getDate() - days + i);
    const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const clicks = rndInt(5, 30);
    const impr   = rndInt(100, 500);
    return {
      date: label,
      clicks, impressions: impr,
      ctr:      +((clicks / impr) * 100).toFixed(1),
      position: +rnd(4, 20).toFixed(1),
      clicksC:      rndInt(3, 25),
      impressionsC: rndInt(80, 400),
      ctrC:      +rnd(2, 12).toFixed(1),
      positionC: +rnd(5, 22).toFixed(1),
    };
  });
}

const QUERIES = [
  "μασαζ στο σπιτι θεσσαλονικη","λεμφικο μασαζ θεσσαλονικη","μασαζ κατοικον θεσσαλονίκη",
  "erotic massage thessaloniki","μασαζ κατοικον θεσσαλονικη","relaxing massage thessaloniki",
  "therapeutic massage","thai massage thessaloniki","deep tissue massage","sports massage greece",
];
const PAGES = [
  "/masaz-kat-oikon-thessaloniki/","/en/massage-thessaloniki/",
  "/masaz-sto-spiti-thessaloniki-kat-oikon-therapeia/","/",
  "/to-kalytero-lemfiko-masaz-thessaloniki/","/sports-massage/",
  "/thai-massage/","/deep-tissue-massage/",
];
const COUNTRIES = [
  { name: "Greece", flag: "🇬🇷" },{ name: "Cyprus", flag: "🇨🇾" },
  { name: "Türkiye", flag: "🇹🇷" },{ name: "North Macedonia", flag: "🇲🇰" },
  { name: "Sweden", flag: "🇸🇪" },{ name: "Italy", flag: "🇮🇹" },
  { name: "Serbia", flag: "🇷🇸" },{ name: "Ireland", flag: "🇮🇪" },
];

function makeRows(labels: string[], baseClicks: number) {
  return labels.map((label, i) => {
    const clicks = Math.max(0, Math.round(baseClicks * Math.exp(-i * 0.3) * (0.7 + Math.random() * 0.6)));
    const impr   = clicks * rndInt(5, 25);
    const ctr    = impr > 0 ? +((clicks / impr) * 100).toFixed(1) : 0;
    const pos    = +rnd(1, 30).toFixed(1);
    const cPct   = rndInt(-20, 300);
    const iPct   = rndInt(-10, 200);
    return { label, clicks, impr, ctr, pos, cPct, iPct };
  });
}

function makeCountryRows() {
  return COUNTRIES.map(({ name, flag }, i) => {
    const clicks = Math.max(0, rndInt(1, 130) * Math.exp(-i * 0.3) | 0);
    const impr   = clicks * rndInt(8, 20);
    const ctr    = impr > 0 ? +((clicks / impr) * 100).toFixed(1) : 0;
    const pos    = +rnd(4, 25).toFixed(1);
    return { name, flag, clicks, impr, ctr, pos, cPct: rndInt(0, 200), iPct: rndInt(10, 400) };
  });
}

// ─── Shared components ────────────────────────────────────────────────────────
function Change({ pct, invert = false }: { pct: number; invert?: boolean }) {
  const good = invert ? pct <= 0 : pct >= 0;
  const color = good ? "#10B981" : "#EF4444";
  const sign = pct >= 0 ? "+" : "";
  return (
    <span style={{ fontSize: "11px", color, fontWeight: 500, marginLeft: "3px" }}>
      {sign}{pct}%
    </span>
  );
}

function fmtK(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

// Tab values are always English internally; TabBar translates display labels
function TabBar({ tabs, active, onChange }: { tabs: string[]; active: string; onChange: (t: string) => void }) {
  const { t } = useLanguage();
  const labelMap: Record<string, string> = {
    "All":        t("tabAll"),
    "Growing":    t("tabGrowing"),
    "Decaying":   t("tabDecaying"),
    "Trend":      t("tabTrend"),
    "Comparison": t("tabComparison"),
    "Total":      t("tabTotal"),
    "By Ranking": t("tabByRanking"),
    "Queries":    t("queriesTable"),
    "Pages":      t("pagesTable"),
  };
  return (
    <div style={{ display: "flex", gap: "2px", background: "var(--color-card)", borderRadius: "8px", padding: "3px", border: "1px solid var(--color-border)" }}>
      {tabs.map(tab => (
        <button key={tab} onClick={() => onChange(tab)} style={{
          padding: "4px 12px", borderRadius: "6px", fontSize: "12px", fontWeight: 500, cursor: "pointer",
          background: active === tab ? "var(--color-bg)" : "transparent",
          color: active === tab ? "var(--color-text-primary)" : "var(--color-text-secondary)",
          border: "none", boxShadow: active === tab ? "0 1px 3px rgba(0,0,0,0.2)" : "none",
          transition: "all 0.15s",
        }}>{labelMap[tab] ?? tab}</button>
      ))}
    </div>
  );
}

const PAGE_SIZE = 10;

function exportCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  const lines = [headers.join(","), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function Pagination({ page, total, pageSize, onChange }: { page: number; total: number; pageSize: number; onChange: (p: number) => void }) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "10px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
      <span>{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}</span>
      <div style={{ display: "flex", gap: "4px" }}>
        <button onClick={() => onChange(page - 1)} disabled={page === 1}
          style={{ padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: page === 1 ? "var(--color-text-secondary)" : "var(--color-text-primary)", cursor: page === 1 ? "default" : "pointer", opacity: page === 1 ? 0.4 : 1, display: "flex", alignItems: "center" }}>
          <ChevronLeft size={13} />
        </button>
        {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
          let p = i + 1;
          if (totalPages > 5) {
            if (page <= 3) p = i + 1;
            else if (page >= totalPages - 2) p = totalPages - 4 + i;
            else p = page - 2 + i;
          }
          return (
            <button key={p} onClick={() => onChange(p)}
              style={{ padding: "4px 8px", borderRadius: "6px", border: `1px solid ${p === page ? "#3B82F6" : "var(--color-border)"}`, background: p === page ? "rgba(59,130,246,0.12)" : "var(--color-card)", color: p === page ? "#3B82F6" : "var(--color-text-primary)", cursor: "pointer", fontWeight: p === page ? 600 : 400, minWidth: "28px" }}>
              {p}
            </button>
          );
        })}
        <button onClick={() => onChange(page + 1)} disabled={page === totalPages}
          style={{ padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: page === totalPages ? "var(--color-text-secondary)" : "var(--color-text-primary)", cursor: page === totalPages ? "default" : "pointer", opacity: page === totalPages ? 0.4 : 1, display: "flex", alignItems: "center" }}>
          <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}

type DtSortCol = "clicks" | "impr" | "ctr" | "pos";

function DataTable({ title, rows, blur = false, csvFilename, onTrack, tracked }: {
  title: string;
  rows: { label: string; clicks: number; impr: number; ctr: number; pos: number; cPct: number; iPct: number }[];
  blur?: boolean;
  csvFilename?: string;
  /** Rank tracker: adds a per-row "Track" button (queries table only) */
  onTrack?: (label: string) => void;
  tracked?: Set<string>;
  /** @deprecated kept for call-site compatibility */
  tabs?: string[];
}) {
  const { t } = useLanguage();
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sortCol,  setSortCol]  = useState<DtSortCol>("clicks");
  const [sortDir,  setSortDir]  = useState<"asc" | "desc">("desc");

  const handleSort = (col: DtSortCol) => {
    if (sortCol === col) {
      setSortDir(d => d === "desc" ? "asc" : "desc");
    } else {
      setSortCol(col);
      setSortDir(col === "pos" ? "asc" : "desc");
    }
    setPage(1);
  };

  const sorted = [...rows].sort((a, b) => {
    const v = sortDir === "desc" ? -1 : 1;
    return (a[sortCol] - b[sortCol]) * v;
  });
  const paged = sorted.slice((page - 1) * pageSize, page * pageSize);

  const handlePageSize = (n: number) => { setPageSize(n); setPage(1); };

  const handleCSV = () => {
    exportCSV(
      csvFilename ?? `${title.toLowerCase().replace(/\s+/g, "-")}.csv`,
      ["Query/Page", "Clicks", "Impressions", "CTR%", "Position", "Clicks%Change", "Impr%Change"],
      sorted.map(r => [r.label, r.clicks, r.impr, r.ctr, r.pos, r.cPct, r.iPct])
    );
  };

  // Sortable column header helper
  const SortTh = ({ col, label, color }: { col: DtSortCol; label: string; color: string }) => {
    const active = sortCol === col;
    const arrow = active ? (sortDir === "desc" ? " ↓" : " ↑") : " ↕";
    return (
      <th onClick={() => handleSort(col)}
        style={{ textAlign: "left", padding: "8px 8px", color: active ? color : "var(--color-text-secondary)", fontWeight: active ? 700 : 500, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", fontSize: "11px", letterSpacing: "0.04em" }}>
        {label}<span style={{ opacity: active ? 1 : 0.35, marginLeft: "2px" }}>{arrow}</span>
      </th>
    );
  };

  // Totals row
  const totalClicks = rows.reduce((s, r) => s + r.clicks, 0);
  const totalImpr   = rows.reduce((s, r) => s + r.impr, 0);
  const avgPos      = rows.length ? (rows.reduce((s, r) => s + r.pos, 0) / rows.length) : 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{title}</h3>
        <button onClick={handleCSV} title={t("exportCsv")}
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "4px", padding: "4px 10px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "12px", cursor: "pointer" }}>
          <Download size={12} /> {t("exportCsv")}
        </button>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
            <th style={{ textAlign: "left", padding: "8px 8px 8px 0", color: "var(--color-text-secondary)", fontWeight: 500, fontSize: "11px", letterSpacing: "0.04em" }}>{title === t("queriesTable") ? t("colQuery") : t("colPage")}</th>
            <SortTh col="clicks" label={t("clicks").toUpperCase()}      color={C.clicks} />
            <SortTh col="impr"   label={t("impressions").toUpperCase()} color={C.impressions} />
            <SortTh col="ctr"    label="CTR"                            color={C.ctr} />
            <SortTh col="pos"    label={t("position").toUpperCase()}    color={C.position} />
          </tr>
        </thead>
        <tbody>
          {paged.map((r, i) => (
            <tr key={i} style={{ borderBottom: "1px solid var(--color-border)", background: i % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent" }}>
              <td style={{ padding: "8px 8px 8px 0", color: "var(--color-text-primary)", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {onTrack && (
                  tracked?.has(r.label.toLowerCase()) ? (
                    <span title={t("rankTracked")} style={{ display: "inline-flex", marginRight: "6px", color: "#10B981", verticalAlign: "middle" }}>
                      <BookmarkCheck size={13} />
                    </span>
                  ) : (
                    <button onClick={() => onTrack(r.label)} title={t("rankTrack")}
                      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "18px", height: "18px", marginRight: "6px", borderRadius: "4px", border: "1px solid var(--color-border)", background: "none", color: "var(--color-text-secondary)", cursor: "pointer", fontSize: "12px", lineHeight: 1, verticalAlign: "middle", padding: 0 }}
                      onMouseEnter={e => { e.currentTarget.style.color = "#3B82F6"; e.currentTarget.style.borderColor = "#3B82F6"; }}
                      onMouseLeave={e => { e.currentTarget.style.color = "var(--color-text-secondary)"; e.currentTarget.style.borderColor = "var(--color-border)"; }}>
                      +
                    </button>
                  )
                )}
                <span style={blur ? { filter: "blur(5px)", userSelect: "none", transition: "filter 0.25s", display: "inline-block" } : { transition: "filter 0.25s" }}>
                  {r.label}
                </span>
              </td>
              <td style={{ padding: "8px 8px", color: "var(--color-text-primary)", fontWeight: 500 }}>{r.clicks}<Change pct={r.cPct} /></td>
              <td style={{ padding: "8px 8px", color: "var(--color-text-secondary)" }}>{fmtK(r.impr)}<Change pct={r.iPct} /></td>
              <td style={{ padding: "8px 8px", color: "var(--color-text-secondary)" }}>{r.ctr}%</td>
              <td style={{ padding: "8px 0",  color: "var(--color-text-secondary)" }}>{r.pos}</td>
            </tr>
          ))}
          {/* Totals row */}
          {rows.length > 0 && (
            <tr style={{ borderTop: "2px solid var(--color-border)", background: "rgba(255,255,255,0.03)" }}>
              <td style={{ padding: "8px 8px 8px 0", fontSize: "12px", fontWeight: 700, color: "var(--color-text-secondary)" }}></td>
              <td style={{ padding: "8px 8px", fontWeight: 700, color: "var(--color-text-primary)" }}>{fmtK(totalClicks)}</td>
              <td style={{ padding: "8px 8px", fontWeight: 700, color: "var(--color-text-primary)" }}>{fmtK(totalImpr)}</td>
              <td style={{ padding: "8px 8px", color: "var(--color-text-secondary)" }}></td>
              <td style={{ padding: "8px 0",  fontWeight: 700, color: "var(--color-text-primary)" }}>{avgPos.toFixed(1)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {/* Rows-per-page + pagination */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", marginTop: "10px", gap: "16px" }}>
        <Pagination page={page} total={sorted.length} pageSize={pageSize} onChange={setPage} />
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <span>{t("rowsPerPage")}</span>
          <select value={pageSize} onChange={e => handlePageSize(Number(e.target.value))}
            style={{ fontSize: "12px", padding: "3px 6px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", cursor: "pointer" }}>
            {[10, 50, 100, 500].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}

type CountryRow = { name: string; flag?: string; clicks: number; impr: number; ctr: number; pos: number; cPct: number; iPct: number };
function CountryTable({ rows }: { rows: CountryRow[] }) {
  const { t, language } = useLanguage();
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sortCol,  setSortCol]  = useState<DtSortCol>("clicks");
  const [sortDir,  setSortDir]  = useState<"asc"|"desc">("desc");

  const handleSort = (col: DtSortCol) => {
    if (sortCol === col) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortCol(col); setSortDir(col === "pos" ? "asc" : "desc"); }
    setPage(1);
  };

  const sorted = [...rows].sort((a, b) => (a[sortCol] - b[sortCol]) * (sortDir === "desc" ? -1 : 1));
  const paged = sorted.slice((page - 1) * pageSize, page * pageSize);

  const handleCSV = () => {
    exportCSV("countries.csv",
      ["Country", "Clicks", "Impressions", "CTR%", "Position"],
      sorted.map(r => [r.flag ? r.name : iso3ToName(r.name, language), r.clicks, r.impr, r.ctr, r.pos])
    );
  };

  const SortTh = ({ col, label, color }: { col: DtSortCol; label: string; color: string }) => {
    const active = sortCol === col;
    const arrow = active ? (sortDir === "desc" ? " ↓" : " ↑") : " ↕";
    return (
      <th onClick={() => handleSort(col)}
        style={{ textAlign: "left", padding: "8px 8px", color: active ? color : "var(--color-text-secondary)", fontWeight: active ? 700 : 500, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", fontSize: "11px", letterSpacing: "0.04em" }}>
        {label}<span style={{ opacity: active ? 1 : 0.35, marginLeft: "2px" }}>{arrow}</span>
      </th>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px", minHeight: "30px" }}>
        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("countries")}</h3>
        <button onClick={handleCSV}
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "4px", padding: "4px 10px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "12px", cursor: "pointer" }}>
          <Download size={12} /> {t("exportCsv")}
        </button>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
            <th style={{ textAlign: "left", padding: "8px 0", color: "var(--color-text-secondary)", fontWeight: 500, fontSize: "11px" }}></th>
            <SortTh col="clicks" label={t("clicks").toUpperCase()}      color={C.clicks} />
            <SortTh col="impr"   label={t("impressions").toUpperCase()} color={C.impressions} />
            <SortTh col="ctr"    label="CTR"                            color={C.ctr} />
            <SortTh col="pos"    label={t("position").toUpperCase()}    color={C.position} />
          </tr>
        </thead>
        <tbody>
          {paged.map((r, i) => {
            const flag = r.flag || iso3ToFlag(r.name);
            const label = r.flag ? r.name : iso3ToName(r.name, language);
            return (
              <tr key={i} style={{ borderBottom: "1px solid var(--color-border)", background: i % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent" }}>
                <td style={{ padding: "8px 8px 8px 0", color: "var(--color-text-primary)" }}>{flag} {label}</td>
                <td style={{ padding: "8px 8px", fontWeight: 500, color: "var(--color-text-primary)" }}>{r.clicks}<Change pct={r.cPct} /></td>
                <td style={{ padding: "8px 8px", color: "var(--color-text-secondary)" }}>{fmtK(r.impr)}<Change pct={r.iPct} /></td>
                <td style={{ padding: "8px 8px", color: "var(--color-text-secondary)" }}>{r.ctr}%</td>
                <td style={{ padding: "8px 0",  color: "var(--color-text-secondary)" }}>{r.pos}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", marginTop: "10px", gap: "16px" }}>
        <Pagination page={page} total={sorted.length} pageSize={pageSize} onChange={setPage} />
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <span>{t("rowsPerPage")}</span>
          <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
            style={{ fontSize: "12px", padding: "3px 6px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", cursor: "pointer" }}>
            {[10, 50, 100, 500].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}

type DeviceRow = { name: string; clicks: number; impr: number; ctr: number; pos: number; cPct: number; iPct: number; ctrPct: number; posDelta: number };
function DeviceTable({ rows }: { rows: DeviceRow[] }) {
  const { t } = useLanguage();
  const iconFor = (name: string) => {
    const n = name.toLowerCase();
    if (n === "mobile")  return <Smartphone size={14} />;
    if (n === "tablet")  return <Tablet size={14} />;
    return <Monitor size={14} />;
  };
  const labelFor = (name: string) => {
    const n = name.toLowerCase();
    if (n === "mobile")  return t("deviceMobile");
    if (n === "tablet")  return t("deviceTablet");
    if (n === "desktop") return t("deviceDesktop");
    return name;
  };
  const devices = rows.length > 0 ? rows : [];
  const [tab, setTab] = useState("All");
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("devices")}</h3>
        <TabBar tabs={["All", "Growing", "Decaying"]} active={tab} onChange={setTab} />
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
            <th style={{ textAlign: "left", padding: "8px 0", color: "var(--color-text-secondary)", fontWeight: 500 }}></th>
            <th style={{ textAlign: "left", padding: "8px 8px", color: C.clicks, fontWeight: 600 }}>{t("clicks")}</th>
            <th style={{ textAlign: "left", padding: "8px 8px", color: C.impressions, fontWeight: 600 }}>{t("impressions")}</th>
            <th style={{ textAlign: "left", padding: "8px 8px", color: C.ctr, fontWeight: 600 }}>CTR</th>
            <th style={{ textAlign: "left", padding: "8px 0", color: C.position, fontWeight: 600 }}>{t("position")}</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d, i) => (
            <tr key={i} style={{ borderBottom: "1px solid var(--color-border)", background: i % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent" }}>
              <td style={{ padding: "8px 8px 8px 0", display: "flex", alignItems: "center", gap: "6px", color: "var(--color-text-primary)" }}>
                {iconFor(d.name)} {labelFor(d.name)}
              </td>
              <td style={{ padding: "8px 8px", fontWeight: 500, color: "var(--color-text-primary)" }}>{d.clicks}<Change pct={d.cPct} /></td>
              <td style={{ padding: "8px 8px", color: "var(--color-text-secondary)" }}>{fmtK(d.impr)}<Change pct={d.iPct} /></td>
              <td style={{ padding: "8px 8px", color: "var(--color-text-secondary)" }}>{d.ctr}%<Change pct={d.ctrPct} /></td>
              <td style={{ padding: "8px 0", color: "var(--color-text-secondary)" }}>{d.pos}<Change pct={d.posDelta} invert /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Placeholder({ icon, title, desc, onClick }: { icon: React.ReactNode; title: string; desc: string; onClick?: () => void }) {
  return (
    <div style={{ border: "1px dashed var(--color-border)", borderRadius: "12px", padding: "40px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", background: "var(--color-card)" }}>
      <div style={{ color: "var(--color-text-secondary)" }}>{icon}</div>
      <p style={{ fontWeight: 600, color: "var(--color-text-primary)", fontSize: "14px" }}>{title}</p>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
        <span style={{ color: "#3B82F6", cursor: onClick ? "pointer" : "default" }} onClick={onClick}>{desc}</span>
      </p>
    </div>
  );
}

// ─── Cluster Table ────────────────────────────────────────────────────────────
type ClusterRow = {
  id: string; name: string;
  clicks: number; impressions: number; ctr: number; position: number;
  clicksChange: number; impressionsChange: number; ctrChange: number; positionChange: number;
};

function ClusterTable({ title, data, blur = false }: { title: string; data: ClusterRow[]; blur?: boolean }) {
  const { t } = useLanguage();
  const [tab, setTab]     = useState<'All' | 'Growing' | 'Decaying'>('All');
  const [sortBy, setSortBy] = useState<'clicks' | 'impressions' | 'ctr' | 'position'>('clicks');
  const blurStyle: React.CSSProperties = blur ? { filter: 'blur(6px)', userSelect: 'none' } : {};

  const visible = data
    .filter(r => tab === 'All' || (tab === 'Growing' ? r.clicksChange > 0 : r.clicksChange < 0))
    .sort((a, b) => {
      if (sortBy === 'position') return a.position - b.position;
      return (b as any)[sortBy] - (a as any)[sortBy];
    });

  const fmtN = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const badge = (chg: number, invert = false) => {
    if (chg === 0) return null;
    const good = invert ? chg < 0 : chg > 0;
    return (
      <span style={{ fontSize: '10px', fontWeight: 600, color: good ? '#10B981' : '#EF4444', marginLeft: '4px' }}>
        {chg > 0 ? '↑' : '↓'}{Math.abs(chg)}%
      </span>
    );
  };

  const th = (label: string, key: typeof sortBy) => (
    <th
      onClick={() => setSortBy(key)}
      style={{ padding: '6px 8px', fontSize: '11px', fontWeight: 600, color: sortBy === key ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap', textAlign: 'right', userSelect: 'none' }}
    >
      <span style={{ color: sortBy === key ? '#3B82F6' : undefined }}>{label}</span>
    </th>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--color-text-primary)' }}>{title}</h3>
        <div style={{ display: 'flex', gap: '2px', background: 'var(--color-bg)', borderRadius: '8px', padding: '2px', border: '1px solid var(--color-border)' }}>
          {/* loop var renamed `t` → `tabKey`: the old name shadowed the translation function `t`,
              which is why these labels rendered as raw English ('All'/'Growing'/'Decaying') instead
              of ever going through i18n. tabKey is the value identifier; the label is a separate t() lookup. */}
          {(['All', 'Growing', 'Decaying'] as const).map(tabKey => (
            <button key={tabKey} onClick={() => setTab(tabKey)} style={{ padding: '3px 10px', borderRadius: '6px', border: 'none', fontSize: '11px', fontWeight: 500, cursor: 'pointer', background: tab === tabKey ? 'var(--color-card)' : 'transparent', color: tab === tabKey ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}>
              {tabKey === 'All' ? t('tabAll') : tabKey === 'Growing' ? t('tabGrowing') : t('tabDecaying')}
            </button>
          ))}
        </div>
      </div>
      {visible.length === 0 ? (
        <div style={{ padding: '24px', textAlign: 'center', fontSize: '13px', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)', borderRadius: '10px' }}>{t('clusterNoData')}</div>
      ) : (
        <div style={{ border: '1px solid var(--color-border)', borderRadius: '10px', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--color-bg)' }}>
                <th style={{ padding: '6px 10px', textAlign: 'left', fontSize: '11px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>{t('colName')}</th>
                {th(t('clicks'), 'clicks')}
                {th(t('impressions'), 'impressions')}
                {th(t('colCtr'), 'ctr')}
                {th(t('position'), 'position')}
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--color-border)', background: i % 2 === 0 ? 'var(--color-card)' : 'var(--color-bg)' }}>
                  <td style={{ padding: '7px 10px', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-primary)', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...blurStyle }}>{r.name}</td>
                  <td style={{ padding: '7px 8px', textAlign: 'right', fontSize: '12px', color: 'var(--color-text-primary)', ...blurStyle }}>{fmtN(r.clicks)}{badge(r.clicksChange)}</td>
                  <td style={{ padding: '7px 8px', textAlign: 'right', fontSize: '12px', color: 'var(--color-text-secondary)', ...blurStyle }}>{fmtN(r.impressions)}{badge(r.impressionsChange)}</td>
                  <td style={{ padding: '7px 8px', textAlign: 'right', fontSize: '12px', color: 'var(--color-text-secondary)', ...blurStyle }}>{r.ctr}%{badge(r.ctrChange)}</td>
                  <td style={{ padding: '7px 8px', textAlign: 'right', fontSize: '12px', color: 'var(--color-text-secondary)', ...blurStyle }}>{r.position || '—'}{badge(r.positionChange, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── One-Click Setup Modal ────────────────────────────────────────────────────
type SetupItem = { name: string; rules: string; count: number; selected: boolean; editingName?: boolean };

// ─── Editable item card (cluster or group) ────────────────────────────────────
function SetupCard({ item, index, onToggle, onRename, onDelete, onPatternChange, ruleType }: {
  item: SetupItem; index: number;
  onToggle: () => void; onRename: (name: string) => void;
  onDelete: () => void; onPatternChange: (val: string) => void;
  ruleType: 'cluster' | 'group';
}) {
  const { t } = useLanguage();
  const [editName, setEditName] = useState(false);
  const [nameVal, setNameVal]   = useState(item.name);

  let patterns: string[] = [];
  let patternType = 'contains';
  try { const r = JSON.parse(item.rules); patterns = r[0]?.values ?? []; patternType = r[0]?.type ?? 'contains'; } catch {}
  const patternStr = patterns.join(' | ');

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: '10px', padding: '12px 14px', background: item.selected ? 'var(--color-bg)' : 'transparent', opacity: item.selected ? 1 : 0.55, transition: 'opacity 0.15s' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
        <input type="checkbox" checked={item.selected} onChange={onToggle} style={{ accentColor: '#3B82F6', width: '15px', height: '15px', flexShrink: 0 }} />
        {editName ? (
          <input
            autoFocus value={nameVal}
            onChange={e => setNameVal(e.target.value)}
            onBlur={() => { onRename(nameVal || item.name); setEditName(false); }}
            onKeyDown={e => { if (e.key === 'Enter') { onRename(nameVal || item.name); setEditName(false); } if (e.key === 'Escape') setEditName(false); }}
            style={{ flex: 1, fontSize: '13px', fontWeight: 600, border: '1px solid #3B82F6', borderRadius: '6px', padding: '2px 8px', background: 'var(--color-card)', color: 'var(--color-text-primary)', outline: 'none' }}
          />
        ) : (
          <span
            onClick={() => { setEditName(true); setNameVal(item.name); }}
            title={t("clickToEditName")}
            style={{ fontSize: '13px', fontWeight: 600, cursor: 'text', flex: 1, borderBottom: '1px dashed transparent' }}
            onMouseEnter={e => (e.currentTarget.style.borderBottomColor = 'var(--color-text-secondary)')}
            onMouseLeave={e => (e.currentTarget.style.borderBottomColor = 'transparent')}
          >
            {item.name}
          </span>
        )}
        <span style={{ fontSize: '11px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{item.count} {ruleType === 'cluster' ? 'queries' : 'pages'}</span>
        <button onClick={onDelete} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', padding: '2px', display: 'flex', opacity: 0.6, flexShrink: 0 }}>
          <X size={13} />
        </button>
      </div>
      <div style={{ paddingLeft: '23px' }}>
        <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>{patternType}: </span>
        <input
          value={patternStr}
          onChange={e => onPatternChange(e.target.value)}
          placeholder={ruleType === 'cluster' ? 'keyword1 | keyword2 | keyword3' : '/url-path | /other-path'}
          style={{ fontSize: '11px', color: 'var(--color-text-secondary)', background: 'transparent', border: 'none', outline: 'none', width: 'calc(100% - 70px)', cursor: 'text', fontFamily: 'monospace' }}
        />
      </div>
    </div>
  );
}

function makeEmptyCluster(): SetupItem {
  return { name: 'New Cluster', rules: JSON.stringify([{ type: 'contains', values: [] }]), count: 0, selected: true };
}
function makeEmptyGroup(): SetupItem {
  return { name: 'New Group', rules: JSON.stringify([{ type: 'contains', values: [] }]), count: 0, selected: true };
}

function updateRules(item: SetupItem, patternStr: string): SetupItem {
  const values = patternStr.split('|').map(s => s.trim()).filter(Boolean);
  try {
    const r = JSON.parse(item.rules);
    r[0].values = values;
    return { ...item, rules: JSON.stringify(r) };
  } catch {
    return { ...item, rules: JSON.stringify([{ type: 'contains', values }]) };
  }
}

// ─── Branded Chart ────────────────────────────────────────────────────────────
function BrandedChart({ siteDbId, period, keywords }: { siteDbId: string; period: string; keywords: string[] }) {
  const { t } = useLanguage();
  const [tab, setTab] = useState<'Trend' | 'Comparison'>('Trend');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!siteDbId) return;
    setLoading(true);
    fetch(`/api/gsc/branded-report?siteId=${siteDbId}&period=${period}`)
      .then(r => r.json())
      .then(d => setRows(d.rows ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [siteDbId, period]);

  const fmt = (d: string) => { const dt = new Date(d); return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };

  const totalBranded = rows.reduce((s, r) => s + r.branded, 0);
  const totalNon = rows.reduce((s, r) => s + r.nonBranded, 0);
  const total = totalBranded + totalNon;
  const brandedPct = total > 0 ? Math.round((totalBranded / total) * 100) : 0;

  if (loading) return <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>{t('brandLoadingGsc')}</div>;

  if (rows.length === 0) return (
    <div style={{ border: '1px dashed var(--color-border)', borderRadius: 12, padding: '32px 24px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>
      {t('brandNoData')}<br/>{t('brandKeys')} {keywords.join(', ')}
    </div>
  );

  const chartData = rows.map(r => ({ date: fmt(r.date), branded: r.branded, nonBranded: r.nonBranded }));

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 12, padding: '16px', background: 'var(--color-card)' }}>
      {/* Summary */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <span style={{ color: '#818cf8', fontWeight: 700 }}>{totalBranded.toLocaleString()}</span> {t('brandedClicksLabel')} ({brandedPct}%)
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <span style={{ color: '#10b981', fontWeight: 700 }}>{totalNon.toLocaleString()}</span> {t('brandNonBrandedLabel')} ({100 - brandedPct}%)
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {(['Trend', 'Comparison'] as const).map(tb => (
          <button key={tb} onClick={() => setTab(tb)} style={{ padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', border: `1px solid ${tab === tb ? '#3B82F6' : 'var(--color-border)'}`, background: tab === tb ? 'rgba(59,130,246,0.1)' : 'transparent', color: tab === tb ? '#3B82F6' : 'var(--color-text-secondary)' }}>{tb === 'Trend' ? t('brandTrend') : t('brandComparison')}</button>
        ))}
      </div>

      {tab === 'Trend' ? (
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }} axisLine={false} tickLine={false} width={32} />
            <Tooltip formatter={(v: any, name: any) => [v, name === 'branded' ? t('brandBranded') : t('brandNonBranded')]} contentStyle={{ background: 'var(--color-card)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }} />
            <Line type="monotone" dataKey="branded" stroke="#818cf8" strokeWidth={2} dot={false} name="branded" />
            <Line type="monotone" dataKey="nonBranded" stroke="#10b981" strokeWidth={2} dot={false} name="nonBranded" />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={[{ name: t('brandClicks'), branded: totalBranded, nonBranded: totalNon }]} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }} axisLine={false} tickLine={false} width={40} />
            <Tooltip formatter={(v: any, name: any) => [v.toLocaleString(), name === 'branded' ? t('brandBranded') : t('brandNonBranded')]} contentStyle={{ background: 'var(--color-card)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }} />
            <Bar dataKey="branded" fill="#818cf8" name="branded" radius={[4,4,0,0]} />
            <Bar dataKey="nonBranded" fill="#10b981" name="nonBranded" radius={[4,4,0,0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ─── Branded Keywords Modal ───────────────────────────────────────────────────
function BrandedKeywordsModal({ siteDbId, domain, initial, onClose, onSaved }: {
  siteDbId: string; domain: string; initial: string[];
  onClose: () => void; onSaved: (kws: string[]) => void;
}) {
  const { t } = useLanguage();
  const [keywords, setKeywords] = useState<string[]>(initial.length > 0 ? initial : [domain.split('.')[0].toLowerCase()]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiGenerated, setAiGenerated] = useState(false);

  const addKeyword = (kw: string) => {
    const clean = kw.trim().toLowerCase();
    if (clean && !keywords.includes(clean)) setKeywords(p => [...p, clean]);
    setInput('');
  };

  const removeKeyword = (kw: string) => setKeywords(p => p.filter(k => k !== kw));

  const suggestWithAI = async () => {
    setLoading(true);
    // Brand detection is a short mechanical pass, so it runs on the `utility` task — the same
    // resolution the SEO tools use, rather than a private reading of localStorage.
    const { provider, apiKey, model, baseUrl } = getTaskCreds('utility');
    try {
      const qs = new URLSearchParams({ siteId: siteDbId, suggest: '1', aiProvider: provider, aiApiKey: apiKey });
      if (model) qs.set('aiModel', model);
      if (baseUrl) qs.set('aiBaseUrl', baseUrl);
      const res = await fetch(`/api/gsc/branded?${qs.toString()}`);
      const data = await res.json();
      if (data.branded?.length) {
        setKeywords(data.branded);
        setAiGenerated(!!data.aiGenerated);
      }
    } catch {}
    setLoading(false);
  };

  const save = async () => {
    setSaving(true);
    await fetch('/api/gsc/branded', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: siteDbId, keywords }),
    });
    setSaving(false);
    onSaved(keywords);
  };

  const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
  const box: React.CSSProperties = { background: 'var(--color-card)', borderRadius: '16px', width: '480px', maxWidth: '95vw', padding: '28px', display: 'flex', flexDirection: 'column', gap: '20px', border: '1px solid var(--color-border)' };

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={box}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--color-text-primary)' }}>
            🏷️ {t('setBrandedKw')}
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: '20px', lineHeight: 1 }}>×</button>
        </div>

        <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
          {t('setBrandedDesc3')}
        </p>

        {/* AI suggest button */}
        <button onClick={suggestWithAI} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px', borderRadius: '10px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.25)', color: '#818cf8', cursor: loading ? 'wait' : 'pointer', fontSize: '13px', fontWeight: 600, width: 'fit-content' }}>
          <span>✨</span>
          {loading ? t('aiAnalyzing') : t('aiSuggest')}
        </button>
        {aiGenerated && <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '-12px' }}>✓ {t('aiGeneratedNote')}</p>}

        {/* Keyword chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', minHeight: '40px' }}>
          {keywords.map(kw => (
            <span key={kw} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', padding: '4px 12px', borderRadius: '20px', background: 'rgba(99,102,241,0.12)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.25)' }}>
              {kw}
              <button onClick={() => removeKeyword(kw)} style={{ background: 'none', border: 'none', color: '#818cf8', cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '0 0 0 2px' }}>×</button>
            </span>
          ))}
        </div>

        {/* Manual input */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(input); } }}
            placeholder={t('setEnterKw')}
            style={{ flex: 1, padding: '9px 14px', borderRadius: '8px', border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text-primary)', fontSize: '13px' }}
          />
          <button onClick={() => addKeyword(input)} style={{ padding: '9px 16px', borderRadius: '8px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#3B82F6', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}>{t('setAdd')}</button>
        </div>

        {/* Save */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button onClick={onClose} style={{ padding: '10px 20px', borderRadius: '10px', background: 'transparent', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: '13px' }}>{t('cancel')}</button>
          <button onClick={save} disabled={saving || keywords.length === 0} style={{ padding: '10px 24px', borderRadius: '10px', background: '#3B82F6', border: 'none', color: '#fff', cursor: saving ? 'wait' : 'pointer', fontSize: '13px', fontWeight: 600 }}>
            {saving ? t('btnSaving') : t('setSave')}
          </button>
        </div>
      </div>
    </div>
  );
}

function SetupModal({ domain, siteDbId, onClose, onApplied }: {
  domain: string; siteDbId: string;
  onClose: () => void; onApplied: () => void;
}) {
  const { t } = useLanguage();
  const [step, setStep]         = useState<1 | 2 | 3 | 4>(1);
  const [loading, setLoading]   = useState(false);
  const [clusters, setClusters] = useState<SetupItem[]>([]);
  const [groups, setGroups]     = useState<SetupItem[]>([]);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [aiUsed, setAiUsed]     = useState(false);

  const [aiProvider, setAiProvider] = useState<string>('anthropic');
  const [aiApiKey, setAiApiKey] = useState<string>('');
  const [providerStatuses, setProviderStatuses] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const provider = localStorage.getItem('aiProvider') || 'anthropic';
    const key = localStorage.getItem('aiApiKey') || '';
    setAiProvider(provider);
    setAiApiKey(key);

    // Check all provider keys
    const statuses: Record<string, boolean> = {};
    for (const id of ['anthropic','openai','gemini','openrouter','zai']) {
      const k = localStorage.getItem(`aiKey_${id}`) || '';
      statuses[id] = k.trim().length > 6;
    }
    // Also check the legacy key
    if (key.trim().length > 6) statuses[provider] = true;
    setProviderStatuses(statuses);
  }, []);

  const generate = async () => {
    setStep(2); setLoading(true); setError('');
    // Resolve the key: prefer per-provider key, fall back to legacy key
    const resolvedKey = localStorage.getItem(`aiKey_${aiProvider}`) || aiApiKey;
    // Clustering is a mechanical pass: model comes from the `utility` task when one is set.
    const util = getTaskCreds('utility');
    try {
      const res = await fetch('/api/gsc/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId: siteDbId, aiProvider, aiApiKey: resolvedKey,
          aiModel: util.provider === aiProvider ? util.model || undefined : undefined,
          aiBaseUrl: util.provider === aiProvider ? util.baseUrl || undefined : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("errFailed"));
      setClusters((data.clusters ?? []).map((c: any) => ({ ...c, selected: true })));
      setGroups((data.groups ?? []).map((g: any) => ({ ...g, selected: true })));
      setAiUsed(data.clusters?.[0]?.aiGenerated ?? false);
      setStep(3);
    } catch (e: any) { setError(e.message); setStep(1); }
    finally { setLoading(false); }
  };

  const apply = async () => {
    setSaving(true);
    try {
      await Promise.all([
        fetch('/api/gsc/clusters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ siteId: siteDbId, clusters: clusters.filter(c => c.selected) }) }),
        fetch('/api/gsc/groups',   { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ siteId: siteDbId, groups: groups.filter(g => g.selected) }) }),
      ]);
      onApplied();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const updCluster = (i: number, fn: (x: SetupItem) => SetupItem) => setClusters(p => p.map((x, j) => j === i ? fn(x) : x));
  const updGroup   = (i: number, fn: (x: SetupItem) => SetupItem) => setGroups(p => p.map((x, j) => j === i ? fn(x) : x));

  const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' };
  const modal: React.CSSProperties   = { background: 'var(--color-card)', borderRadius: '16px', width: '740px', maxWidth: '95vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(0,0,0,0.35)', border: '1.5px solid rgba(59,130,246,0.35)' };

  const stepTitle = ['', t("selectSite"), t("generating"), t("topicClusters"), t("contentGroups")][step];
  const totalSelected = (step === 3 ? clusters : groups).filter(x => x.selected).length;

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={modal}>
        {/* Header */}
        <div style={{ padding: '18px 24px 14px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Sparkles size={17} color="#3B82F6" />
            <span style={{ fontSize: '15px', fontWeight: 700 }}>{t("oneClickSetup")}</span>
            <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)', fontWeight: 400 }}>— {stepTitle}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {aiUsed && step >= 3 && (
              <span style={{ fontSize: '11px', background: 'rgba(139,92,246,0.12)', color: '#8B5CF6', borderRadius: '20px', padding: '3px 10px', fontWeight: 600 }}>✦ AI</span>
            )}
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', padding: '4px' }}><X size={17} /></button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 24px' }}>
          {/* Step 1 */}
          {step === 1 && (
            <div>
              <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
                {t("setupDesc")}
              </p>
              <div style={{ border: '1px solid var(--color-border)', borderRadius: '10px', padding: '13px 16px', display: 'flex', alignItems: 'center', gap: '10px', background: 'var(--color-bg)', marginBottom: '16px' }}>
                <input type="checkbox" defaultChecked readOnly style={{ accentColor: '#3B82F6', width: '16px', height: '16px', flexShrink: 0 }} />
                <Globe size={14} color="var(--color-text-secondary)" />
                <span style={{ fontSize: '13px', fontWeight: 500 }}>{domain}</span>
              </div>

              {/* AI provider info box */}
              {(() => {
                const anyConfigured = Object.values(providerStatuses).some(Boolean);
                const PROVIDERS = [
                  { id: 'anthropic', name: 'Anthropic', color: '#CF6B4A' },
                  { id: 'openai',    name: 'OpenAI',    color: '#10A37F' },
                  { id: 'gemini',    name: 'Gemini',    color: '#4285F4' },
                  { id: 'openrouter',name: 'OpenRouter', color: '#7C3AED' },
                  { id: 'zai',       name: 'Z.AI',      color: '#0EA5E9' },
                ];
                return (
                  <div style={{ border: `1px solid ${anyConfigured ? 'rgba(139,92,246,0.3)' : 'rgba(245,158,11,0.35)'}`, borderRadius: '10px', padding: '14px 16px', background: anyConfigured ? 'rgba(139,92,246,0.06)' : 'rgba(245,158,11,0.05)' }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Sparkles size={14} color={anyConfigured ? '#8B5CF6' : '#F59E0B'} />
                      {anyConfigured ? 'AI Clustering Enabled' : 'Connect AI for Better Clustering'}
                    </div>
                    <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '12px', lineHeight: 1.6 }}>
                      {anyConfigured
                        ? 'Your AI provider will analyze your top GSC queries and URLs to create semantically meaningful clusters — far better than keyword matching alone.'
                        : 'Without an AI key, clustering falls back to keyword frequency matching. Connect a provider for intelligent, semantic topic grouping that understands query intent.'
                      }
                    </p>

                    {/* Provider status pills */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: anyConfigured ? '0' : '12px' }}>
                      {PROVIDERS.map(p => {
                        const ok = providerStatuses[p.id];
                        return (
                          <div key={p.id} style={{
                            display: 'flex', alignItems: 'center', gap: '5px',
                            padding: '4px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 600,
                            background: ok ? `${p.color}18` : 'rgba(255,255,255,0.05)',
                            border: `1px solid ${ok ? `${p.color}40` : 'rgba(255,255,255,0.1)'}`,
                            color: ok ? p.color : 'var(--color-text-secondary)',
                          }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: ok ? p.color : 'rgba(255,255,255,0.2)', flexShrink: 0 }} />
                            {p.name}
                            {ok && <Check size={10} />}
                          </div>
                        );
                      })}
                    </div>

                    {!anyConfigured && (
                      <a
                        href="/settings#ai"
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', fontWeight: 600, color: '#F59E0B', textDecoration: 'none', padding: '6px 12px', borderRadius: '8px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)' }}
                      >
                        <Sparkles size={12} /> Add API key in Settings
                      </a>
                    )}

                    {/* Active provider selector (only when at least one is configured) */}
                    {anyConfigured && (
                      <div style={{ marginTop: '12px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>Use:</span>
                        <select
                          value={aiProvider}
                          onChange={(e) => {
                            const v = e.target.value;
                            setAiProvider(v);
                            localStorage.setItem('aiProvider', v);
                            const k = localStorage.getItem(`aiKey_${v}`) || localStorage.getItem('aiApiKey') || '';
                            setAiApiKey(k);
                            localStorage.setItem('aiApiKey', k);
                          }}
                          style={{ padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--color-border)', background: 'var(--color-card)', color: 'var(--color-text-primary)', fontSize: '12px', outline: 'none', cursor: 'pointer' }}
                        >
                          {PROVIDERS.filter(p => providerStatuses[p.id]).map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                        <span style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>
                          · or{' '}
                          <a href="/settings" target="_blank" rel="noreferrer" style={{ color: 'var(--color-accent-blue)', textDecoration: 'none' }}>manage keys in Settings</a>
                        </span>
                      </div>
                    )}
                  </div>
                );
              })()}

              {error && <p style={{ marginTop: '12px', fontSize: '12px', color: '#EF4444' }}>{error}</p>}
            </div>
          )}

          {/* Step 2 */}
          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: '16px' }}>
              <div style={{ width: '40px', height: '40px', border: '3px solid var(--color-border)', borderTopColor: '#3B82F6', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '14px' }}>{t("generating")}</p>
              <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            </div>
          )}

          {/* Step 3 — clusters */}
          {step === 3 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '4px' }}>
                {t("renameHintCluster")}
              </p>
              {clusters.map((c, i) => (
                <SetupCard key={i} item={c} index={i} ruleType="cluster"
                  onToggle={() => updCluster(i, x => ({ ...x, selected: !x.selected }))}
                  onRename={name => updCluster(i, x => ({ ...x, name }))}
                  onDelete={() => setClusters(p => p.filter((_, j) => j !== i))}
                  onPatternChange={val => updCluster(i, x => updateRules(x, val))}
                />
              ))}
              <button
                onClick={() => setClusters(p => [...p, makeEmptyCluster()])}
                style={{ marginTop: '4px', padding: '8px', borderRadius: '10px', border: '1px dashed var(--color-border)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
              >
                {t("addClusterManual")}
              </button>
            </div>
          )}

          {/* Step 4 — groups */}
          {step === 4 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '4px' }}>
                {t("renameHintGroup")}
              </p>
              {groups.map((g, i) => (
                <SetupCard key={i} item={g} index={i} ruleType="group"
                  onToggle={() => updGroup(i, x => ({ ...x, selected: !x.selected }))}
                  onRename={name => updGroup(i, x => ({ ...x, name }))}
                  onDelete={() => setGroups(p => p.filter((_, j) => j !== i))}
                  onPatternChange={val => updGroup(i, x => updateRules(x, val))}
                />
              ))}
              <button
                onClick={() => setGroups(p => [...p, makeEmptyGroup()])}
                style={{ marginTop: '4px', padding: '8px', borderRadius: '10px', border: '1px dashed var(--color-border)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
              >
                {t("addGroupManual")}
              </button>
              {error && <p style={{ fontSize: '12px', color: '#EF4444' }}>{error}</p>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <button
            onClick={() => step > 1 && step !== 2 && setStep(s => (s - 1) as any)}
            disabled={step <= 1 || step === 2}
            style={{ padding: '7px 18px', borderRadius: '8px', border: '1px solid var(--color-border)', background: 'var(--color-card)', color: 'var(--color-text-primary)', fontSize: '13px', fontWeight: 500, cursor: step <= 1 || step === 2 ? 'not-allowed' : 'pointer', opacity: step <= 1 || step === 2 ? 0.4 : 1 }}
          >
            {t("btnPrevious")}
          </button>
          {step >= 3 && (
            <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
              {totalSelected} {t("selectedCount")}
            </span>
          )}
          {step < 3 ? (
            <button onClick={step === 1 ? generate : undefined} disabled={loading}
              style={{ padding: '7px 20px', borderRadius: '8px', border: 'none', background: '#1e293b', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer' }}>
              {t("btnNext")}
            </button>
          ) : step === 3 ? (
            <button onClick={() => setStep(4)}
              style={{ padding: '7px 20px', borderRadius: '8px', border: 'none', background: '#1e293b', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
              {t("btnNextArrow")}
            </button>
          ) : (
            <button onClick={apply} disabled={saving}
              style={{ padding: '7px 20px', borderRadius: '8px', border: 'none', background: '#3B82F6', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer' }}>
              {saving ? t("btnSaving") : t("btnApplySetup")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Custom Chart Tooltip ─────────────────────────────────────────────────────
function SiteTooltip({ active, payload, label }: any) {
  const { t } = useLanguage();
  if (!active || !payload?.length) return null;
  const d = payload.reduce((acc: any, p: any) => { acc[p.dataKey] = p.value; return acc; }, {} as any);
  return (
    <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "10px 14px", fontSize: "12px", color: "var(--color-text-primary)", boxShadow: "0 4px 20px rgba(0,0,0,0.3)" }}>
      <p style={{ fontWeight: 600, marginBottom: "6px", color: "var(--color-text-primary)" }}>{label}</p>
      {[
        { key: "clicks",      label: t("clicks"),      color: C.clicks },
        { key: "impressions", label: t("impressions"),  color: C.impressions },
        { key: "ctr",         label: "CTR",             color: C.ctr, suffix: "%" },
        { key: "position",    label: t("avgPosition"),  color: C.position },
      ].map(({ key, label, color, suffix = "" }) => (
        <div key={key} style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: color, flexShrink: 0, display: "inline-block" }} />
          <span style={{ color: "var(--color-text-secondary)", flex: 1 }}>{label}</span>
          <span style={{ fontWeight: 600 }}>{d[key]}{suffix}</span>
        </div>
      ))}
    </div>
  );
}

// ─── GA4 metric types ─────────────────────────────────────────────────────────
type GA4Metric = "sessions" | "engagement" | "events" | "revenue";

// label holds an i18n KEY (ga4Metric*), kept for symmetry with metricLabel(). It is not rendered
// directly today — every display site calls metricLabel(key) — but storing the key here means a
// future caller that does read .label gets a translatable value, not dead English.
const GA4_METRICS: { key: GA4Metric; icon: React.ReactNode; label: string; color: string; bg: string }[] = [
  { key: "sessions",   icon: <Users size={13} />,      label: "ga4MetricSessions",    color: "#3B82F6", bg: "rgba(59,130,246,0.12)" },
  { key: "engagement", icon: <Activity size={13} />,   label: "ga4MetricEngagement",  color: "#8B5CF6", bg: "rgba(139,92,246,0.12)" },
  { key: "events",     icon: <Zap size={13} />,        label: "ga4MetricEvents",      color: "#10B981", bg: "rgba(16,185,129,0.12)" },
  { key: "revenue",    icon: <DollarSign size={13} />, label: "ga4MetricRevenue",     color: "#F59E0B", bg: "rgba(245,158,11,0.12)" },
];

// Simple dropdown for re-use
function SimpleDropdown({ trigger, children, align = "right" }: { trigger: React.ReactNode; children: React.ReactNode; align?: "left"|"right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div onClick={() => setOpen(o => !o)}>{trigger}</div>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", [align === "right" ? "right" : "left"]: 0, background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", boxShadow: "0 8px 32px rgba(0,0,0,0.5)", zIndex: 200, minWidth: "180px", overflow: "hidden" }}
          onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Period Dropdown ─────────────────────────────────────────────────────────
function PeriodDropdown({ period, onChange }: { period: string; onChange: (p: string) => void }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const label = t((PERIOD_OPTIONS.find(o => o.key === period)?.label ?? period) as never);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: open ? "rgba(255,255,255,0.07)" : "var(--color-card)", color: "var(--color-text-primary)", fontSize: "13px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
        {label} <ChevronDown size={13} style={{ color: "var(--color-text-secondary)", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", boxShadow: "0 8px 32px rgba(0,0,0,0.5)", zIndex: 300, minWidth: "170px", overflow: "hidden", maxHeight: "420px", overflowY: "auto" }}>
          {PERIOD_GROUPS.map((group, gi) => (
            <div key={gi}>
              {gi > 0 && <div style={{ height: "1px", background: "var(--color-border)", margin: "4px 0" }} />}
              {group.map(key => {
                const opt = PERIOD_OPTIONS.find(o => o.key === key);
                if (!opt) return null;
                const active = period === key;
                return (
                  <button key={key} onClick={() => { onChange(key); setOpen(false); }}
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 14px", fontSize: "13px", width: "100%", background: active ? "rgba(59,130,246,0.12)" : "transparent", color: active ? "#3B82F6" : "var(--color-text-primary)", border: "none", cursor: "pointer", fontWeight: active ? 600 : 400 }}
                    onMouseOver={e => { if (!active) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                    onMouseOut={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
                  >
                    {t(opt.label as never)}
                    {active && <Check size={12} />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Google Updates toggle ────────────────────────────────────────────────────
// Shows/hides the Google algorithm-update reference lines on the Dashboard chart.
// (Note adding/management itself lives on the "Заметки" tab — the old dropdown
// here duplicated that with a couple of dead, unwired buttons, so it's gone.)
// ─── AIO Impact tooltip: raw values + their index vs the base (=100) day ──────
function AioTooltip({ active, payload, label }: any) {
  const { t } = useLanguage();
  if (!active || !payload?.length) return null;
  const d = payload.reduce((acc: any, p: any) => { acc[p.dataKey] = p.value; return acc; }, {} as any);
  const row = payload[0]?.payload ?? {};
  return (
    <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "10px 14px", fontSize: "12px", color: "var(--color-text-primary)", boxShadow: "0 4px 20px rgba(0,0,0,0.3)" }}>
      <p style={{ fontWeight: 600, marginBottom: "6px" }}>{label}</p>
      {[
        { idxKey: "clicksIdx", rawKey: "clicks", label: t("clicks"), color: C.clicks },
        { idxKey: "imprIdx", rawKey: "impressions", label: t("impressions"), color: C.impressions },
      ].map(({ idxKey, rawKey, label: l, color }) => (
        <div key={idxKey} style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: color, flexShrink: 0, display: "inline-block" }} />
          <span style={{ color: "var(--color-text-secondary)", flex: 1 }}>{l}</span>
          <span style={{ fontWeight: 600 }}>{(row[rawKey] ?? 0).toLocaleString()}</span>
          <span style={{ color: d[idxKey] >= 100 ? "#10B981" : "#EF4444", fontWeight: 700, minWidth: "44px", textAlign: "right" }}>{d[idxKey]}%</span>
        </div>
      ))}
      <div style={{ fontSize: "10px", color: "var(--color-text-secondary)", marginTop: "5px" }}>{t("aioBaseNote")}</div>
    </div>
  );
}

function GoogleUpdatesToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} title="Google algorithm updates on chart"
      style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 10px", borderRadius: "8px", border: `1px solid ${on ? "var(--color-accent-blue)" : "var(--color-border)"}`, background: on ? "rgba(59,130,246,0.08)" : "var(--color-card)", color: on ? "var(--color-accent-blue)" : "var(--color-text-secondary)", fontSize: "12px", fontWeight: 500, cursor: "pointer" }}>
      <GoogleIcon size={13} />
    </button>
  );
}

// ─── Filter Dropdown (Dashboard) ─────────────────────────────────────────────
function FilterDd({ positionFilter, onPositionFilter, filterDimension, filterText, onDimension, onFilterText, preset, onPreset, onApply }: {
  positionFilter: number | null; onPositionFilter: (v: number | null) => void;
  filterDimension: string | null; filterText: string;
  onDimension: (v: string | null) => void; onFilterText: (v: string) => void;
  preset: string | null; onPreset: (v: string | null) => void;
  onApply?: () => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const activeCount = [positionFilter !== null, filterDimension !== null && filterText.trim() !== "", preset !== null].filter(Boolean).length;
  const isActive = activeCount > 0;

  const divider = <div style={{ height: "1px", background: "var(--color-border)", margin: "4px 0" }} />;
  const sec = (label: string) => (
    <div style={{ padding: "10px 14px 4px", fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
  );

  // label holds an i18n KEY (rendered via t(label) below) so the dimension list stays single-
  // sourced while each language renders its own word for Query/Page/Country/Device.
  const dims = [
    { icon: <Search size={14}/>,        v: "query",   label: "dimQuery" },
    { icon: <FileText size={14}/>,       v: "page",    label: "dimPage" },
    { icon: <Globe size={14}/>,          v: "country", label: "dimCountry" },
    { icon: <Monitor size={14}/>,        v: "device",  label: "dimDevice" },
    { icon: <BookmarkCheck size={14}/>,  v: "",        label: "dimContentGroup", disabled: true },
    { icon: <ArrowLeftRight size={14}/>, v: "",        label: "dimCompareFilters", disabled: true },
  ];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "8px", border: `1px solid ${isActive ? "#3B82F6" : "var(--color-border)"}`, background: isActive ? "rgba(59,130,246,0.1)" : open ? "rgba(255,255,255,0.07)" : "var(--color-card)", color: isActive ? "#3B82F6" : "var(--color-text-secondary)", fontSize: "12px", fontWeight: 500, cursor: "pointer" }}>
        <SlidersHorizontal size={13} />
        Filter
        {isActive && <span style={{ fontSize: "10px", background: "#3B82F6", color: "#fff", borderRadius: "10px", padding: "1px 6px", fontWeight: 700 }}>{activeCount}</span>}
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", boxShadow: "0 8px 32px rgba(0,0,0,0.5)", zIndex: 300, minWidth: "260px", overflow: "hidden" }}>
          {/* Dimension */}
          {dims.map(({ icon, v, label, disabled }: any) => (
            <button key={label} disabled={disabled}
              onClick={() => { if (disabled) return; const same = filterDimension === v; onDimension(same ? null : v); onFilterText(""); }}
              style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 14px", fontSize: "13px", cursor: disabled ? "default" : "pointer", width: "100%", background: filterDimension === v && !disabled ? "rgba(59,130,246,0.1)" : "transparent", color: disabled ? "var(--color-text-secondary)" : filterDimension === v ? "#3B82F6" : "var(--color-text-primary)", border: "none", opacity: disabled ? 0.4 : 1 }}
              onMouseOver={e => { if (!disabled && filterDimension !== v) e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
              onMouseOut={e => { if (filterDimension !== v) e.currentTarget.style.background = "transparent"; }}>
              {icon} {t(label as never)}
              {filterDimension === v && <Check size={12} style={{ marginLeft: "auto" }} />}
            </button>
          ))}

          {/* Text input for Query / Page / Country */}
          {filterDimension && filterDimension !== "device" && (
            <div style={{ padding: "4px 14px 12px" }}>
              <input autoFocus value={filterText} onChange={e => onFilterText(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && filterText.trim()) onApply?.(); }}
                placeholder={filterDimension === "query" ? "e.g. casino, massage…" : filterDimension === "page" ? "e.g. /blog, /product…" : "e.g. gr, de, us…"}
                style={{ width: "100%", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "rgba(255,255,255,0.06)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none", boxSizing: "border-box" }} />
              <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "4px" }}>Press Enter — filters the table further down the page.</div>
            </div>
          )}

          {/* Device pills */}
          {filterDimension === "device" && (
            <div style={{ padding: "4px 14px 12px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {["all", "MOBILE", "DESKTOP", "TABLET"].map(v => (
                <button key={v} onClick={() => { onFilterText(v === "all" ? "" : v); onApply?.(); }}
                  style={{ padding: "4px 10px", borderRadius: "20px", fontSize: "12px", fontWeight: 500, cursor: "pointer", border: `1px solid ${filterText === (v === "all" ? "" : v) ? "#3B82F6" : "var(--color-border)"}`, background: filterText === (v === "all" ? "" : v) ? "rgba(59,130,246,0.1)" : "transparent", color: filterText === (v === "all" ? "" : v) ? "#3B82F6" : "var(--color-text-secondary)" }}>
                  {v === "all" ? "All" : v[0] + v.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          )}

          {divider}
          {sec(t("sectionPositionFilter"))}
          <div style={{ padding: "4px 14px 10px", display: "flex", gap: "8px" }}>
            {([10, 20] as const).map(v => {
              const active = positionFilter === v;
              return (
                <button key={v} onClick={() => onPositionFilter(active ? null : v)}
                  style={{ display: "flex", alignItems: "center", gap: "5px", padding: "5px 12px", borderRadius: "20px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: `1px solid ${active ? "#F59E0B" : "var(--color-border)"}`, background: active ? "rgba(245,158,11,0.12)" : "transparent", color: "#F59E0B" }}>
                  <MoveUp size={12} /> Top {v}
                </button>
              );
            })}
          </div>

          {divider}
          {sec(t("sectionPresetFilters"))}
          {[
            { v: "paa",      label: "presetPaa",      hint: "presetPaaHint" },
            { v: "longtail", label: "presetLongTail", hint: "presetLongTailHint" },
          ].map(({ v, label, hint }) => (
            <button key={v} onClick={() => { onPreset(preset === v ? null : v); onDimension(null); onFilterText(""); }}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "9px 14px", fontSize: "13px", fontWeight: preset === v ? 700 : 600, cursor: "pointer", background: preset === v ? "rgba(59,130,246,0.1)" : "transparent", color: preset === v ? "#3B82F6" : "var(--color-text-primary)", border: "none" }}
              onMouseOver={e => { if (preset !== v) e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
              onMouseOut={e => { if (preset !== v) e.currentTarget.style.background = "transparent"; }}>
              <span>{t(label as never)}</span>
              <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", fontWeight: 400 }}>{t(hint as never)}</span>
            </button>
          ))}

          {/* Reset */}
          {isActive && (
            <>
              {divider}
              <button onClick={() => { onPositionFilter(null); onDimension(null); onFilterText(""); onPreset(null); }}
                style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", padding: "9px 14px", fontSize: "12px", color: "#EF4444", background: "transparent", border: "none", cursor: "pointer", fontWeight: 500 }}
                onMouseOver={e => e.currentTarget.style.background = "rgba(239,68,68,0.07)"}
                onMouseOut={e => e.currentTarget.style.background = "transparent"}>
                <X size={12} /> Reset filters
              </button>
            </>
          )}
          <div style={{ height: "4px" }} />
        </div>
      )}
    </div>
  );
}

// ─── GA4 Tab ──────────────────────────────────────────────────────────────────
type GA4Property = { id: string; name: string; account: string };
type GA4Report = {
  linked: boolean;
  property?: { id: string; name: string };
  totals?: { sessions: number; engagement: number; events: number; revenue: number };
  deltas?: { sessions: number; engagement: number; events: number; revenue: number };
  series?: { date: string; sessions: number; engagement: number; events: number; revenue: number }[];
  error?: string;
};

function fmtMetric(key: GA4Metric, v: number): string {
  if (key === "engagement") return `${v}%`;
  if (key === "revenue") return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return v.toLocaleString();
}

type GA4Row = { label: string; value: number; sub?: number };
type GA4Breakdowns = {
  topPages?: GA4Row[]; channels?: GA4Row[]; sources?: GA4Row[];
  countries?: GA4Row[]; devices?: GA4Row[]; events?: GA4Row[];
  realtime?: { activeUsers: number; byCountry: GA4Row[] };
};

// Compact ranked table: label + value with a proportional bar.
function GA4Table({ title, caption, rows, color }: {
  title: string; caption: string; rows?: GA4Row[]; color: string;
}) {
  const { t } = useLanguage();
  const data = (rows ?? []).slice(0, 8);
  const max = Math.max(1, ...data.map(r => r.value));
  return (
    <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "12px", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px" }}>
        <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{title}</span>
        <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", textTransform: "lowercase" }}>{caption}</span>
      </div>
      {data.length === 0 ? (
        <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", padding: "6px 0" }}>{t("ga4NoRows")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
          {data.map((r, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
                <span title={r.label} style={{ fontSize: "12px", color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label || "—"}</span>
                <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)", flexShrink: 0 }}>{r.value.toLocaleString()}</span>
              </div>
              <div style={{ height: "3px", borderRadius: "2px", background: "var(--color-border)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(r.value / max) * 100}%`, background: color, borderRadius: "2px" }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Friendly first-run setup guide shown when no GA4 properties are available yet.
// Keeps the raw Google API error tucked behind a "technical details" toggle so a
// first-time user sees clear steps instead of a scary red message.
function GA4SetupSteps({ errors }: { errors?: string[] }) {
  const { t } = useLanguage();
  const [showDetails, setShowDetails] = useState(false);

  const linkStyle: React.CSSProperties = { color: "#3B82F6", fontWeight: 600, textDecoration: "none" };
  const stepTitle: React.CSSProperties = { fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "3px" };
  const stepDesc: React.CSSProperties = { fontSize: "12.5px", color: "var(--color-text-secondary)", lineHeight: 1.6 };

  return (
    <div style={{ width: "100%", maxWidth: "560px", textAlign: "left", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "12px", padding: "20px 22px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <div>
        <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "4px" }}>{t("ga4SetupTitle")}</div>
        <div style={{ fontSize: "12.5px", color: "var(--color-text-secondary)" }}>{t("ga4SetupIntro")}</div>
      </div>

      <div>
        <div style={stepTitle}>{t("ga4Step1Title")}</div>
        <div style={stepDesc}>
          {t("ga4Step1Desc")}
          <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginTop: "6px" }}>
            <a href="https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com" target="_blank" rel="noreferrer" style={linkStyle}>{t("ga4EnableDataApi")}</a>
            <a href="https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com" target="_blank" rel="noreferrer" style={linkStyle}>{t("ga4EnableAdminApi")}</a>
          </div>
        </div>
      </div>

      <div>
        <div style={stepTitle}>{t("ga4Step2Title")}</div>
        <div style={stepDesc}>
          {t("ga4Step2Desc")}{" "}
          <a href="/settings" style={linkStyle}>{t("ga4OpenSettings")}</a>
        </div>
      </div>

      <div>
        <div style={stepTitle}>{t("ga4Step3Title")}</div>
        <div style={stepDesc}>
          {t("ga4Step3Desc")}{" "}
          <a href="https://analytics.google.com/" target="_blank" rel="noreferrer" style={linkStyle}>{t("ga4OpenAnalytics")}</a>
        </div>
      </div>

      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontStyle: "italic" }}>{t("ga4SetupAfter")}</div>

      {errors && errors.length > 0 && (
        <div>
          <button onClick={() => setShowDetails(v => !v)} style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", padding: 0 }}>
            {showDetails ? t("ga4HideDetails") : t("ga4ShowDetails")}
          </button>
          {showDetails && (
            <div style={{ marginTop: "8px", fontSize: "11px", color: "#F87171", background: "var(--color-card)", padding: "8px 10px", borderRadius: "8px", lineHeight: 1.5, overflow: "auto" }}>
              <div style={{ fontWeight: 700, marginBottom: 4, color: "var(--color-text-secondary)" }}>{t("ga4ApiSaid")}</div>
              {errors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GA4Tab({ domain, period, setPeriod, periodOptions }: {
  domain: string;
  period: string;
  setPeriod: (p: string) => void;
  periodOptions: string[];
}) {
  const [activeMetrics, setActiveMetrics] = useState<Set<GA4Metric>>(new Set(["sessions", "engagement", "events", "revenue"]));
  const [selectedProp, setSelectedProp] = useState("");
  const [properties, setProperties] = useState<GA4Property[]>([]);
  const [propsLoading, setPropsLoading] = useState(false);
  const [report, setReport] = useState<GA4Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);
  const [propsMeta, setPropsMeta] = useState<{ connected: number; errors?: string[]; accountsInfo?: { email: string; count: number; error?: string }[] } | null>(null);
  const [bd, setBd] = useState<GA4Breakdowns | null>(null);
  const { t } = useLanguage();

  const metricLabel = (key: GA4Metric) =>
    key === "sessions" ? t("ga4MetricSessions")
      : key === "engagement" ? t("ga4MetricEngagement")
        : key === "events" ? t("ga4MetricEvents")
          : t("ga4MetricRevenue");

  const ga4Linked = report?.linked === true;

  // Fetch the report (and, if not linked, the available properties)
  const loadReport = async () => {
    setLoading(true);
    try {
      const res = await fetch(withShare(`/api/ga4/report?domain=${encodeURIComponent(domain)}&period=${encodeURIComponent(period)}`));
      const data: GA4Report = await res.json();
      setReport(data);
      if (!data.linked) { loadProperties(); setBd(null); }
      else if (!data.error) loadBreakdowns();
      else setBd(null);
    } catch {
      setReport({ linked: false });
    } finally {
      setLoading(false);
    }
  };

  const loadBreakdowns = async () => {
    try {
      const res = await fetch(withShare(`/api/ga4/breakdowns?domain=${encodeURIComponent(domain)}&period=${encodeURIComponent(period)}`));
      const data = await res.json();
      setBd(data.linked && !data.error ? data : null);
    } catch {
      setBd(null);
    }
  };

  const loadProperties = async () => {
    setPropsLoading(true);
    try {
      const res = await fetch(`/api/ga4/properties`);
      const data = await res.json();
      setProperties(data.properties ?? []);
      setPropsMeta({ connected: data.connected_accounts ?? 0, errors: data.errors, accountsInfo: data.accountsInfo });
    } catch {
      setProperties([]);
      setPropsMeta(null);
    } finally {
      setPropsLoading(false);
    }
  };

  useEffect(() => { loadReport(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [domain, period]);

  const linkProperty = async () => {
    const prop = properties.find(p => p.id === selectedProp);
    if (!prop) return;
    setLinking(true);
    try {
      await fetch(`/api/ga4/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, propertyId: prop.id, propertyName: prop.name }),
      });
      await loadReport();
    } finally {
      setLinking(false);
    }
  };

  const unlinkProperty = async () => {
    await fetch(`/api/ga4/link?domain=${encodeURIComponent(domain)}`, { method: "DELETE" });
    setSelectedProp("");
    setReport({ linked: false });
    loadProperties();
  };

  const toggleMetric = (m: GA4Metric) => setActiveMetrics(p => {
    const n = new Set(p); n.has(m) ? n.delete(m) : n.add(m); return n;
  });

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* GA4 top controls */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        {/* Metric toggles */}
        <div style={{ display: "flex", gap: "4px" }}>
          {GA4_METRICS.map(({ key, icon, color, bg }) => {
            const active = activeMetrics.has(key);
            return (
              <button key={key} title={metricLabel(key)} onClick={() => toggleMetric(key)} style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: "34px", height: "34px", borderRadius: "8px", cursor: "pointer",
                border: `1px solid ${active ? color : "var(--color-border)"}`,
                background: active ? bg : "var(--color-card)",
                color: active ? color : "var(--color-text-secondary)",
                transition: "all 0.15s",
              }}>
                {icon}
              </button>
            );
          })}
        </div>

        <div style={{ flex: 1 }} />

        {/* Period selector */}
        <SimpleDropdown
          align="right"
          trigger={
            <button style={{ display: "flex", alignItems: "center", gap: "6px", padding: "7px 13px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "13px", fontWeight: 500, cursor: "pointer" }}>
              {period} <ChevronDown size={13} />
            </button>
          }
        >
          {periodOptions.map(p => {
            const lbl = t((PERIOD_OPTIONS.find(o => o.key === p)?.label ?? p) as never);
            return (
              <button key={p} onClick={() => setPeriod(p)} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "9px 14px", fontSize: "13px", cursor: "pointer", width: "100%", background: period === p ? "rgba(59,130,246,0.12)" : "transparent", color: period === p ? "#3B82F6" : "var(--color-text-primary)", border: "none" }}>
                {lbl} {period === p && <Check size={12} style={{ marginLeft: "auto" }} />}
              </button>
            );
          })}
        </SimpleDropdown>
      </div>

      {/* Initial load */}
      {loading && !report ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "80px 32px", color: "var(--color-text-secondary)", fontSize: "13px" }}>
          {t("ga4Loading")}
        </div>
      ) : !ga4Linked ? (
        /* Onboarding card — pick a real GA4 property */
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "20px", padding: "64px 32px", background: "var(--color-card)", borderRadius: "16px", border: "1px solid var(--color-border)", textAlign: "center" }}>
          {/* GA logo */}
          <div style={{ width: "56px", height: "56px", borderRadius: "14px", background: "linear-gradient(135deg, #e8710a 0%, #f9a825 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "26px", boxShadow: "0 4px 16px rgba(232,113,10,0.3)" }}>
            📊
          </div>
          <div style={{ maxWidth: "420px" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "10px" }}>
              {t("ga4LinkTitle")}
            </h2>
            <p style={{ fontSize: "14px", color: "var(--color-text-secondary)", lineHeight: "1.6" }}>
              {t("ga4LinkSubtitle")}
            </p>
          </div>

          {/* Property selector */}
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "100%", maxWidth: "380px" }}>
            <select
              value={selectedProp}
              onChange={e => setSelectedProp(e.target.value)}
              disabled={propsLoading || properties.length === 0}
              style={{ width: "100%", padding: "10px 14px", borderRadius: "10px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: selectedProp ? "var(--color-text-primary)" : "var(--color-text-secondary)", fontSize: "14px", outline: "none", cursor: "pointer" }}
            >
              <option value="">
                {propsLoading ? t("ga4LoadingProps") : properties.length === 0 ? t("ga4NoPropsShort") : t("ga4SelectPlaceholder")}
              </option>
              {properties.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.account ? ` — ${p.account}` : ""} ({p.id})
                </option>
              ))}
            </select>
            <button
              onClick={linkProperty}
              disabled={!selectedProp || linking}
              style={{ width: "100%", padding: "10px 20px", borderRadius: "10px", border: "none", background: selectedProp && !linking ? "#3B82F6" : "var(--color-border)", color: selectedProp && !linking ? "#fff" : "var(--color-text-secondary)", fontSize: "14px", fontWeight: 600, cursor: selectedProp && !linking ? "pointer" : "not-allowed", transition: "all 0.15s", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
            >
              <Link2 size={15} /> {linking ? t("ga4Linking") : t("ga4LinkBtn")}
            </button>
          </div>

          {/* Per-account breakdown — which connected account contributed what */}
          {propsMeta?.accountsInfo && propsMeta.accountsInfo.length > 0 && (
            <div style={{ width: "100%", maxWidth: "460px", textAlign: "left", display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("ga4AccountsTitle")}</div>
              {propsMeta.accountsInfo.map((a, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", fontSize: "12px", padding: "5px 0", borderBottom: "1px solid var(--color-border)" }}>
                  <span style={{ color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.email}</span>
                  {a.error ? (
                    <span title={a.error} style={{ color: "#F87171", flexShrink: 0, maxWidth: "55%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>⚠ {a.error}</span>
                  ) : (
                    <span style={{ color: a.count > 0 ? "#10B981" : "var(--color-text-secondary)", fontWeight: 600, flexShrink: 0 }}>{a.count} {t("ga4PropsCount")}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {properties.length === 0 && !propsLoading ? (
            <GA4SetupSteps errors={propsMeta?.errors} />
          ) : (
            <p style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
              {t("ga4CanUnlinkLater")}
            </p>
          )}
        </div>
      ) : report?.error ? (
        /* Linked but the API call failed — show the same friendly guide + details */
        <div style={{ background: "var(--color-card)", borderRadius: "16px", border: "1px solid var(--color-border)", padding: "32px", display: "flex", flexDirection: "column", gap: "16px", alignItems: "center", textAlign: "center" }}>
          <p style={{ fontSize: "14px", color: "var(--color-text-secondary)", maxWidth: "460px", lineHeight: 1.6 }}>
            {t("ga4LoadError")}
          </p>
          <GA4SetupSteps errors={[report.error]} />
          <button onClick={unlinkProperty} style={{ fontSize: "12px", color: "var(--color-text-secondary)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
            {t("ga4Unlink")}
          </button>
        </div>
      ) : (
        /* Linked state — real metrics + chart */
        <div style={{ background: "var(--color-card)", borderRadius: "16px", border: "1px solid var(--color-border)", padding: "32px", display: "flex", flexDirection: "column", gap: "24px", position: "relative" }}>
          {loading && (
            <div style={{ position: "absolute", top: 14, right: 18, fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("ga4Updating")}</div>
          )}
          {report?.property?.name && (
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
              {report.property.name} · {t("ga4PropertyWord")} {report.property.id}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: "28px", flexWrap: "wrap" }}>
            {GA4_METRICS.filter(m => activeMetrics.has(m.key)).map(m => {
              const val = report?.totals?.[m.key] ?? 0;
              const delta = report?.deltas?.[m.key] ?? 0;
              return (
                <div key={m.key} style={{ display: "flex", alignItems: "center", gap: "7px" }}>
                  <span style={{ color: m.color }}>{m.icon}</span>
                  <span style={{ fontSize: "22px", fontWeight: 700, color: "var(--color-text-primary)" }}>
                    {fmtMetric(m.key, val)}
                  </span>
                  <span style={{ fontSize: "12px", color: delta >= 0 ? "#10B981" : "#EF4444", fontWeight: 600 }}>
                    {delta >= 0 ? "+" : ""}{delta}%
                  </span>
                </div>
              );
            })}
          </div>

          {report?.series && report.series.length > 0 ? (
            <div style={{ height: "260px" }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={report.series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="date" tickFormatter={(d: string) => (typeof d === "string" && d.length >= 10 ? d.slice(5) : d)} tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis yAxisId="left" tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }} axisLine={false} tickLine={false} width={40} />
                  <YAxis yAxisId="right" orientation="right" domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }} axisLine={false} tickLine={false} width={36} />
                  <Tooltip
                    contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                    formatter={(value: any, name: any, item: any) => {
                      const key = item?.dataKey as GA4Metric | undefined;
                      if (key === "engagement") return [`${value}%`, name];
                      if (key === "revenue") return [`$${value}`, name];
                      return [Number(value).toLocaleString(), name];
                    }}
                  />
                  {GA4_METRICS.filter(m => activeMetrics.has(m.key)).map(m => (
                    <Line
                      key={m.key}
                      yAxisId={m.key === "engagement" ? "right" : "left"}
                      type="monotone"
                      dataKey={m.key}
                      name={metricLabel(m.key)}
                      stroke={m.color}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div style={{ height: "200px", borderRadius: "12px", background: "var(--color-bg)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-secondary)", fontSize: "13px" }}>
              {t("ga4NoData")}
            </div>
          )}

          {/* Realtime strip */}
          {bd?.realtime && (
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "10px 14px", borderRadius: "10px", background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#10B981", boxShadow: "0 0 0 3px rgba(16,185,129,0.15)" }} />
              <span style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("ga4Realtime")}:</span>
              <span style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)" }}>{bd.realtime.activeUsers.toLocaleString()}</span>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }}>
                {bd.realtime.byCountry.slice(0, 5).map(c => `${c.label} ${c.value}`).join(" · ")}
              </span>
            </div>
          )}

          {/* Breakdown tables */}
          {bd && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "14px" }}>
              <GA4Table title={t("ga4TopPages")} caption={t("ga4CapViews")} rows={bd.topPages} color="#3B82F6" />
              <GA4Table title={t("ga4Channels")} caption={t("ga4CapSessions")} rows={bd.channels} color="#8B5CF6" />
              <GA4Table title={t("ga4Sources")} caption={t("ga4CapSessions")} rows={bd.sources} color="#10B981" />
              <GA4Table title={t("ga4Countries")} caption={t("ga4CapUsers")} rows={bd.countries} color="#3B82F6" />
              <GA4Table title={t("ga4Devices")} caption={t("ga4CapSessions")} rows={bd.devices} color="#F59E0B" />
              <GA4Table title={t("ga4Events")} caption={t("ga4CapEvents")} rows={bd.events} color="#8B5CF6" />
            </div>
          )}

          <button onClick={unlinkProperty} style={{ alignSelf: "flex-end", fontSize: "12px", color: "var(--color-text-secondary)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
            {t("ga4Unlink")}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Indexing Tab ─────────────────────────────────────────────────────────────
function statusColor(s: string): string {
  if (/submitted and indexed/i.test(s))           return "#4ADE80";
  if (/crawled.*not indexed/i.test(s))            return "#FBBF24";
  if (/discovered.*not indexed/i.test(s))         return "#F97316";
  if (/unknown/i.test(s))                         return "#60A5FA";
  if (/excluded|blocked|not found|404|noindex/i.test(s)) return "#F87171";
  return "#94a3b8";
}

function statusCategory(s: string): string {
  if (/submitted and indexed/i.test(s))           return "indexed";
  if (/crawled.*not indexed/i.test(s))            return "notIndexed";
  if (/discovered.*not indexed/i.test(s))         return "discovered";
  return "other";
}

function timeAgo(date: string | Date): string {
  const ms = Date.now() - new Date(date).getTime();
  const mins  = Math.floor(ms / 60000);
  const hours = Math.floor(ms / 3600000);
  const days  = Math.floor(ms / 86400000);
  if (mins < 2)   return "just now";
  if (hours < 1)  return `${mins}m ago`;
  if (days < 1)   return `${hours}h ago`;
  return `${days}d ago`;
}

// ─── BacklinksTab ─────────────────────────────────────────────────────────────
function BacklinksTab({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();

  const [links,    setLinks]    = useState<any[]>([]);
  const [stats,    setStats]    = useState<any>({});
  const [loading,  setLoading]  = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Add URLs
  const [showAdd,   setShowAdd]   = useState(false);
  const [addText,   setAddText]   = useState("");
  const [adding,    setAdding]    = useState(false);

  // Check states
  const [checking404, setChecking404] = useState(false);
  const [checkingXr,  setCheckingXr]  = useState(false);
  const [submitting2i, setSubmitting2i] = useState(false);
  const [actionMsg,   setActionMsg]   = useState("");

  // Operations history
  const [ops,       setOps]       = useState<any[]>([]);
  const [showOps,   setShowOps]   = useState(false);
  const [opsLoading, setOpsLoading] = useState(false);

  // ── Display limit ──
  const [displayLimit, setDisplayLimit] = useState(50);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/backlinks?siteDbId=${siteDbId}`);
      const d = await res.json();
      setLinks(d.links ?? []);
      setStats(d.stats ?? {});
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, [siteDbId]);

  const handleAdd = async () => {
    const urls = addText.split(/[\n,]+/).map(s => s.trim()).filter(s => s.startsWith('http'));
    if (!urls.length) return;
    setAdding(true);
    try {
      await fetch('/api/backlinks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteDbId, urls }),
      });
      setAddText(''); setShowAdd(false);
      await load();
    } catch {}
    setAdding(false);
  };

  const handleDelete = async (ids: string[]) => {
    await fetch('/api/backlinks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteDbId, ids }),
    });
    setSelected(new Set());
    await load();
  };

  const handleCheck404 = async (all = false) => {
    setChecking404(true); setActionMsg('');
    const ids = !all && selected.size > 0 ? [...selected] : [];
    try {
      const res = await fetch('/api/backlinks/check-alive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteDbId, ids, forceAll: all }),
      });
      const d = await res.json();
      setActionMsg(`✓ ${t("idxChecked")} ${d.checked}: ${t("blAlive")} ${d.alive}, ${t("blDead")} ${d.dead}${d.blocked ? `, ${t("blBlocked")} ${d.blocked}` : ''}`);
      await load();
    } catch (e: any) { setActionMsg(`✗ ${e.message}`); }
    setChecking404(false);
  };

  const handleCheckXr = async () => {
    setCheckingXr(true); setActionMsg('');
    const ids = selected.size > 0 ? [...selected] : [];
    try {
      const res = await fetch('/api/backlinks/check-xr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteDbId, ids }),
      });
      const d = await res.json();
      setActionMsg(`✓ XML River: ${t("idxChecked")} ${d.checked}`);
      await load();
    } catch (e: any) { setActionMsg(`✗ ${e.message}`); }
    setCheckingXr(false);
  };

  const handleExport = () => {
    const csv = ['url,title,alive,alive_status,xr_status,2index,added']
      .concat(links.map(l => `"${l.url}","${l.title ?? ''}",${l.isAlive ?? ''},${l.aliveStatus ?? ''},${l.xrStatus ?? ''},${l.twoIndexStatus ?? ''},"${l.addedAt}"`))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `backlinks-${siteDbId}.csv`; a.click();
  };

  const loadOps = async () => {
    setOpsLoading(true);
    try {
      const res = await fetch(`/api/indexing/sitemap/operations?siteDbId=${siteDbId}&limit=30`);
      const d = await res.json();
      setOps((d.ops ?? []).filter((o: any) => o.type.startsWith('backlink')));
    } catch {}
    setOpsLoading(false);
  };

  const toggleSel = (id: string) => setSelected(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const toggleAll = () => setSelected(prev =>
    prev.size === links.length && links.length > 0 ? new Set() : new Set(links.map(l => l.id))
  );

  const displayed = links.slice(0, displayLimit);

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: "20px" }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      {/* The provider's view of the link graph, above the manually tracked list. Kept separate
          rather than merged: this one answers "what points at me", the list below answers "did
          the link I built survive". Merging them would lose the second question. */}
      <BacklinkProfile siteDbId={siteDbId} />

      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
        <h2 style={{ fontSize: "17px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("backlinksTitle")}</h2>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button onClick={() => handleCheck404(true)} disabled={checking404}
            style={{ display: "flex", alignItems: "center", gap: "5px", padding: "7px 13px", borderRadius: "8px", border: "none", background: "#3B82F6", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: checking404 ? "not-allowed" : "pointer", opacity: checking404 ? 0.6 : 1 }}>
            {checking404 ? t("backlinksChecking") : t("backlinksCheck404")}
          </button>
          <button onClick={handleCheckXr} disabled={checkingXr}
            style={{ display: "flex", alignItems: "center", gap: "5px", padding: "7px 13px", borderRadius: "8px", border: "none", background: "#10B981", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: checkingXr ? "not-allowed" : "pointer", opacity: checkingXr ? 0.6 : 1 }}>
            {checkingXr ? t("backlinksChecking") : t("backlinksIndexXr")}
          </button>
          <button onClick={handleExport}
            style={{ padding: "7px 13px", borderRadius: "8px", border: "none", background: "#F59E0B", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
            {t("backlinksExport")}
          </button>
        </div>
      </div>

      {/* ── Stats bar ── */}
      <div style={{ display: "flex", gap: "20px", flexWrap: "wrap", fontSize: "13px" }}>
        {[
          { label: t("backlinksTotal"), value: stats.total ?? 0, color: "var(--color-text-primary)" },
          { label: t("backlinksDead"),  value: stats.dead   ?? 0, color: "#F87171" },
          { label: t("backlinksAlive"), value: stats.alive  ?? 0, color: "#4ADE80" },
          { label: t("backlinksBlocked"), value: stats.blocked ?? 0, color: "#FBBF24" },
          { label: t("backlinksXrIndexed"), value: stats.xrIndexed ?? 0, color: "#60a5fa" },
        ].map(({ label, value, color }) => (
          <span key={label} style={{ fontWeight: 600 }}>
            {label} <span style={{ color }}>{value}</span>
          </span>
        ))}
        {actionMsg && <span style={{ color: actionMsg.startsWith('✓') ? "#4ADE80" : "#F87171", fontWeight: 600 }}>{actionMsg}</span>}
      </div>

      {/* ── Add URLs block ── */}
      <div style={{ background: "var(--color-card)", borderRadius: "12px", border: "1px solid var(--color-border)", overflow: "hidden" }}>
        <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>{t("backlinksAdd")}</span>
          <button onClick={() => setShowAdd(o => !o)}
            style={{ fontSize: "12px", padding: "4px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>
            {showAdd ? "▲" : "▼"}
          </button>
        </div>
        {showAdd && (
          <div style={{ padding: "0 16px 14px", borderTop: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: "8px" }}>
            <textarea
              value={addText} onChange={e => setAddText(e.target.value)}
              placeholder={t("backlinksAddPlaceholder")}
              rows={6}
              style={{ width: "100%", fontSize: "12px", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", resize: "vertical", fontFamily: "monospace", boxSizing: "border-box", marginTop: "10px" }}
            />
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={handleAdd} disabled={adding || !addText.trim()}
                style={{ padding: "7px 18px", borderRadius: "8px", border: "none", background: "#3B82F6", color: "#fff", fontSize: "12px", fontWeight: 700, cursor: adding ? "not-allowed" : "pointer", opacity: adding ? 0.7 : 1 }}>
                {adding ? t("backlinksChecking") : t("backlinksAddBtn")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Loading ── */}
      {loading && (
        <div style={{ display: "flex", justifyContent: "center", padding: "30px 0" }}>
          <div style={{ width: 22, height: 22, border: "2px solid var(--color-border)", borderTopColor: "#3B82F6", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && links.length === 0 && (
        <div style={{ textAlign: "center", padding: "50px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
          <Link2 size={36} color="var(--color-text-secondary)" style={{ opacity: 0.25 }} />
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", maxWidth: "360px", lineHeight: 1.6 }}>{t("backlinksEmpty")}</p>
        </div>
      )}

      {/* ── Selection toolbar ── */}
      {selected.size > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 12px", background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.25)", borderRadius: "8px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "12px", color: "#60a5fa", fontWeight: 600 }}>{selected.size} {t("backlinksSelected")}</span>
          <button onClick={() => handleCheck404(false)} disabled={checking404}
            style={{ padding: "4px 10px", borderRadius: "6px", border: "1px solid rgba(59,130,246,0.35)", background: "transparent", color: "#60a5fa", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>
            Check 404
          </button>
          <button onClick={handleCheckXr} disabled={checkingXr}
            style={{ padding: "4px 10px", borderRadius: "6px", border: "1px solid rgba(16,185,129,0.35)", background: "transparent", color: "#34d399", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>
            {t("backlinksIndexXr")}
          </button>
          <button onClick={() => handleDelete([...selected])}
            style={{ padding: "4px 10px", borderRadius: "6px", border: "1px solid rgba(239,68,68,0.35)", background: "transparent", color: "#f87171", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>
            {t("backlinksDelete")}
          </button>
          <button onClick={() => setSelected(new Set())}
            style={{ padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: "11px", cursor: "pointer" }}>
            {t("backlinksClearSel")}
          </button>
        </div>
      )}

      {/* ── Table ── */}
      {links.length > 0 && (
        <div style={{ background: "var(--color-card)", borderRadius: "12px", border: "1px solid var(--color-border)", overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", minWidth: "700px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--color-border)", background: "rgba(255,255,255,0.02)" }}>
                  <th style={{ padding: "9px 12px", width: 32 }}>
                    <input type="checkbox" checked={selected.size === links.length && links.length > 0} onChange={toggleAll}
                      style={{ cursor: "pointer", width: 13, height: 13, accentColor: "#3B82F6" }} />
                  </th>
                  {[t("backlinksColUrl"), t("backlinksColDate"), t("backlinksColTitle"), t("backlinksColAlive"), t("backlinksColXr"), t("backlinks2index"), t("backlinksColActions")].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "9px 12px", color: "var(--color-text-secondary)", fontWeight: 500, fontSize: "10px", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayed.map((link, i) => {
                  const isSelected = selected.has(link.id);
                  const path = link.url.replace(/^https?:\/\/[^/]+/, "") || "/";
                  const host = (() => { try { return new URL(link.url).hostname; } catch { return link.url; } })();
                  return (
                    <tr key={link.id} style={{ borderBottom: "1px solid var(--color-border)", background: isSelected ? "rgba(59,130,246,0.05)" : i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.012)" }}>
                      <td style={{ padding: "8px 12px" }}>
                        <input type="checkbox" checked={isSelected} onChange={() => toggleSel(link.id)}
                          style={{ cursor: "pointer", width: 13, height: 13, accentColor: "#3B82F6" }} />
                      </td>
                      {/* URL */}
                      <td style={{ padding: "8px 12px", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <div style={{ fontWeight: 600, fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: "1px" }}>{host}</div>
                        <a href={link.url} target="_blank" rel="noreferrer" title={link.url}
                          style={{ color: "#60a5fa", textDecoration: "none", fontSize: "11px" }}
                          onMouseOver={e => (e.currentTarget.style.textDecoration = "underline")}
                          onMouseOut={e => (e.currentTarget.style.textDecoration = "none")}>{path || "/"}</a>
                      </td>
                      {/* Date */}
                      <td style={{ padding: "8px 12px", fontSize: "11px", color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                        {timeAgo(new Date(link.addedAt))}
                      </td>
                      {/* Title */}
                      <td style={{ padding: "8px 12px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "11px", color: "var(--color-text-primary)" }}>
                        {link.title ?? <span style={{ color: "rgba(255,255,255,0.2)" }}>—</span>}
                      </td>
                      {/* Alive */}
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                        {(() => {
                          // aliveStatus is authoritative when present; isAlive is the legacy fallback.
                          // "blocked" (amber) is neither alive nor dead — it means bot protection hid
                          // the page, and must never be shown as a death.
                          const st = link.aliveStatus === 'alive' || link.aliveStatus === 'dead' || link.aliveStatus === 'blocked'
                            ? link.aliveStatus
                            : link.isAlive === true ? 'alive' : link.isAlive === false ? 'dead' : 'unknown';
                          if (st === 'alive')   return <span style={{ color: "#4ADE80", fontWeight: 600, fontSize: "11px" }}>✓ {t("blAliveFull")}</span>;
                          if (st === 'dead')    return <span style={{ color: "#F87171", fontWeight: 600, fontSize: "11px" }}>✗ {t("blDeadFull")}</span>;
                          if (st === 'blocked') return <span style={{ color: "#FBBF24", fontWeight: 600, fontSize: "11px" }}>⚠ {t("blBlockedFull")}</span>;
                          return <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "11px" }}>—</span>;
                        })()}
                      </td>
                      {/* XR */}
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                        {link.xrStatus
                          ? <span style={{ fontSize: "11px", color: link.xrStatus === "indexed" ? "#4ADE80" : link.xrStatus === "error" ? "#F87171" : "#FBBF24", fontWeight: 600 }}>
                              {link.xrStatus === "indexed" ? `✓ ${t("idxInIndex")}` : link.xrStatus === "error" ? "⚠ Error" : `✗ ${t("idxNotInIndex")}`}
                            </span>
                          : <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "11px" }}>—</span>
                        }
                      </td>
                      {/* 2index */}
                      <td style={{ padding: "8px 12px" }}>
                        {link.twoIndexStatus === "submitted"
                          ? <span style={{ fontSize: "11px", color: "#34d399", fontWeight: 600 }}>✓ {t("idxSent")}</span>
                          : <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "11px" }}>—</span>
                        }
                      </td>
                      {/* Actions */}
                      <td style={{ padding: "8px 12px" }}>
                        <button onClick={() => handleDelete([link.id])}
                          style={{ padding: "3px 9px", borderRadius: "5px", border: "1px solid rgba(239,68,68,0.3)", background: "transparent", color: "#f87171", fontSize: "10px", fontWeight: 600, cursor: "pointer" }}>
                          {t("backlinksDelete")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {links.length > displayLimit && (
            <div style={{ padding: "12px", textAlign: "center", borderTop: "1px solid var(--color-border)" }}>
              <button onClick={() => setDisplayLimit(n => n + 100)}
                style={{ padding: "7px 20px", borderRadius: "20px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: "12px", cursor: "pointer" }}>
                {t("backlinksShowMore")} ({links.length - displayLimit})
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Operations history ── */}
      <div style={{ background: "var(--color-card)", borderRadius: "12px", border: "1px solid var(--color-border)", overflow: "hidden" }}>
        <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>🕐 {t("backlinksOpsTitle")}</span>
          <button onClick={() => { setShowOps(o => !o); if (!showOps) loadOps(); }}
            style={{ fontSize: "12px", padding: "4px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>
            {showOps ? "▲" : t("backlinksOpsRefresh")}
          </button>
        </div>
        {showOps && (
          <div style={{ borderTop: "1px solid var(--color-border)" }}>
            {opsLoading ? (
              <div style={{ padding: "20px", textAlign: "center" }}>
                <div style={{ width: 18, height: 18, border: "2px solid var(--color-border)", borderTopColor: "#3B82F6", borderRadius: "50%", animation: "spin 0.8s linear infinite", display: "inline-block" }} />
              </div>
            ) : ops.length === 0 ? (
              <div style={{ padding: "16px", textAlign: "center", fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("backlinksOpsEmpty")}</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <thead>
                  <tr style={{ background: "rgba(255,255,255,0.02)" }}>
                    {[t("blColOperation"), t("idxColSummary"), t("idxColDate")].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "8px 14px", color: "var(--color-text-secondary)", fontWeight: 500, fontSize: "10px", letterSpacing: "0.06em" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ops.map((op: any, i: number) => (
                    <tr key={op.id} style={{ borderTop: "1px solid var(--color-border)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)" }}>
                      <td style={{ padding: "8px 14px", fontWeight: 600, color: "var(--color-text-primary)" }}>
                        {op.type === 'backlink_check_alive' ? t('opCheck404') : op.type === 'backlink_check_xr' ? t('opXmlRiver') : op.type}
                      </td>
                      <td style={{ padding: "8px 14px" }}>
                        <span style={{ color: op.result === 'success' ? "#4ADE80" : "#F87171", fontWeight: 600 }}>{op.result}</span>
                        {op.urlCount != null && <span style={{ color: "var(--color-text-secondary)", marginLeft: 4 }}>· {op.urlCount} URL</span>}
                        {op.detail && <span style={{ color: "var(--color-text-secondary)", marginLeft: 4 }}>· {op.detail}</span>}
                      </td>
                      <td style={{ padding: "8px 14px", color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>{timeAgo(new Date(op.createdAt))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function IndexingTab({ siteDbId, domain }: { siteDbId: string; domain: string }) {
  const { t } = useLanguage();
  // ── URL list state ──
  const [urlRows,    setUrlRows]    = useState<any[]>([]);
  const [counters,   setCounters]   = useState<any>({});
  const [meta,       setMeta]       = useState<any>({});
  const [total,      setTotal]      = useState(0);
  const [pages,      setPages]      = useState(1);
  const [page,       setPage]       = useState(1);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search,     setSearch]     = useState("");
  const [loading,    setLoading]    = useState(false);

  // ── Sitemap sync state ──
  const [syncing,    setSyncing]    = useState(false);
  const [syncError,  setSyncError]  = useState("");
  const [syncNotice, setSyncNotice] = useState("");
  const [customSitemapUrl, setCustomSitemapUrl] = useState("");
  const [crawlInterval, setCrawlInterval] = useState("disabled");
  const [metadataChecking, setMetadataChecking] = useState(false);
  const [metadataMsg, setMetadataMsg] = useState("");
  const [auditStarting, setAuditStarting] = useState(false);
  const [auditSeedMsg, setAuditSeedMsg] = useState("");

  // ── Selection ──
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // ── API keys ──
  const [hasNeural,   setHasNeural]   = useState(false);
  const [hasXmlRiver, setHasXmlRiver] = useState(false);
  const [hasTwoIndex, setHasTwoIndex] = useState(false);

  // ── Custom Bot Farm Indexer ──
  const [indexerDomains, setIndexerDomains] = useState<any[]>([]);
  // "all" mirrors the Indexer's own default: let the queue distribute URLs across every doorway
  // domain instead of making the operator pick one per submission.
  const [selectedFarmDomainId, setSelectedFarmDomainId] = useState("all");
  const [submittingToFarm, setSubmittingToFarm] = useState(false);
  const [farmSubmitResult, setFarmSubmitResult] = useState<string | null>(null);

  // ── Submit state ──
  const [submitting,   setSubmitting]   = useState(false);
  const [submitResult, setSubmitResult] = useState<any>(null);
  const [nnQueue,      setNnQueue]      = useState<"slow"|"fast"|"yandex">("slow");

  // ── Google check ──
  const [checking,  setChecking]  = useState(false);
  const [checkMsg,  setCheckMsg]  = useState("");

  // ── XR / Neural indexation check ──
  const [xrChecking,  setXrChecking]  = useState(false);
  const [xrCheckMsg,  setXrCheckMsg]  = useState("");

  // ── Operations history ──
  const [ops,      setOps]      = useState<any[]>([]);
  const [showOps,  setShowOps]  = useState(false);
  const [opsLoading, setOpsLoading] = useState(false);

  // ── Load URL list ──
  const loadUrls = async (pg = page, sf = statusFilter, sq = search) => {
    if (!siteDbId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ siteDbId, page: String(pg), limit: "50", status: sf, search: sq });
      const res = await fetch(`/api/indexing/sitemap/urls?${params}`);
      const d = await res.json();
      setUrlRows(d.rows ?? []);
      setCounters(d.counters ?? {});
      setMeta(d.meta ?? {});
      setTotal(d.total ?? 0);
      setPages(d.pages ?? 1);
      if (d.meta?.crawlInterval) setCrawlInterval(d.meta.crawlInterval);
      if (d.meta?.sitemapUrl) setCustomSitemapUrl(d.meta.sitemapUrl);
    } catch {}
    setLoading(false);
  };

  // ── Load API keys and Private Indexer domains ──
  useEffect(() => {
    fetch("/api/settings/api-keys")
      .then(r => r.json())
      .then(d => {
        setHasNeural(d.neuralIndexer?.configured ?? false);
        setHasXmlRiver(d.xmlRiver?.configured ?? false);
        setHasTwoIndex(d.twoIndex?.configured ?? false);
      }).catch(() => {});

    fetch("/api/indexer/domains")
      .then(r => r.json())
      .then(d => {
        if (Array.isArray(d)) {
          setIndexerDomains(d);
          if (d.length > 0) setSelectedFarmDomainId(d[0].id);
        }
      }).catch(() => {});
  }, []);

  useEffect(() => { loadUrls(1, statusFilter, search); }, [siteDbId]);

  // ── Sitemap sync ──
  const runSync = async () => {
    setSyncing(true); setSyncError(""); setSyncNotice(""); setSubmitResult(null);
    try {
      const res = await fetch("/api/indexing/sitemap/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteDbId, sitemapUrl: customSitemapUrl || undefined, crawlInterval }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? t("errSyncFailed"));
      setSyncNotice(d.partial ? t("idxPartialSync") : t("idxSyncComplete"));
      await loadUrls(1, statusFilter, search);
    } catch (e: any) { setSyncError(e.message); }
    setSyncing(false);
  };

  const verifyInventoryMetadata = async () => {
    setMetadataChecking(true); setMetadataMsg("");
    try {
      const res = await fetch("/api/indexing/sitemap/metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteDbId, ...(selected.size ? { urls: [...selected] } : {}) }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? t("errSyncFailed"));
      setMetadataMsg(t("idxMetadataVerified").replace("{n}", String(d.checked ?? 0)) + (d.errors ? ` · ${d.errors} ${t("idxErrors")}` : ""));
      await loadUrls(page, statusFilter, search);
    } catch (error: any) {
      setMetadataMsg(`✗ ${error.message}`);
    }
    setMetadataChecking(false);
  };

  const startSitemapAudit = async () => {
    setAuditStarting(true); setAuditSeedMsg("");
    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, maxPages: Math.max(10, Math.min(500, counters.active || 200)), seedFromSitemap: true }),
      });
      const d = await res.json();
      if (res.status === 409 && d.error === "already_running") setAuditSeedMsg(t("idxAuditAlreadyRunning"));
      else if (!res.ok) throw new Error(d.error ?? t("errSyncFailed"));
      else setAuditSeedMsg(t("idxAuditStarted"));
    } catch (error: any) {
      setAuditSeedMsg(`✗ ${error.message}`);
    }
    setAuditStarting(false);
  };

  // ── Google URL Inspection check ──
  const runGoogleCheck = async () => {
    const urls = selected.size > 0 ? [...selected] : urlRows.filter(r => !r.googleStatus).map(r => r.url);
    if (!urls.length) return;
    setChecking(true); setCheckMsg("");
    try {
      const res = await fetch("/api/indexing/sitemap/check-google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteDbId, urls }),
      });
      const d = await res.json();
      if (d.hint === "sc-domain_not_supported") {
        setCheckMsg(`⚠ ${t("idxGoogleScDomainError")}`);
      } else if (d.hint === "property_not_verified") {
        setCheckMsg(`⚠ ${t("idxGoogleNotVerifiedError")}`);
      } else if (d.hint === "api_error") {
        setCheckMsg(`✗ ${d.detail ?? t("idxErrors")}`);
      } else {
        setCheckMsg(`✓ ${t("idxChecked")} ${d.checked ?? 0} URLs${d.errors ? ` · ${d.errors} ${t("idxErrors")}` : ""}`);
        await loadUrls(page, statusFilter, search);
      }
    } catch (e: any) { setCheckMsg(`✗ ${e.message}`); }
    setChecking(false);
  };

  // ── NeuralIndexer submit ──
  const runNeuralSubmit = async () => {
    const urls = selected.size > 0
      ? [...selected]
      : urlRows.filter(r => r.neuralStatus !== "submitted").map(r => r.url);
    if (!urls.length) return;
    setSubmitting(true); setSubmitResult(null);
    try {
      const res = await fetch("/api/indexing/neural", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls, queue: nnQueue, label: domain, siteDbId }),
      });
      const d = await res.json();
      setSubmitResult(d);
      if (d.ok) await loadUrls(page, statusFilter, search);
    } catch {}
    setSubmitting(false);
  };

  // ── Private Bot Farm submit ──
  const runFarmSubmit = async () => {
    // No guard on an empty selection any more: the picker defaults to "all", which the queue
    // endpoint already understands as "spread these across every doorway domain, round-robin".
    // The old check refused to submit while the select visibly showed a domain — the state
    // started empty but the browser renders the first <option>, so the two disagreed and the
    // button answered "choose a domain first" for a domain that was on screen.
    const urls = selected.size > 0
      ? [...selected]
      : urlRows.map(r => r.url);

    if (!urls.length) return;
    setSubmittingToFarm(true);
    setFarmSubmitResult(null);

    try {
      const res = await fetch("/api/indexer/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domainId: selectedFarmDomainId,
          urls,
        }),
      });
      const d = await res.json();
      if (res.ok && d.success) {
        setFarmSubmitResult(`✓ ${t("farmQueuedN").replace("{n}", String(d.count))}`);
        setSelected(new Set());
        await loadUrls(page, statusFilter, search);
      } else {
        setFarmSubmitResult(`✗ ${d.error || t("farmFailedToSubmit")}`);
      }
    } catch (e: any) {
      setFarmSubmitResult(`✗ ${e.message}`);
    } finally {
      setSubmittingToFarm(false);
    }
  };

  // ── XMLRiver / NeuralIndexer indexation check ──
  const runXrCheck = async (via: "xr" | "neural") => {
    // If nothing selected — fetch ALL site URLs (not just current page)
    let urls: string[];
    if (selected.size > 0) {
      urls = [...selected];
    } else {
      try {
        const allRes = await fetch(`/api/indexing/sitemap/urls?siteDbId=${siteDbId}&page=1&limit=1000`);
        const allData = await allRes.json();
        urls = (allData.rows ?? []).map((r: any) => r.url);
      } catch {
        urls = urlRows.map(r => r.url);
      }
    }
    if (!urls.length) return;
    setXrChecking(true); setXrCheckMsg("");

    try {
      const endpoint = via === "neural" ? "/api/indexing/neural/check" : "/api/indexing/xmlriver";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteDbId, urls }),
      });
      const d = await res.json();
      if (!res.ok) { setXrCheckMsg(`✗ ${d.error ?? t("errGeneric")}`); setXrChecking(false); return; }

      // XMLRiver: synchronous result
      if (!d.pending) {
        const ok = d.checked ?? 0;
        const err = d.errors ?? 0;
        setXrCheckMsg(`✓ ${t("idxChecked")} ${ok} URLs${err ? ` · ${err} ${t("idxErrors")}` : ""}${d.charged != null ? ` · $${Number(d.charged).toFixed(4)}` : ""}`);
        await loadUrls(page, statusFilter, search);
        setXrChecking(false);
        return;
      }

      // Neural: poll /status every 10s until done (no new tasks created)
      const checkId: string = d.checkId;
      const est: number = d.estimatedMinutes ?? 3;
      setXrCheckMsg(t("neuralProcessing").replace("{n}", String(d.urlCount)).replace("{min}", String(est)));

      const maxAttempts = Math.max(30, est * 8); // 10s × attempts ≥ estimated time
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 10000)); // wait 10s
        try {
          const sRes = await fetch(`/api/indexing/neural/status?checkId=${encodeURIComponent(checkId)}&siteDbId=${siteDbId}`);
          const s = await sRes.json();
          if (s.failed) { setXrCheckMsg(`✗ ${t("neuralCheckFailed")}`); break; }
          if (s.done) {
            setXrCheckMsg(`✓ ${t("idxChecked")} ${s.checked} URLs · ${s.indexed} ${t("idxInIndex")}${s.charged != null ? ` · $${Number(s.charged).toFixed(4)}` : ""}`);
            await loadUrls(page, statusFilter, search);
            break;
          }
          // Still processing — update progress
          const pct = s.totalLinks > 0 ? Math.round((s.checkedLinks / s.totalLinks) * 100) : 0;
          const prog = t("neuralProgress").replace("{checked}", String(s.checkedLinks ?? 0)).replace("{total}", String(s.totalLinks ?? d.urlCount));
          setXrCheckMsg(pct > 0 ? `${prog} (${pct}%)` : prog);
        } catch { /* network error, retry */ }
      }
    } catch (e: any) { setXrCheckMsg(`✗ ${(e as any).message}`); }
    setXrChecking(false);
  };

  // ── 2index.ninja submit ──
  const runTwoIndexSubmit = async () => {
    const urls = selected.size > 0 ? [...selected] : urlRows.map(r => r.url);
    if (!urls.length) return;
    setSubmitting(true); setSubmitResult(null);
    try {
      const res = await fetch("/api/indexing/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const d = await res.json();
      setSubmitResult({ submitted: d.submitted ?? 0, total: d.total ?? urls.length });
    } catch {}
    setSubmitting(false);
  };

  // ── Operations history ──
  const loadOps = async () => {
    if (opsLoading) return;
    setOpsLoading(true);
    try {
      const res = await fetch(`/api/indexing/sitemap/operations?siteDbId=${siteDbId}&limit=50`);
      const d = await res.json();
      setOps(d.ops ?? []);
    } catch {}
    setOpsLoading(false);
  };

  // ── Selection helpers ──
  const toggleSelect = (url: string) => setSelected(prev => {
    const n = new Set(prev); n.has(url) ? n.delete(url) : n.add(url); return n;
  });
  const toggleAll = () => setSelected(prev =>
    prev.size === urlRows.length && urlRows.length > 0 ? new Set() : new Set(urlRows.map(r => r.url))
  );

  // ── Helpers ──
  const googleStatusColor = (s: string | null) => {
    if (!s) return "rgba(255,255,255,0.2)";
    if (/submitted and indexed/i.test(s)) return "#4ADE80";
    if (/not on google/i.test(s) || /not indexed/i.test(s)) return "#F87171";
    return "#FBBF24";
  };
  const googleStatusLabel = (s: string | null) => {
    if (!s) return "—";
    if (/submitted and indexed/i.test(s)) return t("idxInIndex");
    if (/not on google/i.test(s)) return t("idxNotFoundGoogle");
    if (/crawled/i.test(s)) return t("idxCrawledNotIndexed");
    if (/discovered/i.test(s)) return t("idxDiscoveredNotIndexed");
    if (/blocked/i.test(s)) return t("idxBlocked");
    return s;
  };
  const inventoryStatusLabel = (row: any) => {
    if (row.inventoryStatus === "missing") return t("idxMissing");
    if (row.inventoryStatus === "pending_missing") return t("idxPendingMissing");
    if (row.changeStatus === "added") return t("idxAdded");
    if (row.changeStatus === "changed") return t("idxChanged");
    if (row.changeStatus === "restored") return t("idxRestored");
    return t("idxInventoryActive");
  };
  const inventoryStatusColor = (row: any) => row.inventoryStatus === "missing" ? "#F87171"
    : row.inventoryStatus === "pending_missing" ? "#FBBF24"
    : row.changeStatus === "added" ? "#4ADE80"
    : row.changeStatus === "changed" ? "#FBBF24"
    : row.changeStatus === "restored" ? "#60A5FA"
    : "var(--color-text-secondary)";
  const opTypeLabel = (type: string) => {
    const m: Record<string,string> = {
      sitemap_sync: t("opSyncSitemap"), google_check: t("opGoogleCheck"),
      xr_check: t("opXmlRiver"), "2index_submit": t("op2indexSubmit"), neural_submit: "NeuralIndexer",
      sitemap_metadata: t("idxVerifyMetadata"),
      backlink_check_alive: "Check 404", backlink_check_xr: "XML River",
    };
    return m[type] ?? type;
  };
  const operationDetail = (op: any) => {
    if (!op.detail?.startsWith("{")) return op.detail ?? "—";
    try {
      const detail = JSON.parse(op.detail);
      if (op.type === "sitemap_sync") {
        const summary = detail.summary ?? {};
        return `${detail.sitemapUrl ?? "sitemap"} · +${summary.added ?? 0} · Δ${summary.changed ?? 0} · −${summary.disappeared ?? 0}${summary.partial ? " · partial" : ""}`;
      }
      if (op.type === "sitemap_metadata") return `${detail.checked ?? 0} checked · ${detail.suspicious ?? 0} suspicious · ${detail.errors ?? 0} errors`;
      return op.detail;
    } catch { return op.detail; }
  };

  const hasData = urlRows.length > 0 || counters.total > 0;

  const COUNTER_CHIPS = [
    { label: t("idxTotal"), value: counters.total ?? 0, color: "var(--color-text-primary)", filter: "all" },
    { label: `Neural ✓`, value: counters.neuralChecked ?? 0, color: "#a78bfa", filter: "neural_indexed" },
    { label: t("idxInIndex"), value: counters.indexed ?? 0, color: "#4ADE80", filter: "indexed" },
    { label: t("idxNotInIndex"), value: counters.notIndexed ?? 0, color: "#F87171", filter: "not_indexed" },
    { label: t("idxNotChecked"), value: counters.notChecked ?? 0, color: "#FBBF24", filter: "not_checked" },
    { label: t("idxNeuralSent"), value: counters.neuralSubmitted ?? 0, color: "#64748b", filter: "all" },
  ];

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: "20px" }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      {/* ── Search engines: Bing / Yandex / IndexNow actions ── */}
      <SearchEnginesPanel siteDbId={siteDbId} domain={domain} />

      {/* ── Sitemap sync card ── */}
      <div style={{ background: "var(--color-card)", borderRadius: "12px", border: "1px solid var(--color-border)", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>🗺 {t("idxAutoCrawl")}</span>
            {meta.lastSitemapSync && (
              <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>
                · {t("idxUpdated")} {timeAgo(new Date(meta.lastSitemapSync))}
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("idxInterval")}</span>
            <select value={crawlInterval} onChange={e => setCrawlInterval(e.target.value)}
              style={{ fontSize: "12px", padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", cursor: "pointer" }}>
              {[["disabled",t("idxDisabled")],["daily",t("idxDaily")],["weekly",t("idxWeekly")],["monthly",t("idxMonthly")]].map(([v,l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <button onClick={runSync} disabled={syncing}
              style={{ padding: "6px 16px", borderRadius: "8px", border: "none", background: syncing ? "rgba(59,130,246,0.3)" : "#3B82F6", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: syncing ? "not-allowed" : "pointer" }}>
              {syncing ? t("idxSyncing") : t("idxSyncPages")}
            </button>
          </div>
        </div>
        {/* Custom sitemap URL row */}
        <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: "8px", background: "rgba(255,255,255,0.01)" }}>
          <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>Sitemap URL:</span>
          <input
            value={customSitemapUrl}
            onChange={e => setCustomSitemapUrl(e.target.value)}
            placeholder={`${meta.siteUrl ?? "https://example.com"}/sitemap.xml`}
            style={{ flex: 1, fontSize: "12px", padding: "5px 10px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", maxWidth: "480px" }}
          />
        </div>
        {counters.total > 0 && (
          <div style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-text-primary)", marginRight: 2 }}>{t("idxInventory")}</span>
            {[
              [t("idxInventoryActive"), counters.active ?? 0, "inventory_active", "#4ADE80"],
              [t("idxAdded"), counters.added ?? 0, "inventory_added", "#34D399"],
              [t("idxChanged"), counters.changed ?? 0, "inventory_changed", "#FBBF24"],
              [t("idxPendingMissing"), counters.pendingMissing ?? 0, "inventory_pending", "#F59E0B"],
              [t("idxMissing"), counters.missing ?? 0, "inventory_missing", "#F87171"],
              [t("idxSuspiciousLastmod"), counters.suspiciousLastmod ?? 0, "lastmod_suspicious", "#FB7185"],
            ].map(([label, value, filter, color]) => (
              <button key={String(filter)} onClick={() => { setStatusFilter(String(filter)); setPage(1); loadUrls(1, String(filter), search); }}
                style={{ padding: "4px 8px", borderRadius: 999, border: `1px solid ${color}45`, background: `${color}10`, color: String(color), fontSize: "10px", cursor: "pointer" }}>
                {String(label)} · {String(value)}
              </button>
            ))}
            {(meta.latestSync?.summary?.invalid ?? 0) > 0 && (
              <span title={(meta.latestSync?.invalidExamples ?? []).join("\n")} style={{ padding: "4px 8px", borderRadius: 999, border: "1px solid rgba(248,113,113,0.3)", background: "rgba(248,113,113,0.08)", color: "#F87171", fontSize: "10px" }}>
                {t("idxInvalid")} · {meta.latestSync.summary.invalid}
              </span>
            )}
            <span style={{ fontSize: "10px", color: "var(--color-text-secondary)", marginLeft: "auto" }}>
              {t("idxAuditCoverage")}: {counters.auditCovered ?? 0}/{counters.total ?? 0}
            </span>
          </div>
        )}
        {counters.total > 0 && (
          <div style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", background: "rgba(255,255,255,0.01)" }}>
            <button onClick={verifyInventoryMetadata} disabled={metadataChecking}
              style={{ padding: "6px 12px", borderRadius: "7px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-primary)", fontSize: "11px", fontWeight: 600, cursor: metadataChecking ? "not-allowed" : "pointer", opacity: metadataChecking ? 0.6 : 1 }}>
              {metadataChecking ? t("idxVerifyingMetadata") : `${t("idxVerifyMetadata")}${selected.size ? ` (${selected.size})` : ""}`}
            </button>
            <button onClick={startSitemapAudit} disabled={auditStarting}
              style={{ padding: "6px 12px", borderRadius: "7px", border: "1px solid rgba(139,92,246,0.35)", background: "rgba(139,92,246,0.08)", color: "#A78BFA", fontSize: "11px", fontWeight: 600, cursor: auditStarting ? "not-allowed" : "pointer", opacity: auditStarting ? 0.6 : 1 }}>
              {auditStarting ? t("auditRunning") : t("idxAuditFromSitemap")}
            </button>
            {metadataMsg && <span style={{ fontSize: "11px", color: metadataMsg.startsWith("✗") ? "#F87171" : "#4ADE80" }}>{metadataMsg}</span>}
            {auditSeedMsg && <span style={{ fontSize: "11px", color: auditSeedMsg.startsWith("✗") ? "#F87171" : "#A78BFA" }}>{auditSeedMsg}</span>}
          </div>
        )}
        {(syncNotice || meta.latestSync?.result === "partial") && (
          <div style={{ padding: "8px 16px", background: meta.latestSync?.result === "partial" ? "rgba(245,158,11,0.08)" : "rgba(74,222,128,0.05)", borderTop: "1px solid var(--color-border)", fontSize: "11px", color: meta.latestSync?.result === "partial" ? "#FBBF24" : "#4ADE80" }}>
            {meta.latestSync?.result === "partial" ? `⚠ ${t("idxPartialSync")}. ${t("idxPartialSyncHint")}` : `✓ ${syncNotice || t("idxSyncComplete")}`}
            {meta.latestSync?.summary?.invalid > 0 && <span> · {t("idxInvalid")}: {meta.latestSync.summary.invalid}</span>}
          </div>
        )}
        {syncError && (
          <div style={{ padding: "8px 16px", background: "rgba(239,68,68,0.06)", borderTop: "1px solid rgba(239,68,68,0.2)", fontSize: "12px", color: "#f87171" }}>
            ✗ {syncError}
          </div>
        )}
      </div>

      {/* ── Status counters ── */}
      {counters.total > 0 && (
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {COUNTER_CHIPS.map(({ label, value, color, filter }) => (
            <button key={label} onClick={() => { setStatusFilter(filter); loadUrls(1, filter, search); }}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "10px 18px", borderRadius: "10px", border: `1px solid ${statusFilter === filter && filter !== "all" ? color + "55" : "var(--color-border)"}`, background: statusFilter === filter && filter !== "all" ? `${color}10` : "var(--color-card)", cursor: "pointer", minWidth: "80px", gap: "2px" }}>
              <span style={{ fontSize: "22px", fontWeight: 700, color }}>{value}</span>
              <span style={{ fontSize: "10px", color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Search + filter bar ── */}
      {counters.total > 0 && (
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === "Enter" && loadUrls(1, statusFilter, search)}
            placeholder={t("idxSearchUrl")}
            style={{ fontSize: "12px", padding: "6px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", minWidth: "200px" }}
          />
          <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); loadUrls(1, e.target.value, search); }}
            style={{ fontSize: "12px", padding: "6px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", cursor: "pointer" }}>
            {[
              ["all", t("idxAllStatuses")],
              ["indexed", `✓ ${t("idxInIndex")}`],
              ["not_indexed", `✗ ${t("idxNotInIndex")}`],
              ["not_checked", t("idxNotChecked")],
              ["neural_indexed", `Neural: ✓ ${t("idxInIndex")}`],
              ["neural_not_indexed", `Neural: ✗ ${t("idxNotInIndex")}`],
              ["inventory_active", t("idxInventoryActive")],
              ["inventory_added", t("idxAdded")],
              ["inventory_changed", t("idxChanged")],
              ["inventory_pending", t("idxPendingMissing")],
              ["inventory_missing", t("idxMissing")],
              ["lastmod_suspicious", t("idxSuspiciousLastmod")],
              ["audit_missing", t("idxNotAudited")],
            ].map(([v,l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>

          {/* Google API check button */}
          <button onClick={runGoogleCheck} disabled={checking}
            style={{ display: "flex", alignItems: "center", gap: "5px", padding: "6px 12px", borderRadius: "8px", border: "1px solid rgba(66,133,244,0.35)", background: "rgba(66,133,244,0.08)", color: "#60a5fa", fontSize: "12px", fontWeight: 600, cursor: checking ? "not-allowed" : "pointer", opacity: checking ? 0.6 : 1 }}>
            <GoogleIcon size={13} />
            {checking ? t("idxChecking") : selected.size > 0 ? `Google API (${selected.size})` : t("idxGoogleApiCheck")}
          </button>

          {checkMsg && (
            <span style={{ fontSize: "12px", color: checkMsg.startsWith("✓") ? "#4ADE80" : "#F87171", fontWeight: 600 }}>{checkMsg}</span>
          )}

          {selected.size > 0 && (
            <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginLeft: "4px" }}>
              {t("idxSelected")} {selected.size}
              <button onClick={() => setSelected(new Set())} style={{ marginLeft: "6px", background: "none", border: "none", color: "var(--color-text-secondary)", cursor: "pointer", fontSize: "11px" }}>✕</button>
            </span>
          )}
        </div>
      )}

      {/* ── Indexer submission toolbar ── */}
      {counters.total > 0 && (hasNeural || hasXmlRiver || hasTwoIndex || indexerDomains.length > 0) && (
        <div style={{ borderRadius: "12px", background: "var(--color-card)", border: "1px solid var(--color-border)", overflow: "hidden" }}>
          {indexerDomains.length > 0 && (
            <div style={{
              padding: "10px 14px",
              borderBottom: hasNeural || hasXmlRiver || hasTwoIndex ? "1px solid var(--color-border)" : "none",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap"
            }}>
              <div style={{
                width: 22, height: 22, borderRadius: "5px",
                background: "linear-gradient(135deg, rgba(41,151,255,0.3), rgba(52,199,89,0.3))",
                border: "1px solid rgba(41,151,255,0.4)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "9px", fontWeight: 800, color: "var(--color-accent-blue)"
              }}>PF</div>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-accent-blue)" }}>Private Bot Farm</span>
              <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>
                {selected.size > 0 ? `· ${selected.size} selected` : `· All ${counters.total} URLs`}
              </span>
              
              <select
                value={selectedFarmDomainId}
                onChange={e => setSelectedFarmDomainId(e.target.value)}
                style={{
                  background: "var(--color-bg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "6px",
                  padding: "4px 8px",
                  fontSize: "11px",
                  color: "var(--color-text-primary)",
                  outline: "none"
                }}
              >
                {/* Auto first, and selected by default: spreading links over the whole network
                    is the normal case, and pinning every URL of one site to a single doorway is
                    the footprint you would rather not leave. */}
                <option value="all">
                  {t("farmAutoDistribute").replace("{n}", String(indexerDomains.length))}
                </option>
                {indexerDomains.map(d => (
                  <option key={d.id} value={d.id}>{d.domain}</option>
                ))}
              </select>

              <button
                onClick={runFarmSubmit}
                disabled={submittingToFarm}
                style={{
                  padding: "6px 14px",
                  borderRadius: "7px",
                  border: "none",
                  background: submittingToFarm ? "rgba(41,151,255,0.2)" : "rgba(41,151,255,0.85)",
                  color: "#fff",
                  fontSize: "12px",
                  fontWeight: 700,
                  cursor: submittingToFarm ? "not-allowed" : "pointer",
                  opacity: submittingToFarm ? 0.7 : 1
                }}
              >
                {submittingToFarm ? "Queuing..." : "▶ Submit to Doorway Queue"}
              </button>

              {farmSubmitResult && (
                <span style={{
                  fontSize: "12px",
                  color: farmSubmitResult.startsWith("✓") ? "#4ADE80" : "#F87171",
                  fontWeight: 600
                }}>
                  {farmSubmitResult}
                </span>
              )}
            </div>
          )}
          {hasNeural && (
            <div style={{ padding: "10px 14px", borderBottom: hasXmlRiver || hasTwoIndex ? "1px solid var(--color-border)" : "none", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <div style={{ width: 22, height: 22, borderRadius: "5px", background: "linear-gradient(135deg,rgba(139,92,246,0.3),rgba(59,130,246,0.3))", border: "1px solid rgba(139,92,246,0.4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "9px", fontWeight: 800, color: "#a78bfa" }}>NI</div>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "#a78bfa" }}>NeuralIndexer</span>
              <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>
                {selected.size > 0 ? `· ${selected.size} ${t("idxSelectedLower")}` : `· ${(counters.total ?? 0) - (counters.neuralSubmitted ?? 0)} ${t("idxNotSentYet")}`}
              </span>
              {(["slow","fast","yandex"] as const).map(q => (
                <button key={q} onClick={() => setNnQueue(q)}
                  style={{ padding: "4px 10px", borderRadius: "6px", fontSize: "11px", fontWeight: 600, cursor: "pointer", background: nnQueue === q ? "rgba(139,92,246,0.2)" : "transparent", color: nnQueue === q ? "#a78bfa" : "var(--color-text-secondary)", border: `1px solid ${nnQueue === q ? "rgba(139,92,246,0.4)" : "var(--color-border)"}` }}>
                  {q === "slow" ? "Slow" : q === "fast" ? "⚡ Fast" : "Yandex"}
                </button>
              ))}
              <button onClick={runNeuralSubmit} disabled={submitting}
                style={{ padding: "6px 14px", borderRadius: "7px", border: "none", background: submitting ? "rgba(139,92,246,0.2)" : "rgba(139,92,246,0.85)", color: "#fff", fontSize: "12px", fontWeight: 700, cursor: submitting ? "not-allowed" : "pointer", opacity: submitting ? 0.7 : 1 }}>
                {submitting ? t("idxSending") : `▶ ${t("idxSubmitToIndex")}`}
              </button>
              <button onClick={() => runXrCheck("neural")} disabled={xrChecking}
                style={{ display: "flex", alignItems: "center", gap: "4px", padding: "6px 12px", borderRadius: "7px", border: "1px solid rgba(139,92,246,0.4)", background: "transparent", color: "#a78bfa", fontSize: "12px", fontWeight: 600, cursor: xrChecking ? "not-allowed" : "pointer", opacity: xrChecking ? 0.6 : 1 }}>
                🔍 {xrChecking ? t("idxChecking") : t("idxCheckIndex")}
              </button>
              {xrCheckMsg && (
                <span style={{ fontSize: "12px", color: xrCheckMsg.startsWith("✓") ? "#4ADE80" : "#F87171", fontWeight: 600 }}>{xrCheckMsg}</span>
              )}
              {submitResult?.ok && (
                <span style={{ fontSize: "12px", color: "#4ADE80", fontWeight: 600 }}>
                  ✓ {t("idxAccepted")} {submitResult.accepted} URL
                  {submitResult.charged != null && ` · $${Number(submitResult.charged).toFixed(4)} ${t("idxCharged")}`}
                  {submitResult.balance != null && ` · ${t("idxBalance")} $${Number(submitResult.balance).toFixed(4)}`}
                </span>
              )}
              {submitResult?.error && <span style={{ fontSize: "12px", color: "#F87171" }}>✗ {submitResult.error}</span>}
            </div>
          )}
          {(hasXmlRiver || hasTwoIndex) && (
            <div style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", background: "rgba(255,255,255,0.01)" }}>
              <span style={{ fontSize: "10px", fontWeight: 700, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{t("idxAdditional")}</span>
              {hasTwoIndex && (
                <button onClick={runTwoIndexSubmit} disabled={submitting}
                  style={{ display: "flex", alignItems: "center", gap: "4px", padding: "4px 10px", borderRadius: "6px", border: "1px solid rgba(16,185,129,0.3)", background: "transparent", color: "#34d399", fontSize: "11px", fontWeight: 600, cursor: submitting ? "not-allowed" : "pointer", opacity: submitting ? 0.6 : 1 }}>
                  <span style={{ fontSize: "9px", fontWeight: 800 }}>2I</span>
                  {submitting ? t("idxSending") : t("idxSendTo2index")}
                </button>
              )}
              {hasXmlRiver && (
                <button onClick={() => runXrCheck("xr")} disabled={xrChecking}
                  style={{ display: "flex", alignItems: "center", gap: "4px", padding: "4px 10px", borderRadius: "6px", border: "1px solid rgba(251,191,36,0.3)", background: "transparent", color: "#fbbf24", fontSize: "11px", fontWeight: 600, cursor: xrChecking ? "not-allowed" : "pointer", opacity: xrChecking ? 0.6 : 1 }}>
                  <span style={{ fontSize: "9px", fontWeight: 800 }}>XR</span>
                  {xrChecking ? t("idxChecking") : t("idxCheckIndex")}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <div style={{ display: "flex", justifyContent: "center", padding: "30px 0" }}>
          <div style={{ width: 22, height: 22, border: "2px solid var(--color-border)", borderTopColor: "#3B82F6", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && counters.total === 0 && (
        <div style={{ textAlign: "center", padding: "60px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
          <Globe size={36} color="var(--color-text-secondary)" style={{ opacity: 0.25 }} />
          <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--color-text-primary)" }}>{t("idxPagesEmpty")}</div>
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", maxWidth: "380px", lineHeight: 1.6 }}>
            {t("idxPagesEmptyHint1")} <strong>{t("idxSyncPages")}</strong>, {t("idxPagesEmptyHint2")}
          </p>
        </div>
      )}

      {/* ── URL table ── */}
      {urlRows.length > 0 && (
        <div style={{ background: "var(--color-card)", borderRadius: "12px", border: "1px solid var(--color-border)", overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)" }}>📋 {t("idxPagesList")}</span>
            <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>· {total} URL</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: "8px", alignItems: "center" }}>
              <button onClick={() => { const p = Math.max(1, page - 1); setPage(p); loadUrls(p, statusFilter, search); }}
                disabled={page <= 1 || loading}
                style={{ padding: "3px 10px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: "12px", cursor: page <= 1 ? "not-allowed" : "pointer", opacity: page <= 1 ? 0.4 : 1 }}>← {t("idxBack")}</button>
              <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("idxPageWord")} {page} {t("idxOf")} {pages}</span>
              <button onClick={() => { const p = Math.min(pages, page + 1); setPage(p); loadUrls(p, statusFilter, search); }}
                disabled={page >= pages || loading}
                style={{ padding: "3px 10px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: "12px", cursor: page >= pages ? "not-allowed" : "pointer", opacity: page >= pages ? 0.4 : 1 }}>{t("idxNext")} →</button>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", minWidth: "1120px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--color-border)", background: "rgba(255,255,255,0.02)" }}>
                  <th style={{ padding: "9px 12px", width: 32 }}>
                    <input type="checkbox" checked={selected.size === urlRows.length && urlRows.length > 0} onChange={toggleAll}
                      style={{ cursor: "pointer", width: 13, height: 13, accentColor: "#3B82F6" }} />
                  </th>
                  {["URL",t("idxInventoryStatus"),t("idxLastmod"),t("idxAudit"),t("idxColGoogleStatus"),"XML RIVER","2INDEX","NEURAL",t("idxColChecked")].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "9px 12px", color: "var(--color-text-secondary)", fontWeight: 500, fontSize: "10px", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {urlRows.map((row, i) => {
                  const path = row.url.replace(/^https?:\/\/[^/]+/, "") || "/";
                  const gColor = googleStatusColor(row.googleStatus);
                  const isSelected = selected.has(row.url);
                  return (
                    <tr key={row.id} style={{ borderBottom: "1px solid var(--color-border)", background: isSelected ? "rgba(59,130,246,0.05)" : i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.012)", opacity: row.inventoryStatus === "missing" ? 0.72 : 1 }}>
                      <td style={{ padding: "8px 12px" }}>
                        <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(row.url)}
                          style={{ cursor: "pointer", width: 13, height: 13, accentColor: "#3B82F6" }} />
                      </td>
                      <td style={{ padding: "8px 12px", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <a href={row.url} target="_blank" rel="noreferrer" title={row.url}
                          style={{ color: "#60a5fa", textDecoration: "none" }}
                          onMouseOver={e => (e.currentTarget.style.textDecoration = "underline")}
                          onMouseOut={e => (e.currentTarget.style.textDecoration = "none")}>{path}</a>
                      </td>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                        <span title={`${row.sourceSitemap ?? ""}\n${row.sitemapType ?? "standard"}\n${row.firstSeenAt ?? ""} → ${row.lastSeenAt ?? ""}`} style={{ color: inventoryStatusColor(row), fontSize: "10px", fontWeight: 700 }}>
                          {inventoryStatusLabel(row)}
                        </span>
                        {(row.imageCount > 0 || row.videoCount > 0 || row.newsCount > 0) && (
                          <div style={{ color: "var(--color-text-secondary)", fontSize: "9px", marginTop: 2 }}>
                            {row.imageCount > 0 && `IMG ${row.imageCount} `}{row.videoCount > 0 && `VID ${row.videoCount} `}{row.newsCount > 0 && `NEWS ${row.newsCount}`}
                          </div>
                        )}
                      </td>
                      <td title={`${row.sourceSitemap ?? ""}\n${row.lastmod ?? ""}`} style={{ padding: "8px 12px", whiteSpace: "nowrap", color: row.lastmodValid === false || row.lastmodReliability === "suspicious" ? "#F87171" : "var(--color-text-secondary)", fontSize: "10px" }}>
                        {row.lastmod ? row.lastmod.slice(0, 10) : "—"}
                        {row.lastmodReliability === "suspicious" && <div style={{ fontSize: "9px", color: "#FB7185" }}>⚠ {t("idxSuspiciousLastmod")}</div>}
                        {row.lastmodValid === false && <div style={{ fontSize: "9px", color: "#F87171" }}>⚠ {t("idxInvalid")}</div>}
                      </td>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                        {row.audit?.covered
                          ? <span style={{ color: row.audit.issueCount ? "#FBBF24" : "#4ADE80", fontSize: "10px", fontWeight: 600 }}>
                              {row.audit.issueCount ? t("idxAuditIssues").replace("{n}", String(row.audit.issueCount)) : "✓"}
                            </span>
                          : <span style={{ color: "var(--color-text-secondary)", fontSize: "10px" }}>{t("idxNotAudited")}</span>}
                      </td>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                        {row.googleStatus ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: gColor, fontWeight: 500 }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: gColor, flexShrink: 0 }} />
                            {googleStatusLabel(row.googleStatus)}
                          </span>
                        ) : <span style={{ color: "rgba(255,255,255,0.2)" }}>—</span>}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        {row.xrStatus ? (
                          <span style={{ fontSize: "11px", color: row.xrStatus === "indexed" ? "#4ADE80" : "#FBBF24", fontWeight: 600 }}>
                            {row.xrStatus === "indexed" ? `✓ ${t("idxInIndex")}` : `✗ ${t("idxNotInIndex")}`}
                          </span>
                        ) : <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "11px" }}>—</span>}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        {row.twoIndexStatus === "submitted"
                          ? <span style={{ fontSize: "11px", color: "#34d399", fontWeight: 600 }}>✓ {t("idxSent")}</span>
                          : <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "11px" }}>—</span>}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        {row.neuralStatus === "indexed"
                          ? <span style={{ fontSize: "11px", color: "#4ADE80", fontWeight: 600 }}>✓ {t("idxInIndex")}</span>
                          : row.neuralStatus === "not_indexed"
                          ? <span style={{ fontSize: "11px", color: "#FBBF24", fontWeight: 600 }}>✗ {t("idxNotInIndex")}</span>
                          : row.neuralStatus === "submitted"
                          ? <span style={{ fontSize: "11px", color: "#a78bfa", fontWeight: 600 }}>↑ {row.neuralQueue ?? "slow"}</span>
                          : <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "11px" }}>—</span>}
                      </td>
                      <td style={{ padding: "8px 12px", color: "var(--color-text-secondary)", fontSize: "11px", whiteSpace: "nowrap" }}>
                        {(row.googleChecked || row.neuralAt || row.xrChecked)
                          ? timeAgo(new Date(row.googleChecked ?? row.neuralAt ?? row.xrChecked))
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Operations history ── */}
      <div style={{ background: "var(--color-card)", borderRadius: "12px", border: "1px solid var(--color-border)", overflow: "hidden" }}>
        <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>🕐 {t("idxHistory")}</span>
          <button onClick={() => { setShowOps(o => !o); if (!showOps) loadOps(); }}
            style={{ fontSize: "12px", padding: "4px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>
            {showOps ? t("idxCollapse") : t("idxRefreshHistory")}
          </button>
        </div>
        {showOps && (
          <div style={{ borderTop: "1px solid var(--color-border)" }}>
            {opsLoading ? (
              <div style={{ padding: "20px", textAlign: "center" }}>
                <div style={{ width: 18, height: 18, border: "2px solid var(--color-border)", borderTopColor: "#3B82F6", borderRadius: "50%", animation: "spin 0.8s linear infinite", display: "inline-block" }} />
              </div>
            ) : ops.length === 0 ? (
              <div style={{ padding: "20px", textAlign: "center", fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("idxHistoryEmpty")}</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <thead>
                  <tr style={{ background: "rgba(255,255,255,0.02)" }}>
                    {[t("idxColType"),t("idxColSummary"),t("idxColDetail"),t("idxColDate")].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "8px 14px", color: "var(--color-text-secondary)", fontWeight: 500, fontSize: "10px", letterSpacing: "0.06em" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ops.map((op, i) => (
                    <tr key={op.id} style={{ borderTop: "1px solid var(--color-border)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)" }}>
                      <td style={{ padding: "8px 14px", fontWeight: 600, color: "var(--color-text-primary)" }}>{opTypeLabel(op.type)}</td>
                      <td style={{ padding: "8px 14px" }}>
                        <span style={{ color: op.result === "success" ? "#4ADE80" : op.result === "error" ? "#F87171" : "#FBBF24", fontWeight: 600 }}>
                          {op.result ?? "—"}
                        </span>
                        {op.urlCount != null && <span style={{ color: "var(--color-text-secondary)", marginLeft: 4 }}>· {op.urlCount} URL</span>}
                      </td>
                      <td title={op.detail ?? ""} style={{ padding: "8px 14px", color: "var(--color-text-secondary)", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{operationDetail(op)}</td>
                      <td style={{ padding: "8px 14px", color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>{timeAgo(new Date(op.createdAt))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Google G icon ────────────────────────────────────────────────────────────
function GoogleIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

function BingIconSite({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" style={{ flexShrink: 0 }}>
      <polygon points="166.685,38.682 52.904,0 52.904,422.118 166.685,321.987" fill="#008373" />
      <polygon points="206.501,133.117 253.157,249.166 319.397,270.361 56.324,431.215 170.095,512 459.096,336.78 459.096,216.17" fill="#008373" />
    </svg>
  );
}

function YandexIconSite({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
      <path d="M21.88,2h-4c-4,0-8.07,3-8.07,9.62a8.33,8.33,0,0,0,4.14,7.66L9,28.13A1.25,1.25,0,0,0,9,29.4a1.21,1.21,0,0,0,1,.6h2.49a1.24,1.24,0,0,0,1.2-.75l4.59-9h.34v8.62A1.14,1.14,0,0,0,19.82,30H22a1.12,1.12,0,0,0,1.16-1.06V3.22A1.19,1.19,0,0,0,22,2ZM18.7,16.28h-.59c-2.3,0-3.66-1.87-3.66-5,0-3.9,1.73-5.29,3.34-5.29h.94Z" fill="#d61e3b" />
    </svg>
  );
}

// ─── Algorithm update marker label ────────────────────────────────────────────
/**
 * The text above an update's start line: name, rollout length, and what traffic did across it.
 *
 * A custom element rather than Recharts' `label` object because the two halves need different
 * colours — the name carries the update *type* (core / spam / discover), the percentage carries
 * the *outcome*, and collapsing both into one colour would make a spam update and a traffic drop
 * indistinguishable at a glance.
 *
 * Recharts injects `viewBox` when a label is given as an element.
 */
function AlgoMarkerLabel({ viewBox, text, impact, color, title }: {
  viewBox?: { x?: number; y?: number }; text: string; impact: AlgoImpactResult;
  color: string; title: string;
}) {
  const x = viewBox?.x ?? 0;
  // 6px above the plot area rather than 4: the descender-free label still needs room for its
  // own height, and the chart reserves 26px of top margin when markers are shown.
  const y = (viewBox?.y ?? 0) - 6;
  const pct = impact.ok ? impact.clicks : null;
  const tone = pct == null ? "" : pct > 0 ? "#10B981" : pct < 0 ? "#EF4444" : "var(--color-text-tertiary)";
  return (
    <text x={x} y={y} textAnchor="middle" fontSize={9} fontWeight={600}>
      {/* All four metrics live in a native SVG tooltip rather than in the label. Four figures at
          9px, on a chart where two updates can sit days apart, is unreadable — and clicks is the
          one people actually decide on. The rest are a hover away, and the Annotations tab lists
          them in full. */}
      <title>{title}</title>
      <tspan fill={color}>{text}</tspan>
      {/* A tilde on a thin window. Since the minimum was lowered to three days, a figure from
          three days and one from fourteen would otherwise be typeset identically — and the first
          is a hint while the second is close to a fact. */}
      {pct != null && (
        <tspan fill={tone}>{` ${impact.ok && !impact.confident ? "~" : ""}${pct > 0 ? "+" : ""}${pct}%`}</tspan>
      )}
    </text>
  );
}

/** Multi-line hover text for an update marker: every metric, or a reason there is no figure. */
function algoImpactTitle(name: string, range: string, impact: AlgoImpactResult, t: (k: never) => string): string {
  if (!impact.ok) {
    // "Waiting for data" and "cannot be separated from the update next to it" call for different
    // reactions — one resolves itself in a week, the other never will.
    return `${name}\n${range}\n${t((impact.reason === "adjacent" ? "algoImpactAdjacent" : "algoImpactUnknown") as never)}`;
  }
  const sign = (v: number) => (v > 0 ? "+" : "");
  const lines = [
    impact.clicks != null && `${t("clicks" as never)}: ${sign(impact.clicks)}${impact.clicks}%`,
    impact.impressions != null && `${t("impressions" as never)}: ${sign(impact.impressions)}${impact.impressions}%`,
    impact.ctrPp != null && `CTR: ${sign(impact.ctrPp)}${impact.ctrPp} pp`,
    impact.position != null && `${t("avgPosition" as never)}: ${sign(impact.position)}${impact.position}`,
  ].filter(Boolean);
  // The window is part of the answer: a verdict from 5 clean days deserves less weight than one
  // from 14, and only saying so lets the reader apply that discount.
  const window = t("algoImpactWindow" as never)
    .replace("{b}", String(impact.beforeDays))
    .replace("{a}", String(impact.afterDays));
  const caveat = impact.confident ? null : t("algoImpactApprox" as never);
  return [name, range, ...lines, window, caveat].filter(Boolean).join("\n");
}

/** An update as the chart needs it: snapped to real axis labels, with its measured impact. */
type AlgoMarker = AlgoUpdate & { x: string; x2: string | null; impact: AlgoImpactResult };

/**
 * Rollout bands and their edges, as chart children.
 *
 * A plain function returning an array rather than a component, because Recharts identifies its
 * children by component type — a `<AlgoMarkers />` wrapper would be passed through as an unknown
 * element and silently ignored, which is a slow way to learn how the library works.
 *
 * Shared by the dashboard chart and the Annotations one so the two cannot drift into drawing the
 * same fact differently.
 */
function renderAlgoMarkers(updates: AlgoMarker[], t: (k: never) => string) {
  return updates.map(u => (
    <Fragment key={`${u.name}-${u.date}`}>
      {/* Shaded rollout window first so the start line draws on top of it. */}
      {u.x2 && (
        <ReferenceArea x1={u.x} x2={u.x2} yAxisId="left"
          fill={ALGO_UPDATE_COLORS[u.type]} fillOpacity={0.07} stroke="none" />
      )}
      <ReferenceLine x={u.x} yAxisId="left"
        stroke={ALGO_UPDATE_COLORS[u.type]} strokeWidth={1.5} strokeDasharray="3 3"
        label={
          <AlgoMarkerLabel
            text={algoChartLabel(u)}
            impact={u.impact}
            color={ALGO_UPDATE_COLORS[u.type]}
            title={algoImpactTitle(u.name, updateEnd(u) ? `${u.date} → ${updateEnd(u)}` : u.date, u.impact, t)}
          />
        } />
      {/* Closing edge, thinner and faded: the rollout end is a softer fact than its start, and
          two identical lines would read as two separate updates. */}
      {u.x2 && (
        <ReferenceLine x={u.x2} yAxisId="left"
          stroke={ALGO_UPDATE_COLORS[u.type]} strokeWidth={1} strokeOpacity={0.5} strokeDasharray="2 4" />
      )}
    </Fragment>
  ));
}

/**
 * The operator's own notes as chart children — solid lines against the updates' shaded bands.
 *
 * A note is a moment, not a window: a redirect either shipped or it did not, so there is nothing
 * to shade. Deliberately one flat colour rather than the per-type palette updates use, because
 * the first thing to read off the chart is whose event it was, and only then which one.
 */
function renderNoteMarkers(notes: { id: string; title: string; x: string }[]) {
  return notes.map(n => (
    <ReferenceLine key={n.id} x={n.x} yAxisId="left"
      stroke="var(--color-text-secondary)" strokeWidth={1.2} strokeOpacity={0.55}
      label={<NoteMarkerLabel title={n.title} />} />
  ));
}

function NoteMarkerLabel({ viewBox, title }: { viewBox?: { x?: number; y?: number }; title?: string }) {
  const x = viewBox?.x ?? 0;
  const y = (viewBox?.y ?? 0) - 6;
  // Truncated rather than wrapped: a note title can be a sentence, and the chart has one line of
  // headroom. The full text is in the native tooltip and in the row below.
  const short = (title ?? "").length > 22 ? `${(title ?? "").slice(0, 21)}…` : title ?? "";
  return (
    <text x={x} y={y} textAnchor="middle" fontSize={9} fontWeight={600} fill="var(--color-text-secondary)">
      <title>{title}</title>
      {short}
    </text>
  );
}

// ─── Annotations Filter Dropdown ──────────────────────────────────────────────
function AnnotationsFilterDd({ onSetupBranded }: { onSetupBranded?: () => void }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [activeDim, setActiveDim] = useState<string | null>("dimQuery");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // label holds an i18n KEY; activeDim tracks the same key so highlight comparison stays correct.
  const dims = [
    { icon: <Search size={14}/>,          label: "dimQuery",          disabled: false },
    { icon: <FileText size={14}/>,         label: "dimPage",           disabled: false },
    { icon: <Globe size={14}/>,            label: "dimCountry",        disabled: false },
    { icon: <Monitor size={14}/>,          label: "dimDevice",         disabled: false },
    { icon: <BookmarkCheck size={14}/>,    label: "dimContentGroup",  disabled: true  },
    { icon: <ArrowLeftRight size={14}/>,   label: "dimCompareFilters",disabled: false },
  ];

  const divider = <div style={{ height: "1px", background: "var(--color-border)", margin: "4px 0" }} />;
  const sec = (label: string) => (
    <div style={{ padding: "10px 14px 4px", fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
  );

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "7px 13px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "13px", fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap" }}>
        <SlidersHorizontal size={13} /> Filter
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", boxShadow: "0 8px 32px rgba(0,0,0,0.5)", zIndex: 200, minWidth: "240px", overflow: "hidden" }}>
          {/* Dimension filters */}
          {dims.map(({ icon, label, disabled }) => (
            <button key={label} disabled={disabled} onClick={() => { if (!disabled) setActiveDim(label); }} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 14px", fontSize: "13px", cursor: disabled ? "default" : "pointer", width: "100%", background: activeDim === label ? "rgba(59,130,246,0.12)" : "transparent", color: disabled ? "var(--color-text-secondary)" : activeDim === label ? "#3B82F6" : "var(--color-text-primary)", border: "none", opacity: disabled ? 0.45 : 1 }}>
              {icon} {t(label as never)}
              {activeDim === label && <Check size={12} style={{ marginLeft: "auto" }} />}
            </button>
          ))}

          {divider}
          {sec(t("sectionBrandedQueries"))}
          <div style={{ padding: "4px 14px 10px", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            <span style={{ color: "#3B82F6", cursor: "pointer" }} onClick={onSetupBranded}>Define</span> branded keywords<br />to enable branded filters.
          </div>

          {divider}
          {sec(t("sectionPositionFilter"))}
          <div style={{ padding: "4px 14px 10px", display: "flex", gap: "8px" }}>
            {["Top 10", "Top 20"].map(v => (
              <button key={v} style={{ display: "flex", alignItems: "center", gap: "5px", padding: "5px 12px", borderRadius: "20px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "1px solid var(--color-border)", background: "transparent", color: "#F59E0B" }}>
                <MoveUp size={12} /> {v}
              </button>
            ))}
          </div>

          {divider}
          {sec(t("sectionSavedFilters"))}
          <div style={{ padding: "4px 14px 10px", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Add filters and save them to quickly<br />access them later.
          </div>

          {divider}
          {sec(t("sectionPresetFilters" as never))}
          {(["presetPaa", "presetLongTail"] as const).map(v => (
            <button key={v} onClick={() => setOpen(false)} style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 14px", fontSize: "13px", fontWeight: 600, cursor: "pointer", background: "transparent", color: "var(--color-text-primary)", border: "none" }}>
              {t(v)}
            </button>
          ))}
          <div style={{ height: "6px" }} />
        </div>
      )}
    </div>
  );
}

// ─── Add Note Modal ───────────────────────────────────────────────────────────
function AddNoteModal({ onClose, onSave, editNote }: {
  onClose: () => void;
  onSave: (note: { id?: string; date: string; title: string; desc: string; scope: string }) => void;
  /** When set, the modal opens in edit mode: fields are pre-filled and the label/button reflect editing. */
  editNote?: { id: string; title: string; desc: string; date: string } | null;
}) {
  const { t } = useLanguage();
  const today = new Date();
  const todayStr = today.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const [title, setTitle] = useState(editNote?.title ?? "");
  const [desc, setDesc]   = useState(editNote?.desc ?? "");
  const [scope, setScope] = useState<"all" | "specific" | "group">("all");

  // l holds an i18n KEY. Both render (3238) and onSave (3246) translate it via t(), so the stored
  // note scope is the localized label — same as the old hardcoded English, but in the active language.
  const scopeOptions = [
    { v: "all",      l: "scopeAllPages" },
    { v: "specific", l: "scopeSpecificPages" },
    { v: "group",    l: "scopeContentGroup" },
  ] as const;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: "16px", padding: "32px", width: "90%", maxWidth: "640px", color: "#111", boxShadow: "0 20px 60px rgba(0,0,0,0.4)", position: "relative" }}
        onClick={e => e.stopPropagation()}>
        {/* Close */}
        <button onClick={onClose} style={{ position: "absolute", top: "16px", right: "16px", background: "none", border: "none", cursor: "pointer", color: "#9ca3af" }}><X size={20} /></button>

        {/* Label */}
        <p style={{ fontSize: "12px", color: "#9ca3af", fontWeight: 500, marginBottom: "4px" }}>{editNote ? t("annEditNote") : "Note"}</p>

        {/* Date */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "24px" }}>
          <span style={{ fontSize: "24px", fontWeight: 700 }}>{editNote?.date ?? todayStr}</span>
          <Calendar size={18} color="#9ca3af" />
        </div>

        {/* Title */}
        <label style={{ display: "block", fontSize: "14px", fontWeight: 600, color: "#111", marginBottom: "8px" }}>Title</label>
        <input
          autoFocus
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder={t("noteTitlePlaceholder")}
          style={{ width: "100%", padding: "10px 12px", borderRadius: "8px", border: `2px solid ${title ? "#3B82F6" : "#d1d5db"}`, fontSize: "14px", color: "#111", outline: "none", boxSizing: "border-box", marginBottom: "20px" }}
        />

        {/* Description */}
        <label style={{ display: "block", fontSize: "14px", fontWeight: 600, color: "#111", marginBottom: "8px" }}>Description</label>
        <textarea
          value={desc}
          onChange={e => setDesc(e.target.value)}
          rows={5}
          style={{ width: "100%", padding: "10px 12px", borderRadius: "8px", border: "1px solid #d1d5db", fontSize: "14px", color: "#111", outline: "none", resize: "vertical", boxSizing: "border-box", marginBottom: "20px", fontFamily: "inherit" }}
        />

        {/* Scope */}
        <p style={{ fontSize: "14px", fontWeight: 600, color: "#111", marginBottom: "12px" }}>Which pages have been impacted?</p>
        <div style={{ display: "flex", gap: "20px", marginBottom: "28px" }}>
          {scopeOptions.map(({ v, l }) => (
            <label key={v} style={{ display: "flex", alignItems: "center", gap: "7px", cursor: "pointer", fontSize: "14px", color: "#374151" }}>
              <div onClick={() => setScope(v)} style={{ width: "18px", height: "18px", borderRadius: "50%", border: `2px solid ${scope === v ? "#3B82F6" : "#d1d5db"}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer" }}>
                {scope === v && <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#3B82F6" }} />}
              </div>
              {t(l as never)}
            </label>
          ))}
        </div>

        {/* Buttons */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button onClick={onClose} style={{ padding: "10px 22px", borderRadius: "8px", border: "none", background: "#f3f4f6", color: "#374151", fontSize: "14px", fontWeight: 500, cursor: "pointer" }}>{t("cancel")}</button>
          <button onClick={() => { if (title.trim()) { onSave({ id: editNote?.id, date: editNote?.date ?? todayStr, title, desc, scope: t(scopeOptions.find(o => o.v === scope)!.l as never) }); onClose(); } }}
            style={{ padding: "10px 22px", borderRadius: "8px", border: "none", background: title.trim() ? "#374151" : "#9ca3af", color: "#fff", fontSize: "14px", fontWeight: 600, cursor: title.trim() ? "pointer" : "not-allowed" }}>
            {editNote ? t("annSave") : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Annotations Tab ──────────────────────────────────────────────────────────

/**
 * Per-day values the API returns alongside each row.
 *
 * Nothing on screen draws these any more — the one timeline above the list covers the whole
 * period, which is what the per-row sparklines used to do for a single event. Kept because the
 * endpoint still sends them and the shape has to be described somewhere; drop the field from the
 * response first if it is ever removed for good.
 */
type SeriesPoint = {
  date: string; clicks: number; impressions: number; ctr: number; position: number | null;
  phase: "before" | "after";
};
interface AnnotationNote {
  id?: string;
  date: string; title: string; scope: string;
  /** Where the row came from: an operator's own note, or a Google ranking update. The two live on
   *  one timeline and differ only in how they are drawn. */
  kind: "note" | "update";
  /** Update type, for the band colour. Null on notes. */
  updateType?: AlgoUpdateType | null;
  /** Last day of a rollout, for the band's closing edge. Null on notes. */
  endDate?: string | null;
  /** Free text under the title. For Google updates this carries the rollout length, which is the
   *  one fact a bare date does not give you: a 2-day spam update and a 3-week core update leave
   *  very different shapes in the data. */
  description?: string;
  /** false when the window after the note has no Search Console data yet (it lags 2-3 days) */
  hasAfter?: boolean;
  // `null` percentages mean there was no baseline to divide by — rendered as "—", never as 0%.
  cBefore: number; cAfter: number; cPct: number | null;
  iBefore: number; iAfter: number; iPct: number | null;
  tBefore: number; tAfter: number; tPct: number | null;
  pBefore: number; pAfter: number; pDelta: number;
  dateRange: string;
  sparkBefore: number[]; sparkAfter: number[];
  /** per-day values for every metric — what the chart draws */
  series?: SeriesPoint[];
}

// Shape returned by /api/annotations, flattened into the row shape this table renders.
type ApiNote = {
  id: string; date: string; title: string; description?: string | null;
  kind: "note" | "update"; updateType?: AlgoUpdateType | null; endDate?: string | null;
  scope: string; dateRange: string; hasAfter: boolean;
  clicks: { before: number; after: number; pct: number | null };
  impressions: { before: number; after: number; pct: number | null };
  ctr: { before: number; after: number; pct: number | null };
  position: { before: number; after: number; delta: number };
  sparkBefore: number[]; sparkAfter: number[];
  series?: SeriesPoint[];
};

function mapApiNote(n: ApiNote): AnnotationNote {
  return {
    id: n.id,
    date: n.date,
    title: n.title,
    kind: n.kind ?? "note",
    updateType: n.updateType ?? null,
    endDate: n.endDate ?? null,
    description: n.description || undefined,
    scope: n.scope === "pages" ? "Specific pages" : "All Pages",
    hasAfter: n.hasAfter,
    cBefore: n.clicks.before, cAfter: n.clicks.after, cPct: n.clicks.pct,
    iBefore: n.impressions.before, iAfter: n.impressions.after, iPct: n.impressions.pct,
    tBefore: n.ctr.before, tAfter: n.ctr.after, tPct: n.ctr.pct,
    pBefore: n.position.before, pAfter: n.position.after, pDelta: n.position.delta,
    dateRange: n.dateRange,
    sparkBefore: n.sparkBefore, sparkAfter: n.sparkAfter,
    series: n.series,
  };
}

// Comparison window in days for each period key — how far back and forward from a note's date the
// before/after figures reach. Keys without a natural day count fall back to 28.
/**
 * Span of every period option in days.
 *
 * This map used to hold ten of the seventeen keys, and the seven it was missing — 3m through 3y —
 * silently fell back to 28. Picking "3 months", "6 months" or "12 months" therefore produced
 * byte-identical output, which is what "the selector does nothing" looked like from outside.
 * Every key the dropdown offers now has an entry.
 */
const PERIOD_DAYS: Record<string, number> = {
  yesterday: 1, "7d": 7, "14d": 14, "28d": 28,
  last_week: 7, this_month: 30, last_month: 30,
  this_quarter: 90, last_quarter: 90, ytd: 180,
  "3m": 90, "6m": 180, "8m": 240, "12m": 365, "16m": 480,
  "2y": 730, "3y": 1095,
};

/**
 * How far before and after a dated event the comparison reaches.
 *
 * Scaled from the period rather than equal to it: on a three-year view nobody is asking what
 * happened in the three years after an update, and the endpoint caps the window at 180 days
 * anyway. A third of the period, floored at a week so short views still have something to
 * compare, and capped at 90 so long ones stay legible.
 */
function annotationWindow(period: string): number {
  const span = PERIOD_DAYS[period] ?? 28;
  return Math.max(7, Math.min(90, Math.round(span / 3)));
}

function AnnotationsTab({ period, setPeriod, periodOptions, onSetupBranded, siteDbId, chartData, algoMarkers }: {
  period: string; setPeriod: (p: string) => void; periodOptions: string[]; onSetupBranded?: () => void;
  siteDbId?: string;
  /** The same series and markers the dashboard draws — passed down rather than refetched, so the
   *  two views cannot disagree about what happened in the selected period. `dateIso` is what
   *  markers snap against; `date` is the axis label. */
  chartData?: { date: string; dateIso: string; clicks: number; impressions: number; ctr: number; position: number }[];
  algoMarkers?: AlgoMarker[];
}) {
  const { t } = useLanguage();
  // Was `useState(true)`, which blurred the table and covered it with a panel advertising four
  // invented notes from 2024 ("Moved to Astro", and so on). It appeared before the real notes had
  // even loaded, so an operator with a full history saw fake data first. The onboarding panel now
  // waits until the request has come back empty, and the fake rows are gone entirely — an empty
  // table with a working "add note" button says the same thing without pretending to have data.
  const [onboarding, setOnboarding] = useState(false);
  const [showAddNote, setShowAddNote] = useState(false);
  // When set, AddNoteModal opens in edit mode with this note's fields pre-filled.
  const [editingNote, setEditingNote] = useState<{ id: string; title: string; desc: string; date: string } | null>(null);
  const [notes, setNotes] = useState<AnnotationNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [activeMetrics, setActiveMetrics] = useState<Set<Metric>>(new Set(["clicks", "impressions", "ctr", "position"]));

  const days = annotationWindow(period);
  // The list always reaches across the whole tracking history: hiding a note because it is older
  // than the selected period is exactly the trap that made the onboarding panel appear over notes
  // that were sitting there all along. The period now controls only the before/after comparison
  // window (`days`), not which notes are visible.
  const lookback = 1200;

  // Notes and their figures both come from the server: the note rows persist in the Annotation
  // table, the before/after numbers are derived from DailyMetric on every read. Re-fetching when
  // the period changes is what makes the window selector actually mean something here.
  // One request, one list. Notes and Google updates arrive merged and already scored the same
  // way; the client only needs `kind` to decide how to draw each.
  const loadNotes = useCallback(async () => {
    if (!siteDbId) return;
    setLoading(true);
    try {
      const q = `siteId=${encodeURIComponent(siteDbId)}&days=${days}&lookback=${lookback}`;
      const res = await fetch(`/api/annotations?${q}`, { cache: "no-store" });
      const d = await res.json();
      setUnavailable(!!d.unavailable);
      setNotes(Array.isArray(d.notes) ? d.notes.map(mapApiNote) : []);
    } catch { setNotes([]); }
    setLoading(false);
  }, [siteDbId, days, lookback]);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  const ownNotes = useMemo(() => notes.filter(n => n.kind !== "update"), [notes]);

  // Notes snapped onto the axis, the same way updates are. Search Console has gaps, and a marker
  // pointing at a label no data point carries is dropped by Recharts without a word.
  const noteMarkers = useMemo(() => {
    if (!chartData?.length) return [];
    return ownNotes
      .map((n, i) => ({ id: n.id ?? `note-${i}`, title: n.title, x: snapToChartLabel(chartData, n.date) }))
      .filter((n): n is { id: string; title: string; x: string } => n.x !== null);
  }, [ownNotes, chartData]);
  // The onboarding panel is an absolutely-positioned overlay covering everything below the
  // sub-header, so it can only appear when there is genuinely nothing underneath. Keying it on
  // "no notes of your own" would hide the Google-update timeline the moment a fresh instance
  // opened the tab — a card inviting you to add something, drawn over the only thing on screen.
  // The "+ add note" button is always present when the panel is not.
  useEffect(() => {
    if (loading) return;
    setOnboarding(notes.length === 0 && !unavailable);
  }, [loading, notes.length, unavailable]);

  const toggleMetric = (m: Metric) => setActiveMetrics(p => { const n = new Set(p); n.has(m) ? n.delete(m) : n.add(m); return n; });

  const displayNotes = notes;

  const fK = (n: number) => n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n);

  return (
    <div style={{ position: "relative" }}>
      {/* ── Sub-header controls ── */}
      <div style={{ padding: "10px 32px", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: "8px", background: "var(--color-card)", flexWrap: "wrap" }}>
        <AnnotationsFilterDd onSetupBranded={onSetupBranded} />

        {/* Metric icons */}
        <div style={{ display: "flex", gap: "4px" }}>
          {([
            { m: "clicks" as Metric,      icon: <Sparkles size={13}/>, color: C.clicks,      bg: "rgba(59,130,246,0.12)"  },
            { m: "impressions" as Metric, icon: <Eye size={13}/>,      color: C.impressions, bg: "rgba(139,92,246,0.12)"  },
            { m: "ctr" as Metric,         icon: <Percent size={13}/>,  color: C.ctr,         bg: "rgba(16,185,129,0.12)"  },
            { m: "position" as Metric,    icon: <MoveUp size={13}/>,   color: C.position,    bg: "rgba(245,158,11,0.12)"  },
          ]).map(({ m, icon, color, bg }) => {
            const active = activeMetrics.has(m);
            return (
              <button key={m} onClick={() => toggleMetric(m)} style={{ width: "32px", height: "32px", borderRadius: "8px", cursor: "pointer", border: `1px solid ${active ? color : "var(--color-border)"}`, background: active ? bg : "var(--color-card)", color: active ? color : "var(--color-text-secondary)", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}>
                {icon}
              </button>
            );
          })}
        </div>

        <div style={{ flex: 1 }} />

        {/* Period */}
        <SimpleDropdown align="right" trigger={
          <button style={{ display: "flex", alignItems: "center", gap: "6px", padding: "7px 13px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "13px", fontWeight: 500, cursor: "pointer" }}>
            {period} <ChevronDown size={13} />
          </button>
        }>
          {periodOptions.map(p => {
            const lbl = t((PERIOD_OPTIONS.find(o => o.key === p)?.label ?? p) as never);
            return (
              <button key={p} onClick={() => setPeriod(p)} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "9px 14px", fontSize: "13px", cursor: "pointer", width: "100%", background: period === p ? "rgba(59,130,246,0.12)" : "transparent", color: period === p ? "#3B82F6" : "var(--color-text-primary)", border: "none" }}>
                {lbl} {period === p && <Check size={12} style={{ marginLeft: "auto" }} />}
              </button>
            );
          })}
        </SimpleDropdown>
      </div>

      {/* The table exists only after `prisma db push`; say so plainly rather than showing an
          empty tab that looks like "no notes yet". */}
      {unavailable && (
        <div style={{ margin: "16px 32px", padding: "12px 14px", borderRadius: "10px", border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.08)", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          {t("annUnavailable")}
        </div>
      )}

      {/* ── One timeline: traffic, the operator's notes, and Google's updates ──
          These were two views with a toggle between them, and the toggle was the problem: the
          question people actually ask is "what moved my site", and answering it meant flipping
          screens and holding one in your head. Both kinds of event are dated, both are scored the
          same way, so they belong on the same curve. Notes are solid lines, updates are shaded
          bands — enough to tell them apart without a legend. */}
      {(chartData?.length ?? 0) > 0 && (
        <div style={{ padding: "16px 32px 4px" }}>
          <ResponsiveContainer width="100%" height={230}>
            <ComposedChart data={chartData} margin={{ top: 26, right: 4, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }}
                interval="preserveStartEnd" minTickGap={28} axisLine={false} tickLine={false} />
              <YAxis yAxisId="left" tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }}
                axisLine={false} tickLine={false} width={38} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }}
                axisLine={false} tickLine={false} width={44} />
              <Tooltip
                contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "8px", fontSize: "12px" }}
                labelStyle={{ color: "var(--color-text-secondary)" }} />
              {/* The same four metrics and the same toggle buttons as the dashboard. CTR and
                  position were missing here, which made the tab feel like a lesser chart rather
                  than the same one with events drawn on it. Impressions keep the right axis;
                  putting a five-figure count on the same scale as a 1.4% CTR flattens both. */}
              {activeMetrics.has("impressions") && (
                <Area yAxisId="right" type="monotone" dataKey="impressions" stroke={C.impressions}
                  fill={C.impressions} fillOpacity={0.08} strokeWidth={1.2} dot={false} name={t("impressions")} />
              )}
              {activeMetrics.has("clicks") && (
                <Line yAxisId="left" type="monotone" dataKey="clicks" stroke={C.clicks}
                  strokeWidth={1.8} dot={false} name={t("clicks")} />
              )}
              {activeMetrics.has("ctr") && (
                <Line yAxisId="left" type="monotone" dataKey="ctr" stroke={C.ctr}
                  strokeWidth={1.5} dot={false} name="CTR" />
              )}
              {/* Position is inverted: rank 1 belongs at the top of the chart, and the default
                  scale would draw an improvement as a fall. */}
              {activeMetrics.has("position") && (
                <Line yAxisId="left" type="monotone" dataKey="position" stroke={C.position}
                  strokeWidth={1.5} dot={false} connectNulls name={t("avgPosition")} />
              )}
              {renderAlgoMarkers(algoMarkers ?? [], t as never)}
              {renderNoteMarkers(noteMarkers)}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Background content ── */}
      {/* No blur any more: it existed to make invented rows look like real data behind frosted
          glass, and with the rows gone there is nothing to obscure. */}
      <div>
        {displayNotes.map((note, idx) => (
          // Updates drop the four sparklines a note gets. A note is one event an operator wants to
          // study; updates are a timeline they want to read down. Eight charts on screen made the
          // page a scroll where the useful part — the date and the deltas — was the smallest thing
          // on it.
          <div key={idx} style={{ display: "grid", gridTemplateColumns: "320px 1fr auto", gap: "0", borderBottom: "1px solid var(--color-border)", alignItems: "center", padding: "0 32px" }}>
            {/* Left: date + title + scope */}
            <div style={{ padding: "18px 24px 18px 0" }}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "4px" }}>{note.title}</div>
              <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
                {note.date} · {note.kind === "update" ? (note.description || t("annUpdates")) : note.scope}
              </div>
            </div>

            {/* Center: before/after chart + date range — notes only */}

            {/* Right: metrics before → after */}
            <div style={{ padding: "18px 0", display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "18px", minWidth: "260px", alignItems: "center" }}>
              {/* Every delta used to render as a green "+" regardless of sign, so a drop appeared
                  as a green "+-20%". Sign and colour now follow the actual number, and a note with
                  no post-change data yet says so instead of claiming a confident zero. */}
              {([
                ["clicks", <Sparkles key="c" size={11} color={C.clicks} />, fK(note.cBefore), `${fK(note.cAfter)} ${t("clicks").toLowerCase()}`, note.cPct, true],
                ["impressions", <Eye key="i" size={11} color={C.impressions} />, fK(note.iBefore), `${fK(note.iAfter)} ${t("impressions").toLowerCase()}`, note.iPct, true],
                ["ctr", <Percent key="t" size={11} color={C.ctr} />, `${note.tBefore}%`, `${note.tAfter}%`, note.tPct, true],
                ["position", <MoveUp key="p" size={11} color={C.position} />, note.pBefore, `${note.pAfter} ${t("avgPosition")}`, note.pDelta, false],
              ] as const).map(([m, icon, before, after, change, isPct]) => {
                if (!activeMetrics.has(m as Metric)) return null;
                const noData = note.hasAfter === false;
                // Position is the one metric where a smaller number is better; the API already
                // reports its delta as before − after, so positive means improved everywhere.
                const good = change !== null && change > 0;
                const colour = noData || change === null || change === 0
                  ? "var(--color-text-secondary)" : good ? "#10B981" : "#EF4444";
                const label = noData ? t("annAwaitingData")
                  : change === null ? "—"
                  : `${change > 0 ? "+" : ""}${change}${isPct ? "%" : ""}`;
                return (
                  <div key={m} style={{ fontSize: "12px", display: "flex", alignItems: "center", gap: "5px" }}>
                    {icon}
                    <span style={{ color: "var(--color-text-secondary)" }}>{before}</span>
                    <span style={{ color: "var(--color-text-secondary)" }}>→</span>
                    <span style={{ color: "var(--color-text-primary)", fontWeight: 600 }}>{after}</span>
                    <span style={{ color: colour, fontSize: "11px", fontWeight: 600 }}>{label}</span>
                  </div>
                );
              })}
            </div>

            {/* Actions — only for the operator's own notes, never for Google updates. */}
            {note.kind === "note" && note.id && (
              <div style={{ display: "flex", gap: "4px", alignItems: "center", flexShrink: 0 }}>
                <button
                  title={t("annEditNote")}
                  onClick={() => setEditingNote({ id: note.id!, title: note.title, desc: note.description ?? "", date: note.date })}
                  style={{ width: "30px", height: "30px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  title={t("annDeleteNote")}
                  onClick={async () => {
                    if (!confirm(t("annDeleteConfirm"))) return;
                    await fetch(`/api/annotations?id=${encodeURIComponent(note.id!)}`, { method: "DELETE" }).catch(() => {});
                    await loadNotes();
                  }}
                  style={{ width: "30px", height: "30px", borderRadius: "8px", border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.06)", color: "#EF4444", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Empty state when not onboarding and no notes */}
      {!onboarding && !loading && notes.length === 0 && (
        <div style={{ padding: "64px 32px", textAlign: "center" }}>
          <p style={{ fontSize: "14px", color: "var(--color-text-secondary)" }}>
            {t("annEmptyDesc")}
          </p>
        </div>
      )}

      {/* ── Onboarding overlay ── */}
      {onboarding && (
        <div style={{ position: "absolute", top: "61px", left: 0, right: 0, bottom: 0, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "24px", zIndex: 10 }}>
          <div style={{ background: "var(--color-card)", borderRadius: "20px", border: "1px solid var(--color-border)", boxShadow: "0 16px 64px rgba(0,0,0,0.45)", width: "100%", maxWidth: "620px", overflow: "hidden", padding: "32px" }}>
            <h2 style={{ fontSize: "22px", fontWeight: 700, color: "var(--color-text-primary)", textAlign: "center", marginBottom: "6px" }}>{t("tabAnnotations")}</h2>
            <p style={{ fontSize: "14px", color: "var(--color-text-secondary)", textAlign: "center", marginBottom: "24px" }}>{t("annCreateFirstNote")}</p>

            {/* CTA */}
            <button
              onClick={() => { setOnboarding(false); setShowAddNote(true); }}
              style={{ width: "100%", padding: "13px", borderRadius: "10px", border: "none", background: "linear-gradient(90deg, #2563EB 0%, #7C3AED 100%)", color: "#fff", fontSize: "15px", fontWeight: 700, cursor: "pointer", marginBottom: "14px", boxShadow: "0 4px 16px rgba(37,99,235,0.35)" }}>
              {t("annCreateNoteBtn")}
            </button>

            {/* No "try it with Google updates" line any more: the panel only shows when the
                timeline is empty, so there are no updates in this period to point at. Claiming
                otherwise would be false exactly when someone reads it. */}
          </div>
        </div>
      )}

      {/* ── Add Note Modal ── */}
      {showAddNote && (
        <AddNoteModal
          onClose={() => setShowAddNote(false)}
          // Persist, then re-read: the figures are computed server-side from DailyMetric, so the
          // row can only be filled in by the API. Writing a locally-invented placeholder is what
          // produced the permanent 0 → 0 +0% this tab used to show.
          onSave={async note => {
            if (!siteDbId) return;
            await fetch("/api/annotations", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ siteId: siteDbId, date: note.date, title: note.title, description: note.desc }),
            }).catch(() => {});
            await loadNotes();
          }}
        />
      )}

      {/* ── Edit Note Modal ── */}
      {editingNote && (
        <AddNoteModal
          editNote={editingNote}
          onClose={() => setEditingNote(null)}
          onSave={async note => {
            if (!note.id) return;
            await fetch("/api/annotations", {
              method: "PUT", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: note.id, date: note.date, title: note.title, description: note.desc }),
            }).catch(() => {});
            await loadNotes();
          }}
        />
      )}

      {/* Add note FAB when onboarding dismissed */}
      {!onboarding && (
        <div style={{ position: "fixed", bottom: "32px", right: "32px", zIndex: 50 }}>
          <button onClick={() => setShowAddNote(true)} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "12px 20px", borderRadius: "12px", border: "none", background: "#3B82F6", color: "#fff", fontSize: "14px", fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 20px rgba(59,130,246,0.4)" }}>
            {t("annAddNote")}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Optimize Tab ─────────────────────────────────────────────────────────────
const OPTIMIZE_TOOLS = [
  {
    id: "cdm",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/>
        <polyline points="17 18 23 18 23 12"/>
      </svg>
    ),
    iconBg: "rgba(239,68,68,0.1)",
    titleKey: "optContentDecay",
    descKey: "optContentDecayDesc",
  },
  {
    id: "kc",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
        <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
      </svg>
    ),
    iconBg: "rgba(59,130,246,0.1)",
    titleKey: "optCannibalization",
    descKey: "optCannibalizationDesc",
  },
  {
    id: "sdk",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="20" x2="12" y2="10"/>
        <line x1="12" y1="6" x2="12" y2="6"/>
        <polyline points="8 14 12 10 16 14"/>
        <circle cx="12" cy="6" r="1" fill="#F59E0B"/>
      </svg>
    ),
    iconBg: "rgba(245,158,11,0.1)",
    titleKey: "optStriking",
    descKey: "optStrikingDesc",
  },
  {
    id: "ctr",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="19" y1="5" x2="5" y2="19"/>
        <circle cx="6.5" cy="6.5" r="2.5"/>
        <circle cx="17.5" cy="17.5" r="2.5"/>
      </svg>
    ),
    iconBg: "rgba(16,185,129,0.1)",
    titleKey: "optCtr",
    descKey: "optCtrDesc",
  },
];

function OptimizeTab({ siteDbId }: { siteDbId: string }) {
  const [active, setActive] = useState<string | null>(null);
  const { blur } = usePrivacy();
  const { t } = useLanguage();
  // We grab domain from useParams here for ContentDecayMap
  const params = useParams();
  const domain = decodeURIComponent(params.id as string);

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: "0" }}>
      {OPTIMIZE_TOOLS.map(({ id, icon, iconBg, titleKey, descKey }, i) => {
        const isActive = active === id;
        const title = t(titleKey as any);
        const desc = t(descKey as any);
        return (
          <div key={id}>
            {/* Card header row */}
            <div
              onClick={() => setActive(isActive ? null : id)}
              style={{
                display: "flex", alignItems: "center", gap: "18px",
                padding: "22px 20px",
                border: `1px solid ${isActive ? "#3B82F6" : "var(--color-border)"}`,
                borderRadius: isActive
                  ? "12px 12px 0 0"
                  : i === 0
                    ? "12px 12px 0 0"
                    : i === OPTIMIZE_TOOLS.length - 1
                      ? "0 0 12px 12px"
                      : "0",
                borderBottom: isActive
                  ? "none"
                  : i < OPTIMIZE_TOOLS.length - 1
                    ? "1px solid var(--color-border)"
                    : "1px solid var(--color-border)",
                background: isActive ? "rgba(59,130,246,0.07)" : "var(--color-card)",
                cursor: "pointer",
                transition: "all 0.15s",
                position: "relative",
                marginTop: i > 0 && !isActive ? "-1px" : "0",
              }}
              onMouseOver={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.04)"; }}
              onMouseOut={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "var(--color-card)"; }}
            >
              <div style={{ width: "44px", height: "44px", borderRadius: "10px", background: isActive ? iconBg : iconBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {icon}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "17px", fontWeight: 700, color: isActive ? "#3B82F6" : "var(--color-text-primary)", marginBottom: "4px" }}>{title}</div>
                <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{desc}</div>
              </div>
              <div style={{ color: isActive ? "#3B82F6" : "var(--color-text-secondary)", opacity: isActive ? 1 : 0.4, flexShrink: 0, transform: isActive ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </div>
            </div>

            {/* Expanded panel */}
            {isActive && (
              <div style={{
                border: "1px solid #3B82F6",
                borderTop: "none",
                borderRadius: "0 0 12px 12px",
                overflow: "hidden",
                marginBottom: "12px",
              }}>
                {id === "cdm" ? (
                  <ContentDecayMap domain={domain} siteDbId={siteDbId} />
                ) : id === "kc" ? (
                  <KeywordCannibalization siteDbId={siteDbId} />
                ) : id === "sdk" ? (
                  <StrikingDistanceKeywords siteDbId={siteDbId} />
                ) : id === "ctr" ? (
                  <CtrBenchmark siteDbId={siteDbId} />
                ) : (
                  <div style={{ padding: "40px 32px", background: "var(--color-card)", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                    <div style={{ fontSize: "28px" }}>🚧</div>
                    <p style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)" }}>{title}</p>
                    <p style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("optComingSoon")}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── New Rankings Table ───────────────────────────────────────────────────────
type RankRow = { label: string; clicks: number; impr: number; ctr: number; pos: number; cPct: number; iPct: number };
function NewRankingsTable({ queryRows, pageRows, blur }: { queryRows: RankRow[]; pageRows: RankRow[]; blur: boolean }) {
  const { t } = useLanguage();
  const [tab, setTab] = useState<"Queries" | "Pages">("Queries");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [sortCol, setSortCol] = useState<DtSortCol>("clicks");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const rows = tab === "Queries" ? queryRows : pageRows;

  const handleSort = (col: DtSortCol) => {
    if (sortCol === col) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortCol(col); setSortDir(col === "pos" ? "asc" : "desc"); }
    setPage(1);
  };

  const sorted = [...rows].sort((a, b) => (a[sortCol] - b[sortCol]) * (sortDir === "desc" ? -1 : 1));
  const paged = sorted.slice((page - 1) * pageSize, page * pageSize);

  const handleTabChange = (v: string) => { setTab(v as "Queries" | "Pages"); setPage(1); };

  const handleCSV = () => {
    exportCSV(`new-rankings-${tab.toLowerCase()}.csv`,
      [tab === "Queries" ? "Query" : "Page", "Clicks", "Impressions", "CTR%", "Position"],
      sorted.map(r => [r.label, r.clicks, r.impr, r.ctr, r.pos])
    );
  };

  const SortTh = ({ col, label, color }: { col: DtSortCol; label: string; color: string }) => {
    const active = sortCol === col;
    const arrow = active ? (sortDir === "desc" ? " ↓" : " ↑") : " ↕";
    return (
      <th onClick={() => handleSort(col)}
        style={{ textAlign: "left", padding: "8px 8px", color: active ? color : "var(--color-text-secondary)", fontWeight: active ? 700 : 500, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", fontSize: "11px", letterSpacing: "0.04em" }}>
        {label.toUpperCase()}<span style={{ opacity: active ? 1 : 0.35, marginLeft: "2px" }}>{arrow}</span>
      </th>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px", minHeight: "30px" }}>
        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("newRankings")}</h3>
        <TabBar tabs={["Queries", "Pages"]} active={tab} onChange={handleTabChange} />
        <button onClick={handleCSV} title={t("exportCsv")}
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "4px", padding: "4px 10px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "12px", cursor: "pointer" }}>
          <Download size={12} /> CSV
        </button>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: "32px 0", textAlign: "center", color: "var(--color-text-secondary)", fontSize: "13px" }}>
          {t("noNewRankings")}
        </div>
      ) : (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                <th style={{ textAlign: "left", padding: "8px 0", color: "var(--color-text-secondary)", fontWeight: 500 }}></th>
                <SortTh col="clicks" label={t("clicks")}      color={C.clicks} />
                <SortTh col="impr"   label={t("impressions")} color={C.impressions} />
                <SortTh col="ctr"    label="CTR"              color={C.ctr} />
                <SortTh col="pos"    label={t("position")}    color={C.position} />
              </tr>
            </thead>
            <tbody>
              {paged.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--color-border)", background: i % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent" }}>
                  <td style={{ padding: "8px 8px 8px 0", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-text-primary)" }}>
                    <span style={blur ? { filter: "blur(5px)", userSelect: "none", display: "inline-block" } : {}}>
                      <span style={{ fontSize: "10px", background: "#10B981", color: "#fff", borderRadius: "4px", padding: "1px 5px", marginRight: "5px", fontWeight: 700 }}>NEW</span>
                      {r.label}
                    </span>
                  </td>
                  <td style={{ padding: "8px 8px", color: "var(--color-text-primary)", fontWeight: 500 }}>{r.clicks}</td>
                  <td style={{ padding: "8px 8px", color: "var(--color-text-secondary)" }}>{fmtK(r.impr)}</td>
                  <td style={{ padding: "8px 8px", color: "var(--color-text-secondary)" }}>{r.ctr}%</td>
                  <td style={{ padding: "8px 0",  color: "var(--color-text-secondary)" }}>{r.pos}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", marginTop: "10px", gap: "16px" }}>
            <Pagination page={page} total={sorted.length} pageSize={pageSize} onChange={setPage} />
            <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
              <span>{t("rowsPerPage")}</span>
              <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
                style={{ fontSize: "12px", padding: "3px 6px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", cursor: "pointer" }}>
                {[10, 50, 100, 500].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Stub tab ──────────────────────────────────────────────────────────────────
function StubTab({ label }: { label: string }) {
  return (
    <div style={{ padding: "80px 32px", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
      <div style={{ fontSize: "32px" }}>🚧</div>
      <p style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-text-primary)" }}>{label}</p>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>Coming soon</p>
    </div>
  );
}

// ─── Winners & Losers (idea from sundios/SEO-Dashboard Traffic Insights) ──────
// Top queries/pages by click growth/decline between the current and previous period,
// with a contribution bar showing each row's share of the total change.
type WlItem = { label: string; curr: number; prev: number; delta: number };
type WlData = { queries: { winners: WlItem[]; losers: WlItem[] }; pages: { winners: WlItem[]; losers: WlItem[] } };

function WlList({ items, positive, blur, onTrack, tracked }: {
  items: WlItem[]; positive: boolean; blur: boolean;
  onTrack?: (label: string) => void; tracked?: Set<string>;
}) {
  const { t } = useLanguage();
  const maxAbs = Math.max(1, ...items.map(x => Math.abs(x.delta)));
  const color = positive ? "#10B981" : "#EF4444";
  if (!items.length) {
    return <div style={{ padding: "24px", fontSize: "12px", color: "var(--color-text-secondary)", textAlign: "center" }}>{t("wlNoData")}</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      {items.map((x, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}>
          {onTrack && (
            tracked?.has(x.label.toLowerCase()) ? (
              <span title={t("rankTracked")} style={{ color: "#10B981", display: "inline-flex", flexShrink: 0 }}><BookmarkCheck size={12} /></span>
            ) : (
              <button onClick={() => onTrack(x.label)} title={t("rankTrack")}
                style={{ width: "16px", height: "16px", borderRadius: "4px", border: "1px solid var(--color-border)", background: "none", color: "var(--color-text-secondary)", cursor: "pointer", fontSize: "11px", lineHeight: 1, padding: 0, flexShrink: 0 }}>+</button>
            )
          )}
          <span title={x.label} style={{ flex: "0 1 40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-text-primary)", ...(blur ? { filter: "blur(5px)", userSelect: "none" as const } : {}) }}>
            {x.label}
          </span>
          <div style={{ flex: 1, height: "8px", background: "var(--color-border)", borderRadius: "4px", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.round((Math.abs(x.delta) / maxAbs) * 100)}%`, background: color, borderRadius: "4px" }} />
          </div>
          <span style={{ width: "70px", textAlign: "right", fontWeight: 700, color, flexShrink: 0 }}>
            {positive ? "+" : "−"}{Math.abs(x.delta)}
          </span>
          <span style={{ width: "70px", textAlign: "right", color: "var(--color-text-secondary)", flexShrink: 0 }}>
            {x.prev} → {x.curr}
          </span>
        </div>
      ))}
    </div>
  );
}

function WinnersLosers({ data, blur, onTrack, tracked }: {
  data?: WlData; blur: boolean;
  onTrack?: (label: string) => void; tracked?: Set<string>;
}) {
  const { t, language } = useLanguage();
  const [dim, setDim] = useState<"queries" | "pages">("queries");
  const d = data?.[dim];
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "14px" }}>
        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("wlTitle")}</h3>
        <div style={{ display: "flex", gap: "4px" }}>
          {(["queries", "pages"] as const).map(k => (
            <button key={k} onClick={() => setDim(k)}
              style={{ padding: "4px 12px", borderRadius: "6px", fontSize: "12px", fontWeight: dim === k ? 600 : 400, cursor: "pointer", border: `1px solid ${dim === k ? "#3B82F6" : "var(--color-border)"}`, background: dim === k ? "rgba(59,130,246,0.12)" : "var(--color-card)", color: dim === k ? "#3B82F6" : "var(--color-text-secondary)" }}>
              {k === "queries" ? t("wlQueries") : t("wlPages")}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
        <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", padding: "16px" }}>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "#10B981", marginBottom: "10px", letterSpacing: "0.04em", textTransform: "uppercase" }}>▲ {t("wlWinners")}</div>
          <WlList items={d?.winners ?? []} positive blur={blur} onTrack={dim === "queries" ? onTrack : undefined} tracked={tracked} />
        </div>
        <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", padding: "16px" }}>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "#EF4444", marginBottom: "10px", letterSpacing: "0.04em", textTransform: "uppercase" }}>▼ {t("wlLosers")}</div>
          <WlList items={d?.losers ?? []} positive={false} blur={blur} onTrack={dim === "queries" ? onTrack : undefined} tracked={tracked} />
        </div>
      </div>
    </div>
  );
}

interface SitePageProps {
  siteDbId?: string;
  domain?: string;
  readOnly?: boolean;
  shareToken?: string;
  guestEngines?: { bing: boolean; yandex: boolean }; // which engines the owner configured (guest view)
}

export default function SitePage({
  siteDbId: propSiteDbId,
  domain: propDomain,
  readOnly = false,
  shareToken,
  guestEngines,
}: SitePageProps = {}) {
  const { t, language } = useLanguage();
  const params = useParams();
  const router = useRouter();
  const domain = propDomain || decodeURIComponent(params.id as string);
  const { blur } = usePrivacy();
  const blurStyle: React.CSSProperties = blur
    ? { filter: "blur(6px)", userSelect: "none", transition: "filter 0.25s" }
    : { transition: "filter 0.25s" };

  const getUrl = (url: string) => {
    if (!shareToken) return url;
    return `${url}${url.includes('?') ? '&' : '?'}shareToken=${shareToken}`;
  };

  // Ahrefs Domain Rating (free public API, server-cached; attribution required by license).
  const [drValue, setDrValue] = useState<number | null>(null);
  useEffect(() => {
    fetch(getUrl(`/api/dr?domains=${encodeURIComponent(domain)}`), { headers: { "x-ahrefs-dr-key": getAhrefsDrKey() } }).then(r => r.ok ? r.json() : null).then(d => {
      const key = domain.toLowerCase().replace(/^www\./, "");
      const v = d?.ratings?.[key]?.dr;
      if (typeof v === "number") setDrValue(v);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, shareToken]);

  // Use index so tab state doesn't break on language change
  const TAB_KEYS = ["dashboard", "positions", "aeo", "ga4", "indexing", "backlinks", "annotations", "optimize", "health", "audit", "ux", "settings"] as const;
  type TabKey = typeof TAB_KEYS[number];
  const [activeTab, setActiveTab] = useState<TabKey>("dashboard");
  const [period, setPeriod]       = useState("7d");
  const [siteData, setSiteData]   = useState<any>(null);
  const [dataLoading, setDataLoading] = useState(true);

  const TABS = useMemo(() => {
    // Guest (share-link) view: read-only analytics tabs only — no settings, no
    // action-heavy modules (indexing submits, AI optimize, annotations, backlinks mgmt).
    if (readOnly) return [
      { key: "dashboard" as const, label: t("tabDashboard") },
      { key: "positions" as const, label: t("tabPositions") },
      { key: "ga4" as const,       label: t("tabGA4") },
      // Read-only by construction: the guest variant below renders only the profile panel,
      // and the endpoint refuses to fetch for a share-token caller regardless of what is sent.
      { key: "backlinks" as const, label: t("shareLinkProfile") },
      { key: "health" as const,    label: t("tabHealth") },
      { key: "audit" as const,     label: t("tabAudit") },
    ];
    return [
      { key: "dashboard" as const,   label: t("tabDashboard") },
      { key: "positions" as const,   label: t("tabPositions") },
      { key: "aeo" as const,         label: t("tabAeo") },
      { key: "ga4" as const,         label: t("tabGA4") },
      { key: "indexing" as const,    label: t("tabIndexing") },
      { key: "backlinks" as const,   label: t("backlinksTab") },
      { key: "annotations" as const, label: t("tabAnnotations") },
      { key: "optimize" as const,    label: t("tabOptimize") },
      { key: "health" as const,      label: t("tabHealth") },
      { key: "audit" as const,       label: t("tabAudit") },
      { key: "ux" as const,          label: t("tabUX") },
      { key: "settings" as const,    label: t("tabSettings") },
    ];
  }, [readOnly, t]);

  const [syncing, setSyncing] = useState(false);
  const [activeMetrics, setActiveMetrics] = useState<Set<Metric>>(new Set(["clicks", "impressions", "ctr", "position"]));
  const [positionFilter, setPositionFilter] = useState<number | null>(null);
  const [filterDimension, setFilterDimension] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [filterPreset, setFilterPreset] = useState<string | null>(null);
  // The Filter control only affects the Queries/Pages/Country/Device tables further down
  // the Dashboard page — it never touches the chart or the metric summary above it. Without
  // any feedback, applying a filter looks like nothing happened. Auto-scroll to the affected
  // tables whenever a filter is actually applied, so the effect is visible immediately.
  const resultsRef = useRef<HTMLDivElement>(null);
  const scrollToResults = () => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  const [googleUpdates, setGoogleUpdatesState] = useState(true);
  useEffect(() => {
    if (readOnly) return;
    const s = localStorage.getItem("site_google_updates");
    if (s !== null) setGoogleUpdatesState(s === "1");
  }, [readOnly]);
  const setGoogleUpdates = (fn: (v: boolean) => boolean) => setGoogleUpdatesState(v => {
    const next = fn(v);
    localStorage.setItem("site_google_updates", next ? "1" : "0");
    return next;
  });
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [showBrandedModal, setShowBrandedModal] = useState(false);
  const [brandedKeywords, setBrandedKeywords] = useState<string[]>([]);
  const [clusterMetrics, setClusterMetrics] = useState<{ clusters: ClusterRow[]; groups: ClusterRow[] } | null>(null);
  const [clusterLoading, setClusterLoading] = useState(false);
  const siteDbId = propSiteDbId || siteData?.siteDbId || '';
  const toggleMetric = (m: Metric) => setActiveMetrics(p => { const n = new Set(p); n.has(m) ? n.delete(m) : n.add(m); return n; });

  const fetchClusterMetrics = (p = period) => {
    if (!siteDbId) return;
    setClusterLoading(true);
    fetch(getUrl(`/api/gsc/cluster-metrics?siteId=${encodeURIComponent(siteDbId)}&period=${p}`))
      .then(r => r.json())
      .then(d => setClusterMetrics(d))
      .catch(() => {})
      .finally(() => setClusterLoading(false));
  };

  // Start null on both server and client's first render — reading localStorage in the lazy
  // initializer would make the client's first pass diverge from the SSR-ed HTML (the "Sync"
  // vs formatted-time text) and trigger a hydration mismatch (React #418). Load it after mount.
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    loadSyncedAt().then(d => { if (!cancelled && d) setSyncedAt(d); });
    return () => { cancelled = true; };
  }, [readOnly]);

  // Fetch data from DB whenever domain or period changes
  useEffect(() => {
    setDataLoading(true);
    fetch(getUrl(`/api/gsc/site?domain=${encodeURIComponent(domain)}&period=${period}`))
      .then(r => r.json())
      .then(d => setSiteData(d))
      .catch(() => {})
      .finally(() => setDataLoading(false));
  }, [domain, period, shareToken]);

  // Fetch cluster metrics whenever siteDbId or period changes
  useEffect(() => {
    if (siteDbId) fetchClusterMetrics(period);
  }, [siteDbId, period]);

  // Fetch branded keywords whenever siteDbId changes
  useEffect(() => {
    if (!siteDbId) return;
    fetch(getUrl(`/api/gsc/branded?siteId=${siteDbId}`))
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.branded)) setBrandedKeywords(d.branded); })
      .catch(() => {});
  }, [siteDbId, shareToken]);

  // Real data or empty fallback
  const chartData = useMemo(() => {
    if (siteData?.chartData?.length > 0) return siteData.chartData;
    // Empty fallback (no fake numbers)
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - 7 + i);
      return { date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), clicks: 0, impressions: 0, ctr: 0, position: 0, clicksC: 0, impressionsC: 0, ctrC: 0, positionC: 0 };
    });
  }, [siteData]);

  // ── AIO Impact mode: clicks & impressions normalized to index 100 at the first
  // non-zero day, drawn on ONE axis. When AI Overviews eat clicks, the impressions
  // index keeps climbing while the clicks index detaches downward — the divergence
  // is the impact, which raw dual-axis lines can't show.
  const [aioMode, setAioMode] = useState(false);

  // ── Search-engine switcher: Google (local GSC data) vs live Bing / Yandex views.
  // Alt engines appear only when their key/token is configured in Settings.
  const [engine, setEngine] = useState<"google" | AltEngine>("google");
  const [engineSummary, setEngineSummary] = useState<EngineSummary | null>(null); // KPI row for Bing/Yandex
  const [engineRefresh, setEngineRefresh] = useState(0); // bumped by Sync to refetch live views
  const [altEngines, setAltEngines] = useState<AltEngine[]>([]);

  // ── Sync. The run itself belongs to the server process, so everything here only watches it.
  // Sits below the engine state because it bumps `engineRefresh` when a run ends.
  //
  // Runs when the server reports the sync finished. See src/lib/syncedAt.ts for why the watcher
  // has no deadline: a full sync of a couple of hundred properties takes longer than the fifteen
  // minutes the old code allowed, and cutting the spinner off mid-run made a healthy sync look
  // like a failed one.
  const settleSync = (s: SyncState) => {
    const at = s.completedAt ?? new Date();
    setSyncedAt(at);
    rememberSyncedAt(at);
    // Sync-all: also refresh the live Bing/Yandex views if any are connected.
    setEngineRefresh(k => k + 1);
    fetch(getUrl(`/api/gsc/site?domain=${encodeURIComponent(domain)}&period=${period}`))
      .then(r => r.json())
      .then(d => { if (d?.chartData) setSiteData(d); })
      .catch(() => {})
      .finally(() => setSyncing(false));
  };

  const stopWatch = useRef<(() => void) | null>(null);
  useEffect(() => () => { stopWatch.current?.(); }, []);

  const handleSync = () => {
    if (syncing || readOnly) return;
    setSyncing(true);

    fetch('/api/gsc/sync', { method: 'POST' })
      .then(r => r.json())
      .then(() => {
        stopWatch.current?.();
        stopWatch.current = watchSync(settleSync, () => setSyncing(false));
      })
      .catch(() => setSyncing(false));
  };

  // Pick up a run that is already going, so opening this page mid-sync shows the spinner rather
  // than an idle button.
  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    fetchSyncState().then(s => {
      if (cancelled || !s?.syncing) return;
      setSyncing(true);
      stopWatch.current?.();
      stopWatch.current = watchSync(settleSync, () => setSyncing(false));
    });
    return () => { cancelled = true; };
    // settleSync is rebuilt every render; listing it would restart the watcher each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);
  useEffect(() => {
    // Guest (share link): the owner's keys aren't in this browser — use the server-provided
    // list of engines configured for this site instead.
    if (shareToken) {
      const list: AltEngine[] = [];
      if (guestEngines?.bing) list.push("bing");
      if (guestEngines?.yandex) list.push("yandex");
      setAltEngines(list);
      return;
    }
    // Owner: an engine is available if a global key OR at least one connected account exists.
    const has = (eng: string) => {
      if (localStorage.getItem(`seoKey_${eng}`)) return true;
      try { return (JSON.parse(localStorage.getItem(`seoKey_${eng}_accounts_list`) || "[]") as any[]).length > 0; }
      catch { return false; }
    };
    const list: AltEngine[] = [];
    if (has("bing")) list.push("bing");
    if (has("yandex")) list.push("yandex");
    setAltEngines(list);
  }, [shareToken, guestEngines]);
  const aioChartData = useMemo(() => {
    const rows: any[] = chartData ?? [];
    const baseClicks = rows.find(r => (r.clicks ?? 0) > 0)?.clicks ?? 0;
    const baseImpr = rows.find(r => (r.impressions ?? 0) > 0)?.impressions ?? 0;
    return rows.map(r => ({
      date: r.date,
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      clicksIdx: baseClicks ? Math.round(((r.clicks ?? 0) / baseClicks) * 100) : 0,
      imprIdx: baseImpr ? Math.round(((r.impressions ?? 0) / baseImpr) * 100) : 0,
    }));
  }, [chartData]);

  // Google's published update list, with the built-in one as the starting value so the chart has
  // something to draw before the request lands (and if it never does).
  const [algoUpdates, setAlgoUpdates] = useState<AlgoUpdate[]>(ALGO_UPDATES);
  useEffect(() => {
    if (readOnly) return;
    fetch(getUrl("/api/gsc/algo-updates"))
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (Array.isArray(d?.updates) && d.updates.length) setAlgoUpdates(d.updates); })
      .catch(() => { /* built-in list stays */ });
  }, [readOnly]);

  // Google updates inside the visible window, each already snapped to a real point on the axis.
  // Snapping happens here rather than at render time because an update with no matching point is
  // dropped entirely, and doing that in the map below would leave holes in the JSX.
  const visibleAlgoUpdates = useMemo(() => {
    const chart = siteData?.chartData;
    if (!chart?.length) return [];
    const start = chart[0]?.dateIso;
    const end = chart[chart.length - 1]?.dateIso;
    if (!start || !end) return [];

    // Neighbours are resolved over the whole list before filtering to the window, so an update
    // just outside the period still bounds the measurement of the one inside it.
    return withNeighbours(algoUpdates)
      // Overlap, not containment: a core update that began before the window and finished inside
      // it is exactly the one an operator is looking for when traffic moved early in the period.
      .filter(u => (updateEnd(u) ?? u.date) >= start && u.date <= end)
      .map(u => {
        const x = snapToChartLabel(chart, u.date);
        const endIso = updateEnd(u);
        const x2 = endIso ? snapBackToChartLabel(chart, endIso) : null;
        // A band only when the rollout actually spans more than one point on this axis; on a
        // 16-month window most updates collapse into a single label and a zero-width area would
        // render as an invisible sliver.
        return {
          ...u,
          x,
          x2: x2 && x2 !== x ? x2 : null,
          impact: algoImpact(chart, u.date, endIso ?? u.date,
            { prevEndIso: u.prevEndIso, nextStartIso: u.nextStartIso }),
        };
      })
      .filter((u): u is AlgoUpdate & { x: string; x2: string | null; impact: AlgoImpactResult } => u.x !== null);
  }, [siteData, algoUpdates]);

  // ── Rank tracker: which queries are already tracked (for Track buttons) ──────
  const [trackedKws, setTrackedKws] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!siteDbId || readOnly) return;
    fetch(getUrl(`/api/rank/keywords?siteId=${encodeURIComponent(siteDbId)}`))
      .then(r => r.json())
      .then(d => {
        if (Array.isArray(d.keywords)) setTrackedKws(new Set(d.keywords.map((k: any) => String(k.keyword).toLowerCase())));
      })
      .catch(() => {});
  }, [siteDbId, readOnly, shareToken]);

  const handleTrack = (label: string) => {
    const kw = label.trim().toLowerCase();
    if (!kw || trackedKws.has(kw) || !siteDbId) return;
    setTrackedKws(prev => new Set(prev).add(kw));
    fetch("/api/rank/keywords", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteId: siteDbId, keywords: [kw] }),
    })
      .then(() => fetch("/api/rank/check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId }),
      }))
      .catch(() => {});
  };

  const applyPreset = (rows: any[]) => {
    if (filterPreset === "paa")      return rows.filter((r: any) => r.label?.includes("?"));
    if (filterPreset === "longtail") return rows.filter((r: any) => (r.label?.split(" ").length ?? 0) >= 3);
    return rows;
  };

  const queryRows = useMemo(() => {
    let rows = siteData?.queries ?? [];
    if (positionFilter)                                  rows = rows.filter((r: any) => r.pos <= positionFilter);
    if (filterDimension === "query" && filterText.trim()) rows = rows.filter((r: any) => r.label?.toLowerCase().includes(filterText.toLowerCase()));
    rows = applyPreset(rows);
    return rows;
  }, [siteData, positionFilter, filterDimension, filterText, filterPreset]);

  const pageRows = useMemo(() => {
    let rows = siteData?.pages ?? [];
    if (positionFilter)                                 rows = rows.filter((r: any) => r.pos <= positionFilter);
    if (filterDimension === "page" && filterText.trim()) rows = rows.filter((r: any) => r.label?.toLowerCase().includes(filterText.toLowerCase()));
    return rows;
  }, [siteData, positionFilter, filterDimension, filterText]);
  const countryRows = useMemo(() => {
    let rows = siteData?.countries ?? [];
    if (filterDimension === "country" && filterText.trim())
      rows = rows.filter((r: any) => r.country?.toLowerCase().includes(filterText.toLowerCase()) || iso3ToName(r.country ?? "", language).toLowerCase().includes(filterText.toLowerCase()));
    return rows;
  }, [siteData, filterDimension, filterText]);

  const deviceRowsReal = useMemo(() => {
    let rows = siteData?.devices ?? [];
    if (filterDimension === "device" && filterText)
      rows = rows.filter((r: any) => r.device?.toUpperCase() === filterText.toUpperCase());
    return rows;
  }, [siteData, filterDimension, filterText]);
  const newQueryRows   = useMemo(() => siteData?.newQueries     ?? [], [siteData]);
  const newPageRows    = useMemo(() => siteData?.newPages       ?? [], [siteData]);
  const positionBuckets = useMemo(() => siteData?.positionBuckets ?? { '1-3': 0, '4-10': 0, '11-20': 0, '21+': 0 }, [siteData]);

  // Summary from API (or zeros)
  const summary = siteData?.summary ?? { clicks: { value: 0, change: 0 }, impressions: { value: 0, change: 0 }, ctr: { value: 0, change: 0 }, position: { value: 0, change: 0 } };

  const totalClicks = summary.clicks.value;
  const totalImpr   = summary.impressions.value;
  const avgCtr      = summary.ctr.value;
  const avgPos      = summary.position.value;

  // Query counting: real position distribution from GSC queries
  const qcBuckets = [
    { label: "1-3",   color: "#F59E0B", count: positionBuckets["1-3"]   },
    { label: "4-10",  color: "#1e40af", count: positionBuckets["4-10"]  },
    { label: "11-20", color: "#3B82F6", count: positionBuckets["11-20"] },
    { label: "21+",   color: "#93c5fd", count: positionBuckets["21+"]   },
  ];
  const qcTotal = qcBuckets.reduce((s, b) => s + b.count, 0);

  const periodLabel = PERIOD_OPTIONS.find(o => o.key === period)?.label ?? period;
  const periodOptions = PERIOD_OPTIONS.map(o => o.key);

  return (
    <div style={{ minHeight: "100vh", background: "var(--color-bg)", color: "var(--color-text-primary)", fontFamily: "Inter, sans-serif" }}>
      {/* Top nav */}
      <div style={{ borderBottom: "1px solid var(--color-border)", padding: "0 32px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--color-card)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0" }}>
          {/* Breadcrumb */}
          <button onClick={() => router.push("/")} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "16px 0", color: "var(--color-text-secondary)", fontSize: "14px", fontWeight: 600, cursor: "pointer", border: "none", background: "none" }}>
            <span style={{ opacity: 0.6 }}>OpenGSC</span>
          </button>
          <span style={{ color: "var(--color-text-secondary)", margin: "0 8px" }}>/</span>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/favicon?domain=${domain}`} width={14} height={14} alt="" style={{ borderRadius: "2px" }} onError={e=>((e.target as HTMLImageElement).style.display="none")} />
            <span style={{ fontSize: "14px", fontWeight: 600, ...blurStyle }}>{domain}</span>
            <a href={`https://${domain}`} target="_blank" rel="noreferrer" title={t("openSite") || "Open site"}
              style={{ display: "flex", alignItems: "center", color: "var(--color-text-secondary)", flexShrink: 0, padding: "2px", borderRadius: "4px" }}
              onMouseEnter={e => (e.currentTarget.style.color = "var(--color-text-primary)")}
              onMouseLeave={e => (e.currentTarget.style.color = "var(--color-text-secondary)")}>
              <ExternalLink size={12} />
            </a>
            {drValue != null && (
              <span style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
                <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 7px", borderRadius: "6px", background: "rgba(58,87,252,0.12)", color: "#3A57FC", ...blurStyle }}>DR {Math.round(drValue)}</span>
                <a href="https://ahrefs.com/" target="_blank" rel="noreferrer" style={{ fontSize: "10px", color: "var(--color-text-tertiary)", textDecoration: "none" }} title={t("drByAhrefs")}>{t("byAhrefs")}</a>
              </span>
            )}
            {/* Traffic sits next to DR because they answer the same question from two sides:
                how strong is this domain, and how many people actually arrive. Renders nothing
                at all without a cached figure or a configured key. */}
            <TrafficChip domain={domain} shareToken={shareToken} style={blurStyle} />
          </div>
          <span style={{ margin: "0 24px", color: "var(--color-border)" }}>|</span>
          {/* Tab nav */}
          <nav style={{ display: "flex", gap: "0" }}>
            {TABS.map(({ key, label }) => (
              <button key={key} onClick={() => setActiveTab(key)} style={{
                padding: "16px 14px", fontSize: "13px", fontWeight: activeTab === key ? 600 : 400,
                color: activeTab === key ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                cursor: "pointer", border: "none",
                borderBottom: activeTab === key ? "2px solid var(--color-text-primary)" : "2px solid transparent",
                background: "none", transition: "all 0.15s",
              }}>{label}</button>
            ))}
          </nav>
        </div>
      </div>

      {/* ── Branded Keywords modal ── */}
      {showBrandedModal && siteDbId && (
        <BrandedKeywordsModal
          siteDbId={siteDbId}
          domain={domain}
          initial={brandedKeywords}
          onClose={() => setShowBrandedModal(false)}
          onSaved={(kws) => { setBrandedKeywords(kws); setShowBrandedModal(false); }}
        />
      )}

      {/* ── One Click Setup modal ── */}
      {showSetupModal && siteDbId && (
        <SetupModal
          domain={domain}
          siteDbId={siteDbId}
          onClose={() => setShowSetupModal(false)}
          onApplied={() => {
            setShowSetupModal(false);
            fetchClusterMetrics(period);
          }}
        />
      )}

      {/* ── Positions (Rank Tracker) tab ── */}
      {activeTab === "positions" && <RankTracker siteDbId={siteDbId} domain={domain} />}

      {/* ── AI Visibility (AEO Tracker) tab ── */}
      {activeTab === "aeo" && <AeoTracker siteDbId={siteDbId} domain={domain} />}

      {/* ── GA4 tab ── */}
      {activeTab === "ga4" && (
        <GA4Tab domain={domain} period={period} setPeriod={setPeriod} periodOptions={periodOptions} />
      )}

      {/* ── Indexing tab ── */}
      {activeTab === "indexing" && <IndexingTab siteDbId={siteDbId} domain={domain} />}

      {/* ── Backlinks tab ── */}
      {/* Guests get the profile only — the manual list below it is a working surface with
          add/delete/recheck actions that a client report has no business exposing. */}
      {activeTab === "backlinks" && (readOnly
        ? <div style={{ padding: "24px 32px" }}><BacklinkProfile siteDbId={siteDbId} /></div>
        : <BacklinksTab siteDbId={siteDbId} />)}

      {/* ── Annotations tab ── */}
      {activeTab === "annotations" && (
        <AnnotationsTab period={period} setPeriod={setPeriod} periodOptions={periodOptions} onSetupBranded={() => setShowSetupModal(true)} siteDbId={siteDbId} chartData={siteData?.chartData} algoMarkers={visibleAlgoUpdates} />
      )}

      {/* ── Optimize tab ── */}
      {activeTab === "optimize" && <OptimizeTab siteDbId={siteDbId} />}

      {/* ── Health tab ── */}
      {activeTab === "health" && <SiteHealthPanel siteDbId={siteDbId} />}

      {activeTab === "audit" && <SiteAuditPanel siteDbId={siteDbId} />}

      {/* ── UX / Clarity tab ── */}
      {activeTab === "ux" && <ClarityPanel siteDbId={siteDbId} domain={domain} />}

      {/* ── Settings tab ── */}
      {activeTab === "settings" && (
        <SiteSettingsTab domain={domain} siteDbId={siteDbId} />
      )}

      {/* ── Dashboard tab content ── */}
      {activeTab === "dashboard" && (
      <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: "32px" }}>

        {/* Metric summary + toolbar — same row, no boxed/bordered panel, just sits
            plainly on the page like the metrics next to it. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
          {engine === "google" ? <div style={{ display: "flex", alignItems: "center", gap: "28px" }}>
            {[
              { icon: <Sparkles size={14} style={{ color: C.clicks }} />, val: dataLoading ? "…" : fmtK(totalClicks), chg: summary.clicks.change, invert: false },
              { icon: <Eye size={14} style={{ color: C.impressions }} />, val: dataLoading ? "…" : fmtK(totalImpr), chg: summary.impressions.change, invert: false },
              { icon: <Percent size={14} style={{ color: C.ctr }} />, val: dataLoading ? "…" : `${avgCtr}%`, chg: summary.ctr.change, invert: false },
              { icon: <MoveUp size={14} style={{ color: C.position }} />, val: dataLoading ? "…" : String(avgPos), chg: summary.position.change, invert: true },
            ].map(({ icon, val, chg, invert }, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                {icon}
                <span style={{ fontSize: "22px", fontWeight: 700, color: "var(--color-text-primary)" }}>{val}</span>
                {!dataLoading && chg !== 0 && <Change pct={chg} invert={invert} />}
              </div>
            ))}
          </div> : engineSummary ? (
            <div style={{ display: "flex", alignItems: "center", gap: "28px", flexWrap: "wrap" }}>
              {[
                { icon: <Sparkles size={14} style={{ color: C.clicks }} />, val: fmtK(engineSummary.clicks), chg: engineSummary.dClicks, invert: false },
                { icon: <Eye size={14} style={{ color: C.impressions }} />, val: fmtK(engineSummary.impressions), chg: engineSummary.dImpr, invert: false },
                { icon: <Percent size={14} style={{ color: C.ctr }} />, val: `${engineSummary.ctr}%`, chg: engineSummary.dCtr, invert: false },
                { icon: <MoveUp size={14} style={{ color: C.position }} />, val: engineSummary.position != null ? String(engineSummary.position) : "—", chg: engineSummary.dPos, invert: true },
              ].map(({ icon, val, chg, invert }, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                  {icon}
                  <span style={{ fontSize: "22px", fontWeight: 700, color: "var(--color-text-primary)" }}>{val}</span>
                  {engineSummary.hasCmp && chg !== 0 && <Change pct={chg} invert={invert} />}
                </div>
              ))}
              <span style={{ fontSize: "12px", fontWeight: 600, color: engine === "bing" ? "#00809D" : "#FC3F1D" }}>{engine === "bing" ? "Bing" : t("seEngineYandex")} <span style={{ fontWeight: 400, color: "var(--color-text-secondary)" }}>· {t("seLiveData")}</span></span>
            </div>
          ) : <div style={{ fontSize: "14px", fontWeight: 700, color: engine === "bing" ? "#00809D" : "#FC3F1D" }}>{engine === "bing" ? "Bing Webmaster" : t("seEngineYandexFull")} <span style={{ fontWeight: 400, fontSize: "12px", color: "var(--color-text-secondary)" }}>· {t("seLiveData")}</span></div>}

          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            {/* Engine switcher — shown only when Bing/Yandex keys are configured */}
            {altEngines.length > 0 && (
              <div style={{ display: "flex", gap: "2px", background: "rgba(255,255,255,0.06)", borderRadius: "8px", padding: "2px", marginRight: "4px" }}>
                {(["google", ...altEngines] as ("google" | AltEngine)[]).map(id => (
                  <button key={id} onClick={() => setEngine(id)}
                    style={{ padding: "5px 10px", borderRadius: "6px", fontSize: "11px", fontWeight: 700, cursor: "pointer", border: "none",
                      display: "flex", alignItems: "center", gap: "4px",
                      background: engine === id ? "var(--color-card)" : "transparent",
                      color: engine === id ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}>
                    {id === "google" ? <GoogleIcon size={14} /> : id === "bing" ? <BingIconSite size={14} /> : <YandexIconSite size={14} />}
                  </button>
                ))}
              </div>
            )}
            {engine === "google" && <>
            {/* AIO Impact: normalized clicks vs impressions on one axis */}
            <button onClick={() => setAioMode(v => !v)} title={t("aioImpactHint")}
              style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 10px", borderRadius: "8px", border: `1px solid ${aioMode ? "#8B5CF6" : "var(--color-border)"}`, background: aioMode ? "rgba(139,92,246,0.1)" : "var(--color-card)", color: aioMode ? "#8B5CF6" : "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
              <Sparkles size={13} /> {t("aioImpact")}
            </button>
            <GoogleUpdatesToggle on={googleUpdates} onToggle={() => setGoogleUpdates(v => !v)} />
            <FilterDd
              positionFilter={positionFilter}
              onPositionFilter={v => { setPositionFilter(v); if (v !== null) scrollToResults(); }}
              filterDimension={filterDimension} filterText={filterText}
              onDimension={setFilterDimension} onFilterText={setFilterText}
              preset={filterPreset}
              onPreset={v => { setFilterPreset(v); if (v !== null) scrollToResults(); }}
              onApply={scrollToResults}
            />
            </>}
            {/* Metric toggles — shared across Google, Bing and Yandex charts */}
            {([
              { m: "clicks"      as Metric, icon: <Sparkles size={13}/>, color: C.clicks,      bg: "rgba(59,130,246,0.12)"  },
              { m: "impressions" as Metric, icon: <Eye      size={13}/>, color: C.impressions, bg: "rgba(139,92,246,0.12)"  },
              { m: "ctr"         as Metric, icon: <Percent  size={13}/>, color: C.ctr,         bg: "rgba(16,185,129,0.12)"  },
              { m: "position"    as Metric, icon: <MoveUp   size={13}/>, color: C.position,    bg: "rgba(245,158,11,0.12)"  },
            ]).map(({ m, icon, color, bg }) => {
              const on = activeMetrics.has(m);
              return (
                <button key={m} onClick={() => toggleMetric(m)}
                  title={m === "clicks" ? t("clicks") : m === "impressions" ? t("impressions") : m === "ctr" ? "CTR" : t("avgPosition")}
                  style={{ width: "30px", height: "30px", borderRadius: "6px", border: `1px solid ${on ? color : "var(--color-border)"}`, background: on ? bg : "var(--color-card)", color: on ? color : "var(--color-text-secondary)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.15s", opacity: on ? 1 : 0.5 }}>
                  {icon}
                </button>
              );
            })}
            <PeriodDropdown period={period} onChange={setPeriod} />
            <button
              onClick={handleSync}
              disabled={syncing}
              title={syncedAt ? `Last synced: ${syncedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${syncedAt.toLocaleDateString([], { month: 'short', day: 'numeric' })}` : 'Sync GSC data'}
              style={{ display: "flex", alignItems: "center", gap: "5px", padding: "6px 11px", borderRadius: "8px", border: "1px solid var(--color-border)", background: syncing ? "rgba(59,130,246,0.08)" : "var(--color-card)", color: syncing ? "#3B82F6" : "var(--color-text-secondary)", fontSize: "12px", fontWeight: 500, cursor: syncing ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, animation: syncing ? "spin 1.2s linear infinite" : "none" }}>
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
              {syncing ? "Syncing…" : syncedAt ? syncedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "Sync"}
            </button>
          </div>
        </div>

        {/* Main chart — GSC (local) or a live Bing/Yandex view */}
        {engine !== "google" ? (
          <EngineView engine={engine} domain={domain} siteDbId={siteDbId} refreshKey={engineRefresh} metrics={activeMetrics} days={periodToDays(period)} onSummary={setEngineSummary} />
        ) : (
        <div style={{ background: "var(--color-card)", borderRadius: "12px", padding: "16px", border: "1px solid var(--color-border)" }}>
          <ResponsiveContainer width="100%" height={300}>
            {/* Extra headroom when update markers are on: their labels sit above the plot area,
                and at the default 8px they were clipped by the top of the chart — the text was
                half-drawn and unreadable. Only reserved when something needs it, so the plot
                keeps its full height the rest of the time. */}
            <ComposedChart
              data={aioMode ? aioChartData : chartData}
              margin={{ top: googleUpdates && visibleAlgoUpdates.length > 0 ? 26 : 8, right: 0, left: 0, bottom: 0 }}
            >
              <defs>
                {(["clicks", "impressions", "ctr", "position"] as const).map(m => (
                  <linearGradient key={m} id={`sg-${m}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C[m]} stopOpacity={0.18} />
                    <stop offset="100%" stopColor={C[m]} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "var(--color-text-secondary)" }} />
              <YAxis yAxisId="left"  axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "var(--color-text-secondary)" }} />
              {!aioMode && <YAxis yAxisId="right" orientation="right" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "var(--color-text-secondary)" }} />}
              <Tooltip content={aioMode ? <AioTooltip /> : <SiteTooltip />} cursor={{ stroke: "var(--color-border)", strokeWidth: 1 }} />
              {aioMode ? (
                <>
                  {/* Index 100 baseline = the first non-zero day; divergence below it while
                      impressions stay above = clicks being absorbed (AI Overviews et al.) */}
                  <ReferenceLine yAxisId="left" y={100} stroke="var(--color-text-secondary)" strokeDasharray="4 4" strokeOpacity={0.5} />
                  <Line yAxisId="left" type="monotone" dataKey="imprIdx" stroke={C.impressions} strokeWidth={2} dot={false} />
                  <Line yAxisId="left" type="monotone" dataKey="clicksIdx" stroke={C.clicks} strokeWidth={2} dot={false} />
                </>
              ) : (
                <>
                  {activeMetrics.has("clicks")      && <Line yAxisId="left"  type="monotone" dataKey="clicksC"      stroke={C.clicks}       strokeWidth={1}   strokeDasharray="4 3" dot={false} legendType="none" />}
                  {activeMetrics.has("impressions") && <Line yAxisId="right" type="monotone" dataKey="impressionsC" stroke={C.impressions}   strokeWidth={1}   strokeDasharray="4 3" dot={false} legendType="none" />}
                  {activeMetrics.has("ctr")         && <Line yAxisId="left"  type="monotone" dataKey="ctrC"         stroke={C.ctr}           strokeWidth={1}   strokeDasharray="4 3" dot={false} legendType="none" />}
                  {activeMetrics.has("position")    && <Line yAxisId="left"  type="monotone" dataKey="positionC"    stroke={C.position}      strokeWidth={1}   strokeDasharray="4 3" dot={false} legendType="none" />}
                  {activeMetrics.has("clicks")      && <Area yAxisId="left"  type="monotone" dataKey="clicks"      stroke={C.clicks}       strokeWidth={2}   fill={`url(#sg-clicks)`}      dot={false} />}
                  {activeMetrics.has("impressions") && <Area yAxisId="right" type="monotone" dataKey="impressions" stroke={C.impressions}   strokeWidth={2}   fill={`url(#sg-impressions)`} dot={false} />}
                  {activeMetrics.has("ctr")         && <Line yAxisId="left"  type="monotone" dataKey="ctr"         stroke={C.ctr}           strokeWidth={1.5} dot={false} />}
                  {activeMetrics.has("position")    && <Line yAxisId="left"  type="monotone" dataKey="position"    stroke={C.position}      strokeWidth={1.5} dot={false} />}
                </>
              )}
              {/* Google algorithm update markers (core / spam / discover) */}
              {googleUpdates && renderAlgoMarkers(visibleAlgoUpdates, t as never)}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        )}

        {/* Topic Clusters + Content Groups */}
        <div>
          {/* Header row with One Click Setup button */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
            <span style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
              {clusterLoading ? t("loading") : (clusterMetrics?.clusters?.length ?? 0) + (clusterMetrics?.groups?.length ?? 0) > 0 ? "" : t("noClustersYet")}
            </span>
            <button
              onClick={() => setShowSetupModal(true)}
              style={{ display: "flex", alignItems: "center", gap: "6px", padding: "7px 14px", borderRadius: "8px", border: "1.5px solid rgba(59,130,246,0.5)", background: "rgba(59,130,246,0.08)", color: "#3B82F6", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
            >
              <Sparkles size={13} />
              One Click Setup
            </button>
          </div>

          {/* Tables or placeholders */}
          {(clusterMetrics?.clusters?.length ?? 0) > 0 || (clusterMetrics?.groups?.length ?? 0) > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
              <ClusterTable
                title={t("topicClusters")}
                data={clusterMetrics?.clusters ?? []}
                blur={blur}
              />
              <ClusterTable
                title={t("contentGroups")}
                data={clusterMetrics?.groups ?? []}
                blur={blur}
              />
            </div>
          ) : !clusterLoading ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
              <div>
                <h3 style={{ fontSize: "15px", fontWeight: 700, marginBottom: "12px", color: "var(--color-text-primary)" }}>{t("topicClusters")}</h3>
                <Placeholder icon={<MoveUp size={28} />} title={t("missingTopicClusters")} desc="Click One Click Setup to generate clusters automatically" />
              </div>
              <div>
                <h3 style={{ fontSize: "15px", fontWeight: 700, marginBottom: "12px", color: "var(--color-text-primary)" }}>{t("contentGroups")}</h3>
                <Placeholder icon={
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="8" y="8" width="8" height="8" rx="1"/><rect x="3" y="3" width="5" height="5" rx="1"/><rect x="16" y="3" width="5" height="5" rx="1"/><rect x="3" y="16" width="5" height="5" rx="1"/><rect x="16" y="16" width="5" height="5" rx="1"/></svg>
                } title={t("missingContentGroups")} desc="Click One Click Setup to generate groups automatically" />
              </div>
            </div>
          ) : null}
        </div>

        {/* Queries + Pages — target of the Filter control above; scrolled into view
            automatically whenever a filter is applied, since it's the only thing that
            actually changes when you use Filter (chart/metrics above never do). */}
        {(positionFilter || (filterDimension && filterText.trim()) || filterPreset) && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
            <SlidersHorizontal size={12} color="#3B82F6" />
            <span>
              Filter active — {[
                positionFilter && `Top ${positionFilter}`,
                filterDimension && filterText.trim() && `${filterDimension}: "${filterText}"`,
                filterPreset && (filterPreset === "paa" ? "People Also Ask" : "Long Tail Keywords"),
              ].filter(Boolean).join(", ")} (Queries/Pages below)
            </span>
          </div>
        )}
        <div ref={resultsRef} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px", scrollMarginTop: "16px" }}>
          <DataTable title={t("queriesTable")} rows={queryRows} tabs={["All", "Growing", "Decaying"]} blur={blur} csvFilename="queries.csv"
            onTrack={handleTrack} tracked={trackedKws} />
          <DataTable title={t("pagesTable")}   rows={pageRows}  tabs={["All", "Growing", "Decaying"]} blur={blur} csvFilename="pages.csv" />
        </div>

        {/* Winners & Losers (click delta vs previous period) */}
        <WinnersLosers data={siteData?.winnersLosers} blur={blur} onTrack={handleTrack} tracked={trackedKws} />

        {/* Branded + Query Counting */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
              <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("brandedVsNonBranded")}</h3>
              {brandedKeywords.length > 0 && (
                <button onClick={() => setShowBrandedModal(true)} style={{ fontSize: "11px", color: "#3B82F6", background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)", borderRadius: "6px", cursor: "pointer", padding: "2px 8px" }}>✎ {t("brandEditKeys")}</button>
              )}
            </div>
            {brandedKeywords.length > 0 ? (
              <BrandedChart siteDbId={siteDbId} period={period} keywords={brandedKeywords} />
            ) : (
              <Placeholder icon={
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="9"/><path d="M9 9h1.5a1.5 1.5 0 0 1 0 3H9v3m3-6h1.5"/></svg>
              } title={t("missingBrandedKeywords")} desc={`${t("define")} ${t("activateReportDesc")}`} onClick={() => setShowBrandedModal(true)} />
            )}
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
              <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("queryCounting")}</h3>
              {qcTotal > 0 && <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{qcTotal} {t("queriesTable").toLowerCase()}</span>}
            </div>
            {qcTotal === 0 ? (
              <div style={{ height: "160px", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-secondary)", fontSize: "13px" }}>
                {dataLoading ? t("loading") : t("noDataYet")}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {qcBuckets.map(({ label, color, count }) => {
                  const barPct = qcTotal > 0 ? Math.round((count / qcTotal) * 100) : 0;
                  return (
                    <div key={label}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <div style={{ width: "10px", height: "10px", background: color, borderRadius: "2px", flexShrink: 0 }} />
                          <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)" }}>Position {label}</span>
                        </div>
                        <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{count} <span style={{ color }}>{barPct}%</span></span>
                      </div>
                      <div style={{ height: "8px", background: "var(--color-border)", borderRadius: "4px", overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${barPct}%`, background: color, borderRadius: "4px", transition: "width 0.6s ease" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Countries + New Rankings */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px" }}>
          <CountryTable rows={countryRows} />
          <NewRankingsTable queryRows={newQueryRows} pageRows={newPageRows} blur={blur} />
        </div>

        {/* Devices */}
        <DeviceTable rows={deviceRowsReal} />

      </div>
      )}
    </div>
  );
}
