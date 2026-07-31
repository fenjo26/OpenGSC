"use client";

// Demand → "by domain". The mirror image of the keyword mode: instead of asking what a market
// searches for, it asks what one domain already owns.
//
// It lives next to the Competitors screen without replacing it, and the difference is the point.
// Competitors needs one of your sites and answers "what do they have that I do not". This works
// on any domain, including one you are considering buying or a client you have not onboarded —
// passing a site is optional and only adds a comparison column.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Download, ExternalLink, Search } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { COUNTRIES, LANGUAGES } from "@/lib/seo/regions";
import { formatUsd } from "@/lib/seo/metricsClient";
import { getDataForSeoKey } from "@/lib/seo/keys";

interface Summary {
  domain: string;
  organicTraffic: number | null;
  organicKeywords: number | null;
  positions: { top3: number; top10: number; top20: number; top100: number };
}

interface DomainKw {
  keyword: string;
  position: number | null;
  url: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  traffic: number | null;
  ourPosition: number | null;
  ourUrl: string | null;
  verdict: "reach" | "wrong_page" | "none" | null;
}

interface DomainPage { url: string; keywords: number | null; traffic: number | null }
interface SiteOption { id: string; url: string }

const fmt = (n: number | null) =>
  n == null ? "—" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

const VERDICT_COLOR = {
  reach: "var(--color-success)",
  wrong_page: "var(--color-warning)",
  none: "var(--color-text-tertiary)",
} as const;

/**
 * Keyword count by position band as one stacked bar.
 *
 * Two domains with the same keyword total can be completely different businesses — one holding
 * a hundred first-page rankings, the other a thousand entries on page six. The total alone hides
 * exactly that, and the shape is readable at a glance where four numbers are not.
 */
function PositionBar({ p }: { p: Summary["positions"] }) {
  const total = p.top3 + p.top10 + p.top20 + p.top100;
  if (!total) return null;
  const bands = [
    { n: p.top3, color: "var(--color-accent-green)", key: "dmPos3" },
    { n: p.top10, color: "var(--color-accent-blue)", key: "dmPos10" },
    { n: p.top20, color: "var(--color-accent-orange)", key: "dmPos20" },
    { n: p.top100, color: "var(--color-text-tertiary)", key: "dmPos100" },
  ] as const;
  return (
    <div style={{ display: "flex", height: "8px", borderRadius: "var(--radius-pill)", overflow: "hidden", width: "100%" }}>
      {bands.map((b) => b.n > 0 && (
        <div key={b.key} style={{ width: `${(b.n / total) * 100}%`, background: b.color }} title={`${b.n}`} />
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div className="metric-value" style={{ fontSize: "24px" }}>{value}</div>
    </div>
  );
}

export default function DemandDomain({ sites }: { sites: SiteOption[] }) {
  const { t } = useLanguage();

  const [domain, setDomain] = useState("");
  const [siteId, setSiteId] = useState("");
  const [country, setCountry] = useState("us");
  const [language, setLanguage] = useState("en");

  const [summary, setSummary] = useState<Summary | null>(null);
  const [keywords, setKeywords] = useState<DomainKw[]>([]);
  const [pages, setPages] = useState<DomainPage[]>([]);
  const [known, setKnown] = useState<{ dr: number | null; refDomains: number | null } | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [priceUsd, setPriceUsd] = useState(0);
  const [spentUsd, setSpentUsd] = useState(0);
  const [labsOnly, setLabsOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [tab, setTab] = useState<"keywords" | "pages">("keywords");
  const [search, setSearch] = useState("");

  useEffect(() => {
    setHasKey(getDataForSeoKey().length > 4);
    setCountry(localStorage.getItem("seoMetricsCountry") || "us");
    setLanguage(localStorage.getItem("seoDemandLang") || "en");
  }, []);

  const call = useCallback(async (wantFetch: boolean) => {
    if (!domain.trim()) return;
    const body: Record<string, unknown> = { domain, siteId, country, language, fetch: wantFetch };
    if (wantFetch) {
      body.apiKey = getDataForSeoKey();
      body.cap = Number(localStorage.getItem("seoDemandCap") || 0) || 0;
    }
    const res = await fetch("/api/demand/domain", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));

    setSummary(d.summary ?? null);
    setKeywords(Array.isArray(d.keywords) ? d.keywords : []);
    setPages(Array.isArray(d.pages) ? d.pages : []);
    setKnown(d.known ?? null);
    setCachedAt(d.cachedAt ?? null);
    setLabsOnly(!!d.labsOnly);
    if (typeof d.priceUsd === "number") setPriceUsd(d.priceUsd);
    setSpentUsd(typeof d.spentUsd === "number" ? d.spentUsd : 0);

    if (!res.ok || d.error) {
      setNotice(
        d.error === "cap_exceeded" ? t("dmCapExceeded")
        : d.error === "no_key" ? t("dmNoKey")
        : d.error === "labs_only" ? t("dmLabsOnly")
        : d.error === "bad_domain" ? t("dmBadDomain")
        : t("dmFailed"),
      );
      return;
    }
    setNotice("");
  }, [domain, siteId, country, language, t]);

  // Free cache read as the domain is typed. Nothing here can spend money without the button.
  useEffect(() => {
    if (!domain.trim()) return;
    const id = setTimeout(() => { call(false).catch(() => {}); }, 500);
    return () => clearTimeout(id);
  }, [domain, siteId, country, language, call]);

  async function run() {
    if (busy || !hasKey) return;
    setBusy(true);
    await call(true).catch(() => {});
    setBusy(false);
  }

  const visibleKw = useMemo(
    () => keywords.filter(k => !search || k.keyword.includes(search.toLowerCase())).slice(0, 500),
    [keywords, search],
  );
  const visiblePages = useMemo(
    () => pages.filter(p => !search || p.url.toLowerCase().includes(search.toLowerCase())).slice(0, 500),
    [pages, search],
  );

  function exportCsv() {
    const rows = tab === "keywords"
      ? [["keyword", "position", "url", "volume", "kd", "cpc", "traffic", "our_position"],
         ...visibleKw.map(k => [k.keyword, k.position ?? "", k.url, k.volume ?? "", k.difficulty ?? "", k.cpc ?? "", k.traffic ?? "", k.ourPosition ?? ""])]
      : [["url", "keywords", "traffic"], ...visiblePages.map(p => [p.url, p.keywords ?? "", p.traffic ?? ""])];
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `demand-${domain}-${tab}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const cell: React.CSSProperties = { padding: "9px 12px", fontSize: "13px" };
  const th: React.CSSProperties = {
    ...cell, fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)",
    textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left",
  };

  return (
    <>
      <div className="panel" style={{ display: "flex", alignItems: "flex-end", gap: "10px", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 240px" }}>
          <span className="tool-field-label">{t("dmDomain")}</span>
          <input className="tool-input" value={domain} onChange={e => setDomain(e.target.value)}
            placeholder={t("dmDomainPh")} style={{ fontFamily: "monospace" }}
            onKeyDown={e => { if (e.key === "Enter") run(); }} />
        </div>
        <div>
          <span className="tool-field-label">{t("dmCompareWith")}</span>
          <select className="tool-input inline" value={siteId} onChange={e => setSiteId(e.target.value)}>
            <option value="">{t("dmNoCompare")}</option>
            {sites.map(s => (
              <option key={s.id} value={s.id}>{s.url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "")}</option>
            ))}
          </select>
        </div>
        <div>
          <span className="tool-field-label">{t("importCountry")}</span>
          <select className="tool-input inline" value={country}
            onChange={e => { setCountry(e.target.value); localStorage.setItem("seoMetricsCountry", e.target.value); }}>
            {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <span className="tool-field-label">{t("dmLanguage")}</span>
          <select className="tool-input inline" value={language}
            onChange={e => { setLanguage(e.target.value); localStorage.setItem("seoDemandLang", e.target.value); }}>
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>
        <button className="metric-action" onClick={run} disabled={busy || !hasKey || !domain.trim() || labsOnly}
          title={!hasKey ? t("dmNoKey") : labsOnly ? t("dmLabsOnly") : undefined}>
          {busy ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
          {t("dmAnalyze")}
        </button>
        {hasKey && !labsOnly && <span className="metric-cost">≈ {formatUsd(priceUsd)}</span>}
        {notice && <span style={{ fontSize: "12px", color: "var(--color-danger)" }}>{notice}</span>}
      </div>

      {summary && (
        <div className="panel">
          <div className="privacy-blur-all" style={{ display: "flex", gap: "36px", flexWrap: "wrap", alignItems: "flex-start", marginBottom: "14px" }}>
            <Stat label={t("dmOrgTraffic")} value={fmt(summary.organicTraffic)} />
            <Stat label={t("dmOrgKeywords")} value={fmt(summary.organicKeywords)} />
            {/* DR and referring domains are not part of this purchase — they come from the free
                public endpoint and the Ahrefs cache — but withholding them here would send the
                user to another screen for half the answer. */}
            {known?.dr != null && <Stat label={t("dmDr")} value={String(Math.round(known.dr))} />}
            {known?.refDomains != null && <Stat label={t("blpRefDomains")} value={fmt(known.refDomains)} />}
            <div style={{ marginLeft: "auto", fontSize: "12px", color: "var(--color-text-tertiary)", textAlign: "right" }}>
              {cachedAt ? t("dmFromCache") : spentUsd > 0 ? formatUsd(spentUsd) : ""}
            </div>
          </div>

          <PositionBar p={summary.positions} />
          <div style={{ display: "flex", gap: "16px", marginTop: "8px", fontSize: "11px", color: "var(--color-text-secondary)", flexWrap: "wrap" }}>
            <span><b style={{ color: "var(--color-accent-green)" }}>■</b> {t("dmPos3")} {summary.positions.top3}</span>
            <span><b style={{ color: "var(--color-accent-blue)" }}>■</b> {t("dmPos10")} {summary.positions.top10}</span>
            <span><b style={{ color: "var(--color-accent-orange)" }}>■</b> {t("dmPos20")} {summary.positions.top20}</span>
            <span><b style={{ color: "var(--color-text-tertiary)" }}>■</b> {t("dmPos100")} {summary.positions.top100}</span>
          </div>
        </div>
      )}

      {(keywords.length > 0 || pages.length > 0) && (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <button className={tab === "keywords" ? "pill active" : "pill"} onClick={() => setTab("keywords")} style={{ cursor: "pointer" }}>
            {t("dmTabKeywords")} ({keywords.length})
          </button>
          <button className={tab === "pages" ? "pill active" : "pill"} onClick={() => setTab("pages")} style={{ cursor: "pointer" }}>
            {t("dmTabPages")} ({pages.length})
          </button>
          <input className="tool-input inline" value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t("sdkSearch")} style={{ marginLeft: "auto", minWidth: "180px" }} />
          <button className="metric-action" onClick={exportCsv}><Download size={13} />CSV</button>
        </div>
      )}

      {!summary ? (
        <div className="panel" style={{ padding: "40px", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          {labsOnly ? t("dmLabsOnly") : hasKey ? t("dmDomainEmpty") : t("dmEmptyNoKey")}
        </div>
      ) : tab === "keywords" ? (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <table className="privacy-sensitive" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
                <th style={th}>{t("sdkColQuery")}</th>
                <th style={{ ...th, textAlign: "center", width: "60px" }}>{t("dmColPos")}</th>
                <th style={{ ...th, textAlign: "right", width: "80px" }}>{t("kwColVolume")}</th>
                <th style={{ ...th, textAlign: "right", width: "80px" }}>{t("dmColTraffic")}</th>
                <th style={{ ...th, textAlign: "center", width: "56px" }}>{t("kwColKd")}</th>
                <th style={th}>{t("dmColUrl")}</th>
                {siteId && <th style={{ ...th, textAlign: "center", width: "80px" }}>{t("gapOurPos")}</th>}
              </tr>
            </thead>
            <tbody>
              {visibleKw.map(k => (
                <tr key={`${k.keyword}|${k.url}`} style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <td style={{ ...cell, fontWeight: 600 }}>{k.keyword}</td>
                  <td style={{ ...cell, textAlign: "center" }}>{k.position ?? "—"}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{fmt(k.volume)}</td>
                  <td style={{ ...cell, textAlign: "right", color: "var(--color-text-secondary)" }}>{fmt(k.traffic)}</td>
                  <td style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)" }}>{k.difficulty ?? "—"}</td>
                  <td style={{ ...cell, fontSize: "12px", color: "var(--color-text-secondary)", maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <a href={k.url} target="_blank" rel="noreferrer noopener nofollow" title={k.url}
                      style={{ color: "var(--color-text-secondary)", textDecoration: "none" }}>
                      {k.url.replace(/^https?:\/\/[^/]+/, "") || "/"} <ExternalLink size={9} style={{ opacity: 0.5 }} />
                    </a>
                  </td>
                  {siteId && (
                    <td style={{ ...cell, textAlign: "center", fontWeight: 700, color: VERDICT_COLOR[k.verdict ?? "none"] }}>
                      {k.ourUrl ? (
                        <a href={k.ourUrl} target="_blank" rel="noreferrer" title={k.ourUrl}
                          style={{ color: VERDICT_COLOR[k.verdict ?? "none"], textDecoration: "none" }}>
                          {k.ourPosition ?? "—"}
                        </a>
                      ) : (k.ourPosition ?? "—")}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <table className="privacy-sensitive" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
                <th style={th}>{t("dmColUrl")}</th>
                <th style={{ ...th, textAlign: "right", width: "110px" }}>{t("dmTabKeywords")}</th>
                <th style={{ ...th, textAlign: "right", width: "110px" }}>{t("dmColTraffic")}</th>
              </tr>
            </thead>
            <tbody>
              {visiblePages.map(p => (
                <tr key={p.url} style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <td style={{ ...cell, maxWidth: "420px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <a href={p.url} target="_blank" rel="noreferrer noopener nofollow" title={p.url}
                      style={{ color: "var(--color-text-primary)", textDecoration: "none" }}>
                      {p.url.replace(/^https?:\/\//, "")} <ExternalLink size={9} style={{ opacity: 0.5 }} />
                    </a>
                  </td>
                  <td style={{ ...cell, textAlign: "right" }}>{fmt(p.keywords)}</td>
                  <td style={{ ...cell, textAlign: "right", color: "var(--color-text-secondary)" }}>{fmt(p.traffic)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
