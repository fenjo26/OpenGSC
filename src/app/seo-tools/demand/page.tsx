"use client";

// Demand — keyword discovery crossed with your own Search Console history.
//
// Every other screen in this app starts from queries you already appear for. This one starts
// from the market: a seed goes to DataForSEO, comes back as the terms people actually search,
// and each of them is then answered by GSC in one of three ways —
//
//   • you rank in the top 30 → the page exists and is findable, improve it
//   • you appear but far below → you have something, it is not treated as the answer
//   • nothing at all → write it
//
// Ahrefs knows the first half of every row. Search Console knows the second. Neither knows both,
// which is the entire reason this screen exists.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Compass, Loader2, Download, ExternalLink, Search } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { COUNTRIES, LANGUAGES } from "@/lib/seo/regions";
import { formatUsd } from "@/lib/seo/metricsClient";
import { getDataForSeoKey } from "@/lib/seo/keys";
import DemandDomain from "@/components/DemandDomain";
import type { DemandMode, KeywordIntent, MonthlyPoint } from "@/lib/seo/demand";

type Verdict = "reach" | "wrong_page" | "none";

interface Row {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: number | null;
  intent: KeywordIntent;
  trend: MonthlyPoint[];
  ourPosition: number | null;
  ourUrl: string | null;
  ourImpressions: number;
  verdict: Verdict;
}

interface SiteOption { id: string; url: string }

const VERDICT_COLOR: Record<Verdict, string> = {
  reach: "var(--color-success)",
  wrong_page: "var(--color-warning)",
  none: "var(--color-text-tertiary)",
};

const INTENT_COLOR: Record<KeywordIntent, string> = {
  transactional: "var(--color-accent-green)",
  commercial: "var(--color-accent-blue)",
  informational: "var(--color-text-secondary)",
  navigational: "var(--color-accent-purple)",
  unknown: "var(--color-text-tertiary)",
};

const fmt = (n: number | null) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * The four discovery modes, spelled out rather than derived from the mode union. `t()` takes a
 * literal dictionary key, and a template-built key would compile only by casting — which is
 * exactly how a missing translation stops being a type error and starts being a visible `dmXxx`
 * in the interface.
 */
const MODES = [
  { id: "auto", label: "dmModeAuto", hint: "dmModeAutoHint" },
  { id: "related", label: "dmModeRelated", hint: "dmModeRelatedHint" },
  { id: "suggestions", label: "dmModeSuggestions", hint: "dmModeSuggestionsHint" },
  { id: "ideas", label: "dmModeIdeas", hint: "dmModeIdeasHint" },
] as const satisfies readonly { id: DemandMode; label: string; hint: string }[];

const INTENT_LABEL = {
  informational: "dmIntentInformational",
  commercial: "dmIntentCommercial",
  transactional: "dmIntentTransactional",
  navigational: "dmIntentNavigational",
  unknown: "dmIntentUnknown",
} as const satisfies Record<KeywordIntent, string>;

/**
 * Twelve months of volume as a 40×14 sparkline. Deliberately unlabelled: at this size the only
 * readable signal is the shape, and the shape is the whole question — is this market growing,
 * flat, seasonal, or gone.
 */
function Spark({ points }: { points: MonthlyPoint[] }) {
  if (points.length < 3) return <span style={{ color: "var(--color-text-tertiary)" }}>—</span>;
  const vals = points.map((p) => p.volume);
  const max = Math.max(...vals, 1);
  const step = 40 / (vals.length - 1);
  const d = vals.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(14 - (v / max) * 13).toFixed(1)}`).join(" ");
  // Falling markets are the ones worth noticing, so the colour carries the trend, not the level.
  const falling = vals[vals.length - 1] < vals[0] * 0.8;
  return (
    <svg width="40" height="14" style={{ display: "block" }}>
      <path d={d} fill="none" strokeWidth="1.5"
        stroke={falling ? "var(--color-danger)" : "var(--color-accent-blue)"} />
    </svg>
  );
}

/**
 * Growth as last-3-months vs previous-3-months average. Chosen over first-vs-last because a single
 * outlier month (a press hit, a season) would dominate first-vs-last and present a one-off spike as
 * a sustained trend. Comparing two 3-month windows smooths that: only a market that actually moved
 * shows up as growing. Returns null when there aren't enough points to compute both windows.
 */
function growthPct(points: MonthlyPoint[]): number | null {
  if (points.length < 6) return null;
  const v = points.map((p) => p.volume);
  const recent = v.slice(-3);
  const prev = v.slice(-6, -3);
  const avg = (a: number[]) => (a.reduce((s, n) => s + n, 0) / a.length) || 0;
  const r = avg(recent);
  const p = avg(prev);
  if (p === 0) return r > 0 ? Infinity : 0;
  return ((r - p) / p) * 100;
}

export default function DemandPage() {
  const { t } = useLanguage();

  // Two ways to ask the same question — from the market inwards, or from a domain outwards.
  // They share the tab because the answer lands in the same place: a keyword you should act on.
  const [view, setView] = useState<"keyword" | "domain">("keyword");

  const [sites, setSites] = useState<SiteOption[]>([]);
  const [siteId, setSiteId] = useState("");
  const [country, setCountry] = useState("us");
  const [language, setLanguage] = useState("en");
  const [seed, setSeed] = useState("");
  const [mode, setMode] = useState<DemandMode>("auto");
  const [limit, setLimit] = useState(150);
  const [clickstream, setClickstream] = useState(false);

  const [rows, setRows] = useState<Row[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [priceUsd, setPriceUsd] = useState(0);
  const [spentUsd, setSpentUsd] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | "all">("all");
  const [search, setSearch] = useState("");
  // Default is volume — the existing behaviour, unchanged unless the user opts into growth. "growth"
  // surfaces rising markets that volume-sort would bury (a +300% niche below a stagnant high-volume one).
  const [sortBy, setSortBy] = useState<"volume" | "growth">("volume");
  const [risingOnly, setRisingOnly] = useState(false);

  useEffect(() => {
    setHasKey(getDataForSeoKey().length > 4);
    setCountry(localStorage.getItem("seoMetricsCountry") || "us");
    setLanguage(localStorage.getItem("seoDemandLang") || "en");
    fetch("/api/gsc/sites")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list: SiteOption[] = (d?.sites ?? []).map((x: any) => ({ id: x.id, url: x.url }));
        setSites(list);
        if (list.length) setSiteId((prev) => prev || list[0].id);
      })
      .catch(() => {});
  }, []);

  const call = useCallback(async (wantFetch: boolean) => {
    if (!seed.trim()) return;
    const body: Record<string, unknown> = {
      seed, siteId, country, language, mode, limit, clickstream, fetch: wantFetch,
    };
    if (wantFetch) {
      body.apiKey = getDataForSeoKey();
      body.cap = Number(localStorage.getItem("seoDemandCap") || 0) || 0;
    }
    const res = await fetch("/api/demand/keywords", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));

    if (Array.isArray(d.rows)) setRows(d.rows);
    if (typeof d.priceUsd === "number") setPriceUsd(d.priceUsd);
    setSource(d.source ?? null);
    setCachedAt(d.cachedAt ?? null);
    setSpentUsd(typeof d.spentUsd === "number" ? d.spentUsd : 0);

    if (!res.ok || d.error) {
      setNotice(
        d.error === "cap_exceeded" ? t("dmCapExceeded")
        : d.error === "no_key" ? t("dmNoKey")
        : t("dmFailed"),
      );
      return;
    }
    setNotice("");
  }, [seed, siteId, country, language, mode, limit, clickstream, t]);

  // Free cache read whenever the parameters change — a search already paid for should never be
  // bought twice just because the user came back to the tab.
  useEffect(() => {
    if (!seed.trim()) return;
    const id = setTimeout(() => { call(false).catch(() => {}); }, 400);
    return () => clearTimeout(id);
  }, [seed, siteId, country, language, mode, limit, clickstream, call]);

  async function run() {
    if (busy || !hasKey) return;
    setBusy(true);
    await call(true).catch(() => {});
    setBusy(false);
  }

  const counts = useMemo(() => {
    const c = { reach: 0, wrong_page: 0, none: 0 };
    for (const r of rows) c[r.verdict]++;
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const order: Record<Verdict, number> = { reach: 0, wrong_page: 1, none: 2 };
    return rows
      .filter((r) => verdict === "all" || r.verdict === verdict)
      .filter((r) => !search || r.keyword.includes(search.toLowerCase()))
      // "rising" = positive growth over the trailing 3-vs-3 window. Flat and falling markets stay
      // when the filter is off; turning it on is how a growing niche stops being buried under the
      // high-volume-but-stagnant ones that volume-sort always ranks first.
      .filter((r) => !risingOnly || (growthPct(r.trend) ?? -Infinity) > 0)
      .sort((a, b) => {
        // Verdict (reach > wrong_page > none) stays the primary key either way: it is the action
        // signal, and growth is only meaningful within "what should I do about this". Sorting purely
        // by growth would float a rising niche you have no page for above one you can improve today.
        const d = order[a.verdict] - order[b.verdict];
        if (d !== 0) return d;
        if (sortBy === "growth") {
          // Infinity (prev window was zero, recent is positive) sorts highest; null/unknown last.
          const ga = growthPct(a.trend);
          const gb = growthPct(b.trend);
          return (gb ?? -Infinity) - (ga ?? -Infinity);
        }
        return (b.volume ?? 0) - (a.volume ?? 0);
      })
      .slice(0, 500);
  }, [rows, verdict, search, sortBy, risingOnly]);

  function exportCsv() {
    const head = ["keyword", "volume", "kd", "cpc", "intent", "our_position", "our_url", "verdict"];
    const body = visible.map((r) => [
      r.keyword, r.volume ?? "", r.difficulty ?? "", r.cpc ?? "", r.intent,
      r.ourPosition ?? "", r.ourUrl ?? "", r.verdict,
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const blob = new Blob([[head.join(","), ...body].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `demand-${seed.replace(/\s+/g, "-")}-${country}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const cell: React.CSSProperties = { padding: "9px 12px", fontSize: "13px" };
  const th: React.CSSProperties = {
    ...cell, fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)",
    textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left",
  };

  return (
    // Not `.main-content`: the SEO Tools layout already supplies the page padding and max
    // width, and stacking the two put the content in a narrower, doubly-inset column.
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <Compass size={22} style={{ color: "var(--color-accent-blue)" }} />
        <h1 className="title" style={{ margin: 0 }}>{t("menuDemand")}</h1>
      </div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "4px" }}>
        {view === "keyword" ? t("dmSub") : t("dmDomainSub")}
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <button className={view === "keyword" ? "pill active" : "pill"} onClick={() => setView("keyword")} style={{ cursor: "pointer" }}>
          {t("dmViewKeyword")}
        </button>
        <button className={view === "domain" ? "pill active" : "pill"} onClick={() => setView("domain")} style={{ cursor: "pointer" }}>
          {t("dmViewDomain")}
        </button>
      </div>

      {view === "domain" ? <DemandDomain sites={sites} /> : <>

      <div className="panel" style={{ display: "flex", alignItems: "flex-end", gap: "10px", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px" }}>
          <span className="tool-field-label">{t("dmSeed")}</span>
          <input className="tool-input" value={seed} onChange={(e) => setSeed(e.target.value)}
            placeholder={t("dmSeedPh")} onKeyDown={(e) => { if (e.key === "Enter") run(); }} />
        </div>
        <div>
          <span className="tool-field-label">{t("importSite")}</span>
          <select className="tool-input inline" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">{t("dmNoSite")}</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>{s.url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "")}</option>
            ))}
          </select>
        </div>
        <div>
          <span className="tool-field-label">{t("importCountry")}</span>
          <select className="tool-input inline" value={country}
            onChange={(e) => { setCountry(e.target.value); localStorage.setItem("seoMetricsCountry", e.target.value); }}>
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <span className="tool-field-label">{t("dmLanguage")}</span>
          <select className="tool-input inline" value={language}
            onChange={(e) => { setLanguage(e.target.value); localStorage.setItem("seoDemandLang", e.target.value); }}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>
        <button className="metric-action" onClick={run} disabled={busy || !hasKey || !seed.trim()}
          title={!hasKey ? t("dmNoKey") : undefined}>
          {busy ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
          {t("dmRun")}
        </button>
        {hasKey && <span className="metric-cost">≈ {formatUsd(priceUsd)}</span>}
        {notice && <span style={{ fontSize: "12px", color: "var(--color-danger)" }}>{notice}</span>}
      </div>

      <div className="panel" style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <span className="tool-section-label" style={{ marginBottom: 0 }}>{t("dmMode")}</span>
        {MODES.map(({ id, label, hint }) => (
          <button key={id} className={mode === id ? "pill active" : "pill"} onClick={() => setMode(id)}
            style={{ cursor: "pointer" }} title={t(hint)}>
            {t(label)}
          </button>
        ))}
        <select className="tool-input inline" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          {[50, 150, 300, 500, 1000].map((n) => <option key={n} value={n}>{n} {t("gapKeywords")}</option>)}
        </select>
        {/* The checkbox states its own price because the flag is invisible in the result: it
            changes the volume numbers slightly and the bill by 100%. */}
        <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)", cursor: "pointer" }}
          title={t("dmClickstreamHint")}>
          <input type="checkbox" checked={clickstream} onChange={(e) => setClickstream(e.target.checked)} />
          {t("dmClickstream")}
        </label>
        {source && (
          <span style={{ marginLeft: "auto", fontSize: "12px", color: "var(--color-text-tertiary)" }}>
            {cachedAt ? t("dmFromCache") : t("dmSourceWas").replace("{source}", source)}
            {spentUsd > 0 && ` · ${formatUsd(spentUsd)}`}
          </span>
        )}
      </div>

      {rows.length > 0 && (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          {([
            ["all", `${t("gapAll")} (${rows.length})`],
            ["reach", `${t("dmReach")} (${counts.reach})`],
            ["wrong_page", `${t("dmWrongPage")} (${counts.wrong_page})`],
            ["none", `${t("dmNoContent")} (${counts.none})`],
          ] as const).map(([k, label]) => (
            <button key={k} className={verdict === k ? "pill active" : "pill"}
              onClick={() => setVerdict(k as Verdict | "all")} style={{ cursor: "pointer" }}>{label}</button>
          ))}
          {/* Sort + rising filter turn the trend sparkline from decoration into a selection criterion.
              Without these, a growing niche is ordered below a stagnant high-volume one every time. */}
          <select className="tool-input inline" value={sortBy} onChange={(e) => setSortBy(e.target.value as "volume" | "growth")}
            style={{ marginLeft: "auto" }}>
            <option value="volume">{t("dmSortVolume")}</option>
            <option value="growth">{t("dmSortGrowth")}</option>
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)", cursor: "pointer" }}
            title={t("dmRisingOnlyHint")}>
            <input type="checkbox" checked={risingOnly} onChange={(e) => setRisingOnly(e.target.checked)} />
            {t("dmRisingOnly")}
          </label>
          <input className="tool-input inline" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={t("sdkSearch")} style={{ minWidth: "180px" }} />
          <button className="metric-action" onClick={exportCsv}><Download size={13} />CSV</button>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="panel" style={{ padding: "40px", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          {hasKey ? t("dmEmpty") : t("dmEmptyNoKey")}
        </div>
      ) : (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <table className="privacy-sensitive" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
                <th style={th}>{t("sdkColQuery")}</th>
                <th style={{ ...th, textAlign: "right", width: "80px" }}>{t("kwColVolume")}</th>
                <th style={{ ...th, width: "56px" }}>{t("dmColTrend")}</th>
                <th style={{ ...th, textAlign: "center", width: "56px" }}>{t("kwColKd")}</th>
                <th style={{ ...th, textAlign: "right", width: "70px" }}>{t("dmColCpc")}</th>
                <th style={{ ...th, width: "110px" }}>{t("dmColIntent")}</th>
                <th style={{ ...th, textAlign: "center", width: "80px" }}>{t("gapOurPos")}</th>
                <th style={{ ...th, width: "110px" }}>{t("gapAction")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.keyword} style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <td style={{ ...cell, fontWeight: 600 }}>{r.keyword}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{fmt(r.volume)}</td>
                  <td style={cell}><Spark points={r.trend} /></td>
                  <td style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)" }}>{r.difficulty ?? "—"}</td>
                  <td style={{ ...cell, textAlign: "right", color: "var(--color-text-secondary)" }}>
                    {r.cpc == null ? "—" : `$${r.cpc.toFixed(2)}`}
                  </td>
                  <td style={{ ...cell, fontSize: "11px", fontWeight: 600, color: INTENT_COLOR[r.intent] }}>
                    {r.intent === "unknown" ? "—" : t(INTENT_LABEL[r.intent])}
                  </td>
                  {/* An em dash here means "never shown for this query" — GSC measured, and the
                      answer was nothing. It does not mean the number is missing. */}
                  <td style={{ ...cell, textAlign: "center", fontWeight: 700, color: VERDICT_COLOR[r.verdict] }}>
                    {r.ourUrl ? (
                      <a href={r.ourUrl} target="_blank" rel="noreferrer" title={r.ourUrl}
                        style={{ color: VERDICT_COLOR[r.verdict], textDecoration: "none" }}>
                        {r.ourPosition ?? "—"} <ExternalLink size={9} style={{ opacity: 0.5 }} />
                      </a>
                    ) : (r.ourPosition ?? "—")}
                  </td>
                  <td style={{ ...cell, fontSize: "11px", color: VERDICT_COLOR[r.verdict], fontWeight: 600 }}>
                    {r.verdict === "reach" ? t("dmActReach")
                      : r.verdict === "wrong_page" ? t("dmActWrongPage")
                      : t("dmActNone")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      </>}
    </div>
  );
}
