"use client";

// Rank Tracker tab ("Positions") for the site detail page.
// Tracked keywords are checked via the user's SERP provider (Serper / DataForSEO /
// ScrapingRobot — configured in SEO Tools → Settings) by the in-app daily scheduler,
// or on demand with "Check positions". Each keyword expands into a history chart
// that overlays the scraped SERP position with the GSC average position.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { Plus, RefreshCw, Trash2, ChevronDown, ChevronUp, ChevronsUpDown, ExternalLink, Search, MapPin, Globe } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { withShare, isGuestView } from "@/lib/shareParam";
import { usePrivacy } from "@/lib/PrivacyContext";
import { COUNTRIES, LANGUAGES } from "@/lib/seo/regions";
import KeywordWeightsBar from "@/components/KeywordWeightsBar";
import { useKeywordWeights } from "@/lib/seo/useKeywordWeights";

type KwRow = {
  id: string; keyword: string; country: string; lang: string; device: string;
  createdAt: string; lastCheckedAt: string | null;
  position: number | null; prevPosition: number | null; bestPosition: number | null;
  url: string | null; lastError: string | null;
  history: { date: string; position: number | null }[];
  gsc: { pos: number; clicks: number; impressions: number } | null;
};

function PosDelta({ position, prev }: { position: number | null; prev: number | null }) {
  if (position === null || prev === null || position === prev) return null;
  const up = position < prev; // lower = better
  const diff = Math.abs(prev - position);
  return (
    <span style={{ fontSize: "11px", fontWeight: 700, color: up ? "#10B981" : "#EF4444", marginLeft: "6px" }}>
      {up ? "▲" : "▼"}{diff}
    </span>
  );
}

// Tiny inline sparkline of position history (lower position = higher point).
function PosSparkline({ history }: { history: { date: string; position: number | null }[] }) {
  const pts = history.filter(h => h.position !== null) as { date: string; position: number }[];
  if (pts.length < 2) return <span style={{ color: "var(--color-text-secondary)", fontSize: "11px" }}>—</span>;
  const w = 90, h = 24, pad = 2;
  const min = Math.min(...pts.map(p => p.position));
  const max = Math.max(...pts.map(p => p.position));
  const span = Math.max(1, max - min);
  const xy = pts.map((p, i) => {
    const x = pad + (i / (pts.length - 1)) * (w - pad * 2);
    const y = pad + ((p.position - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const improving = pts[pts.length - 1].position <= pts[0].position;
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={xy.join(" ")} fill="none" stroke={improving ? "#10B981" : "#EF4444"} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

type SortKey = "keyword" | "position" | "best" | "gsc" | "trend" | "checked" | "volume";

/** Same scale Ahrefs uses, so a number a user recognises keeps the colour they expect. */
function kdColor(kd: number) {
  if (kd <= 14) return "var(--color-success)";
  if (kd <= 29) return "var(--color-accent-green)";
  if (kd <= 49) return "var(--color-warning)";
  if (kd <= 69) return "var(--color-accent-orange)";
  return "var(--color-danger)";
}

// Clickable column header — click toggles asc/desc, switching columns resets to asc.
function SortableTh({ label, active, dir, align = "center", onClick }: {
  label: string; active: boolean; dir: "asc" | "desc"; align?: "left" | "center"; onClick: () => void;
}) {
  return (
    <th
      onClick={onClick}
      style={{
        textAlign: align, padding: "10px 12px", cursor: "pointer", userSelect: "none",
        color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
        fontWeight: 600, fontSize: "11px", letterSpacing: "0.05em", textTransform: "uppercase", whiteSpace: "nowrap",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: "3px", justifyContent: align === "center" ? "center" : "flex-start" }}>
        {label}
        {active
          ? (dir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)
          : <ChevronsUpDown size={11} style={{ opacity: 0.35 }} />}
      </span>
    </th>
  );
}

function HistoryChart({ keywordId }: { keywordId: string }) {
  const { t } = useLanguage();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(withShare(`/api/rank/history?keywordId=${encodeURIComponent(keywordId)}&days=90`))
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [keywordId]);

  const series = useMemo(() => (data?.series ?? []).map((s: any) => ({
    ...s,
    label: new Date(s.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  })), [data]);

  if (loading) return <div style={{ padding: "24px", fontSize: "13px", color: "var(--color-text-secondary)" }}>Loading…</div>;
  if (!series.length) return <div style={{ padding: "24px", fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("wlNoData")}</div>;

  return (
    <div style={{ padding: "16px 12px 8px" }}>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
          <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }} />
          <YAxis reversed domain={[1, "dataMax"]} allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }} />
          <Tooltip
            contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "8px", fontSize: "12px" }}
            labelStyle={{ color: "var(--color-text-secondary)" }}
          />
          <Legend wrapperStyle={{ fontSize: "11px" }} />
          <Line name={t("rankSerp")} type="monotone" dataKey="serp" stroke="#3B82F6" strokeWidth={2} dot={{ r: 2 }} connectNulls />
          <Line name={t("rankGsc")} type="monotone" dataKey="gsc" stroke="#F59E0B" strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function RankTracker({ siteDbId }: { siteDbId: string; domain?: string }) {
  const { t } = useLanguage();
  const guest = isGuestView();
  const { blur } = usePrivacy();
  const blurStyle: React.CSSProperties = blur ? { filter: "blur(5px)", userSelect: "none" } : {};

  const [rows, setRows] = useState<KwRow[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(true);
  const [loading, setLoading] = useState(true);
  const [kwText, setKwText] = useState("");
  const [country, setCountry] = useState("us");
  const [lang, setLang] = useState("en");
  const [busy, setBusy] = useState<null | "add" | "check">(null);
  const [progress, setProgress] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("position");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  // Unlike Striking Distance, every tracked keyword carries its own country, so weights are
  // requested per market. Getting this wrong would attach US volumes to keywords tracked in
  // another country — a mistake that looks like data rather than like a bug.
  const weightTargets = useMemo(
    () => rows.map(r => ({ keyword: r.keyword, country: r.country || "us" })),
    [rows],
  );
  const weights = useKeywordWeights(weightTargets, {
    enabled: !guest,
    onError: code => (code === "cap_exceeded" ? t("kwCapExceeded") : t("kwLoadFailed")),
  });
  const kwWeight = (r: KwRow) => weights.get(r.keyword, r.country || "us");

  const load = useCallback(async () => {
    if (!siteDbId) return;
    try {
      const r = await fetch(withShare(`/api/rank/keywords?siteId=${encodeURIComponent(siteDbId)}&gsc=1`));
      const d = await r.json();
      if (Array.isArray(d.keywords)) {
        setRows(d.keywords);
        setProvider(d.provider ?? null);
        setHasKey(!!d.hasSerpKey);
      }
    } catch { /* ignore */ }
  }, [siteDbId]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  // Run /api/rank/check in a loop until nothing remains (20 keywords per call).
  const runChecks = useCallback(async (body: Record<string, unknown>) => {
    for (let i = 0; i < 30; i++) {
      const r = await fetch("/api/rank/check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, ...body }),
      });
      const d = await r.json();
      if (!r.ok) { setProgress(d?.error === "no_serp_key" ? t("rankNoKey") : (d?.error || "error")); return; }
      await load();
      if (!d.remaining) break;
      setProgress(`${t("rankChecking")} ${d.remaining}…`);
    }
    setProgress("");
  }, [siteDbId, load, t]);

  const addKeywords = async () => {
    const list = kwText.split("\n").map(s => s.trim()).filter(Boolean);
    if (!list.length || busy) return;
    setBusy("add");
    try {
      const r = await fetch("/api/rank/keywords", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, keywords: list, country, lang }),
      });
      if (r.ok) {
        setKwText("");
        await load();
        await runChecks({}); // check new (never-checked) keywords right away
      }
    } finally { setBusy(null); }
  };

  const checkAll = async () => {
    if (busy) return;
    setBusy("check");
    setProgress(t("rankChecking"));
    try { await runChecks({ force: true }); } finally { setBusy(null); setProgress(""); }
  };

  const checkOne = async (id: string) => {
    if (busy) return;
    setBusy("check");
    try { await runChecks({ keywordId: id }); } finally { setBusy(null); }
  };

  const del = async (id: string) => {
    if (!confirm(t("rankDeleteConfirm"))) return;
    await fetch("/api/rank/keywords", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteId: siteDbId, ids: [id] }),
    });
    setRows(rs => rs.filter(r => r.id !== id));
  };

  // Nullable-number compare — rows with no data for the sorted column always sink to the
  // bottom, regardless of asc/desc, so "not found yet" keywords don't clutter the top.
  const cmpNullable = (a: number | null, b: number | null, dir: 1 | -1) => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * dir;
  };

  const visible = useMemo(() => {
    let list = rows;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(r => r.keyword.toLowerCase().includes(q));
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case "keyword":
          return a.keyword.localeCompare(b.keyword) * dir;
        case "position":
          return cmpNullable(a.position, b.position, dir);
        case "best":
          return cmpNullable(a.bestPosition, b.bestPosition, dir);
        case "gsc":
          return cmpNullable(a.gsc?.pos ?? null, b.gsc?.pos ?? null, dir);
        case "trend": {
          const av = a.position !== null && a.prevPosition !== null ? a.prevPosition - a.position : null;
          const bv = b.position !== null && b.prevPosition !== null ? b.prevPosition - b.position : null;
          return cmpNullable(av, bv, dir);
        }
        case "checked":
          return cmpNullable(
            a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : null,
            b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : null,
            dir,
          );
        case "volume":
          // Descending by default reads better for volume, so the direction is inverted
          // against the shared asc/desc flag rather than making the user click twice.
          return cmpNullable(
            weights.get(a.keyword, a.country)?.volume ?? null,
            weights.get(b.keyword, b.country)?.volume ?? null,
            (dir * -1) as 1 | -1,
          );
        default:
          return 0;
      }
    });
  }, [rows, search, sortKey, sortDir, weights]);

  // Summary stats (dashboard-style)
  const stats = useMemo(() => {
    const found = rows.filter(r => r.position !== null) as (KwRow & { position: number })[];
    const avg = found.length ? found.reduce((s, r) => s + r.position, 0) / found.length : 0;
    return {
      total: rows.length,
      top3: found.filter(r => r.position <= 3).length,
      top10: found.filter(r => r.position <= 10).length,
      avg: avg ? avg.toFixed(1) : "—",
      up: rows.filter(r => r.position !== null && r.prevPosition !== null && r.position < r.prevPosition).length,
      down: rows.filter(r => r.position !== null && r.prevPosition !== null && r.position > r.prevPosition).length,
    };
  }, [rows]);

  const pathOf = (url: string | null) => {
    if (!url) return "";
    try { const u = new URL(url); return u.pathname === "/" ? "/" : u.pathname; } catch { return url; }
  };

  const inputStyle: React.CSSProperties = {
    padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--color-border)",
    background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none",
  };

  const primaryBtn: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "8px",
    border: "1.5px solid rgba(59,130,246,0.5)", background: "rgba(59,130,246,0.08)", color: "#3B82F6",
    fontSize: "12px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
  };
  const ghostBtn: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "8px",
    border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)",
    fontSize: "12px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
  };

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: "24px", width: "100%", boxSizing: "border-box" }}>

      {/* ── Header: title + actions ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px", display: "flex", alignItems: "center", gap: "8px" }}>
            <MapPin size={17} color="#3B82F6" /> {t("rankTitle")}
          </h2>
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("rankSubtitle")}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {provider && (
            <a
              href="/settings?tab=seo-tools"
              title={t("rankProviderSwitchHint")}
              style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", padding: "6px 12px", borderRadius: "999px", border: "1px solid var(--color-border)", background: "var(--color-card)", textDecoration: "none", cursor: "pointer" }}
              onMouseOver={e => { e.currentTarget.style.borderColor = "#3B82F6"; e.currentTarget.style.color = "#3B82F6"; }}
              onMouseOut={e => { e.currentTarget.style.borderColor = "var(--color-border)"; e.currentTarget.style.color = "var(--color-text-secondary)"; }}
            >
              <Globe size={11} /> {provider}
            </a>
          )}
          {!guest && <button onClick={checkAll} disabled={!!busy || !rows.length}
            style={{ ...(rows.length ? primaryBtn : ghostBtn), cursor: busy || !rows.length ? "not-allowed" : "pointer", opacity: busy || !rows.length ? 0.6 : 1 }}>
            <RefreshCw size={13} style={{ animation: busy === "check" ? "spin 1.2s linear infinite" : "none" }} />
            {busy === "check" ? (progress || t("rankChecking")) : t("rankCheckAll")}
          </button>}
        </div>
      </div>

      {/* ── No key warning ── */}
      {!loading && !hasKey && !guest && (
        <div style={{ padding: "12px 16px", borderRadius: "10px", border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.08)", color: "#F59E0B", fontSize: "13px" }}>
          ⚠ {t("rankNoKey")}{" "}
          <a href="/settings?tab=api-keys" style={{ color: "#F59E0B", fontWeight: 700, textDecoration: "underline" }}>Settings → API Keys</a>
        </div>
      )}

      {/* ── Summary stats ── */}
      {rows.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "36px", flexWrap: "wrap" }}>
          {[
            { val: String(stats.total), label: t("rankStatKeywords"), color: "var(--color-text-primary)" },
            { val: String(stats.top3),  label: "Top 3",  color: "#10B981" },
            { val: String(stats.top10), label: "Top 10", color: "#3B82F6" },
            { val: stats.avg,           label: t("rankStatAvg"), color: "#F59E0B" },
            { val: `▲${stats.up} ▼${stats.down}`, label: t("rankStatMoves"), color: "var(--color-text-primary)" },
          ].map(({ val, label }, i) => (
            <div key={i}>
              <div style={{ fontSize: "22px", fontWeight: 700, color: "var(--color-text-primary)", lineHeight: 1.2 }}>{val}</div>
              <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Add keywords card (owners only) ── */}
      {!guest && <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", padding: "16px" }}>
        <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "10px" }}>
          {t("rankAddBtn")}
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "stretch", flexWrap: "wrap" }}>
          <textarea
            value={kwText}
            onChange={e => setKwText(e.target.value)}
            placeholder={t("rankAddPlaceholder")}
            rows={2}
            style={{ ...inputStyle, flex: "1 1 340px", minHeight: "40px", maxHeight: "120px", resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }}
          />
          <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "10px", color: "var(--color-text-secondary)", paddingLeft: "2px" }}>{t("rankCountryLabel")}</span>
              <select value={country} onChange={e => setCountry(e.target.value)} style={{ ...inputStyle, cursor: "pointer", height: "40px", maxWidth: "170px" }} title="Search location (Google gl param)">
                {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              <span style={{ fontSize: "10px", color: "var(--color-text-secondary)", paddingLeft: "2px" }}>{t("rankLangLabel")}</span>
              <select value={lang} onChange={e => setLang(e.target.value)} style={{ ...inputStyle, cursor: "pointer", height: "40px", maxWidth: "150px" }} title="Search language (Google hl param)">
                {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </div>
            <button onClick={addKeywords} disabled={!kwText.trim() || !!busy}
              style={{ ...primaryBtn, height: "40px", opacity: kwText.trim() && !busy ? 1 : 0.5, cursor: kwText.trim() && !busy ? "pointer" : "not-allowed" }}>
              <Plus size={13} /> {busy === "add" ? "…" : t("rankAddBtn")}
            </button>
          </div>
        </div>
        <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "8px", lineHeight: 1.5 }}>
          💡 {t("rankHintAdd")}
        </div>
      </div>}

      {/* ── Search ── */}
      {rows.length > 8 && (
        <div style={{ position: "relative", maxWidth: "280px" }}>
          <Search size={13} style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "var(--color-text-secondary)" }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
            style={{ ...inputStyle, width: "100%", paddingLeft: "30px", boxSizing: "border-box" }} />
        </div>
      )}

      {/* Weights sit above the table, not inside it: the button spends money and belongs
          where it can be read before it is pressed. Hidden for guests, whose share-link
          session cannot reach the owner-scoped metrics endpoints. */}
      {!guest && rows.length > 0 && <KeywordWeightsBar w={weights} compact />}

      {/* ── Table / empty state ── */}
      {loading ? (
        <div style={{ padding: "40px", textAlign: "center", color: "var(--color-text-secondary)", fontSize: "13px" }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: "56px 24px", textAlign: "center", border: "1px dashed var(--color-border)", borderRadius: "12px", background: "var(--color-card)" }}>
          <div style={{ width: "44px", height: "44px", borderRadius: "12px", background: "rgba(59,130,246,0.1)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
            <MapPin size={22} color="#3B82F6" />
          </div>
          <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "6px" }}>{t("rankNoKeywords")}</div>
          <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", maxWidth: "440px", margin: "0 auto", lineHeight: 1.55 }}>{t("rankNoKeywordsDesc")}</div>
        </div>
      ) : (
        <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-bg)" }}>
                <SortableTh label={t("rankColKeyword")} align="left" active={sortKey === "keyword"} dir={sortDir} onClick={() => toggleSort("keyword")} />
                <SortableTh label={t("rankColPos")} active={sortKey === "position"} dir={sortDir} onClick={() => toggleSort("position")} />
                <SortableTh label={t("rankColBest")} active={sortKey === "best"} dir={sortDir} onClick={() => toggleSort("best")} />
                <SortableTh label={t("rankColGsc")} active={sortKey === "gsc"} dir={sortDir} onClick={() => toggleSort("gsc")} />
                <SortableTh label={t("kwColVolume")} active={sortKey === "volume"} dir={sortDir} onClick={() => toggleSort("volume")} />
                <th style={{ textAlign: "center", padding: "10px 12px", color: "var(--color-text-secondary)", fontWeight: 600, fontSize: "11px", letterSpacing: "0.05em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{t("kwColKd")}</th>
                <th style={{ textAlign: "left", padding: "10px 12px", color: "var(--color-text-secondary)", fontWeight: 600, fontSize: "11px", letterSpacing: "0.05em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{t("rankColUrl")}</th>
                <SortableTh label={t("rankColTrend")} align="left" active={sortKey === "trend"} dir={sortDir} onClick={() => toggleSort("trend")} />
                <SortableTh label={t("rankColChecked")} align="left" active={sortKey === "checked"} dir={sortDir} onClick={() => toggleSort("checked")} />
                <th style={{ padding: "10px 12px" }}></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <Fragment key={r.id}>
                  <tr
                    onClick={() => setExpanded(e => e === r.id ? null : r.id)}
                    style={{ borderBottom: "1px solid var(--color-border)", background: expanded === r.id ? "rgba(59,130,246,0.04)" : i % 2 === 1 ? "rgba(128,128,128,0.03)" : "transparent", cursor: "pointer" }}>
                    <td style={{ padding: "10px 12px", maxWidth: "280px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ color: "var(--color-text-secondary)", display: "flex", flexShrink: 0 }}>
                          {expanded === r.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        </span>
                        <span style={{ fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...blurStyle }} title={r.keyword}>
                          {r.keyword}
                        </span>
                        <span style={{ fontSize: "10px", fontWeight: 600, color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", borderRadius: "4px", padding: "1px 5px", flexShrink: 0 }}>
                          {r.country.toUpperCase()}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: "10px 12px", whiteSpace: "nowrap", textAlign: "center" }}>
                      {r.lastError ? (
                        <span title={r.lastError} style={{ color: "#EF4444", fontSize: "12px" }}>error</span>
                      ) : r.lastCheckedAt === null ? (
                        <span style={{ color: "var(--color-text-secondary)" }}>…</span>
                      ) : r.position === null ? (
                        <span style={{ color: "var(--color-text-secondary)", fontSize: "11px", padding: "2px 8px", borderRadius: "20px", background: "rgba(128,128,128,0.08)" }}>{t("rankNotFound")}</span>
                      ) : (
                        <>
                          <span style={{ fontWeight: 700, fontSize: "15px", color: r.position <= 3 ? "#10B981" : r.position <= 10 ? "#3B82F6" : "var(--color-text-primary)" }}>{r.position}</span>
                          <PosDelta position={r.position} prev={r.prevPosition} />
                        </>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px", color: "var(--color-text-secondary)", textAlign: "center" }}>{r.bestPosition ?? "—"}</td>
                    <td style={{ padding: "10px 12px", whiteSpace: "nowrap", textAlign: "center" }}>
                      {r.gsc ? (
                        <span title={`${r.gsc.clicks} clicks / ${r.gsc.impressions} impressions (7d)`} style={{ color: "#F59E0B", fontWeight: 600 }}>{r.gsc.pos}</span>
                      ) : <span style={{ color: "var(--color-text-secondary)" }}>—</span>}
                    </td>
                    {/* Weights. Em dash, never zero: "not loaded" and "no demand" are
                        different answers and must not look alike. */}
                    <td style={{ padding: "10px 12px", textAlign: "center", fontWeight: 600, color: kwWeight(r)?.volume != null ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}
                      title={kwWeight(r)?.cpc != null ? `CPC ${kwWeight(r)!.cpc}` : undefined}>
                      {kwWeight(r)?.volume != null ? kwWeight(r)!.volume!.toLocaleString() : "—"}
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "center", fontWeight: 700, color: kwWeight(r)?.difficulty != null ? kdColor(kwWeight(r)!.difficulty!) : "var(--color-text-secondary)" }}>
                      {kwWeight(r)?.difficulty ?? "—"}
                    </td>
                    <td style={{ padding: "10px 12px", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.url ? (
                        <a href={r.url} target="_blank" rel="noreferrer" title={r.url} onClick={e => e.stopPropagation()}
                          style={{ color: "#3B82F6", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px", ...blurStyle }}>
                          {pathOf(r.url)} <ExternalLink size={10} style={{ opacity: 0.5 }} />
                        </a>
                      ) : <span style={{ color: "var(--color-text-secondary)" }}>—</span>}
                    </td>
                    <td style={{ padding: "10px 12px" }}><PosSparkline history={r.history} /></td>
                    <td style={{ padding: "10px 12px", color: "var(--color-text-secondary)", fontSize: "11px", whiteSpace: "nowrap" }}>
                      {r.lastCheckedAt ? new Date(r.lastCheckedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                    </td>
                    <td style={{ padding: "10px 12px", whiteSpace: "nowrap", textAlign: "right" }} onClick={e => e.stopPropagation()}>
                      {!guest && <><button onClick={() => checkOne(r.id)} disabled={!!busy} title={t("rankCheckAll")}
                        style={{ background: "none", border: "none", cursor: busy ? "not-allowed" : "pointer", color: "var(--color-text-secondary)", padding: "4px" }}>
                        <RefreshCw size={13} />
                      </button>
                      <button onClick={() => del(r.id)} title={t("rankDeleteConfirm")}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#EF4444", padding: "4px", opacity: 0.7 }}>
                        <Trash2 size={13} />
                      </button></>}
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr>
                      <td colSpan={10} style={{ padding: 0, borderBottom: "1px solid var(--color-border)", background: "rgba(59,130,246,0.02)" }}>
                        <HistoryChart keywordId={r.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
