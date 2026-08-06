"use client";

// Competitor keyword gap.
//
// The value is not the competitor's keyword list — Ahrefs shows that already. It is the join
// with your own Search Console data, which produces three categorically different answers that
// no single tool can give:
//
//   • they rank, you have a page, it is buried  → a rewrite, and the URL is right there
//   • they rank, you have impressions but no page winning → an intent mismatch
//   • they rank, you are invisible → genuinely missing content
//
// Sorted by the first group, because that is the work with the shortest path to traffic.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Users, Loader2, Download, ExternalLink, Search } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { COUNTRIES } from "@/lib/seo/regions";
import {
  getMetricsCreds, estimateCostUsd, formatUsd,
} from "@/lib/seo/metricsClient";
import { estimateCompetitorUnits, estimateOrganicKeywordUnits } from "@/lib/seo/metrics";

interface GapRow {
  keyword: string; competitor: string;
  competitorPosition: number | null; volume: number | null; difficulty: number | null;
  competitorUrl: string;
  ourPosition: number | null; ourUrl: string | null; ourImpressions: number;
}
interface Found { domain: string; sharedKeywords: number | null }
interface SiteOption { id: string; url: string }

type Bucket = "close" | "weak" | "missing";

/** Which of the three answers a row is. Order matters: it is the sort key. */
function bucketOf(r: GapRow): Bucket {
  if (r.ourPosition != null && r.ourPosition <= 30) return "close";
  if (r.ourImpressions > 0) return "weak";
  return "missing";
}

const BUCKET_COLOR: Record<Bucket, string> = {
  close: "var(--color-success)", weak: "var(--color-warning)", missing: "var(--color-text-tertiary)",
};
const fmt = (n: number | null) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export default function CompetitorsPage() {
  const { t } = useLanguage();

  const [sites, setSites] = useState<SiteOption[]>([]);
  const [siteId, setSiteId] = useState("");
  const [country, setCountry] = useState("us");

  const [rows, setRows] = useState<GapRow[]>([]);
  const [competitors, setCompetitors] = useState<string[]>([]);
  const [found, setFound] = useState<Found[]>([]);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState<null | "competitors" | "keywords">(null);
  const [notice, setNotice] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [withKd, setWithKd] = useState(false);
  const [limit, setLimit] = useState(200);
  const [bucket, setBucket] = useState<Bucket | "all">("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    setHasKey(getMetricsCreds().apiKey.length > 4);
    setCountry(localStorage.getItem("seoMetricsCountry") || "us");
    fetch("/api/gsc/sites")
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const list: SiteOption[] = (d?.sites ?? []).map((x: any) => ({ id: x.id, url: x.url }));
        setSites(list);
        if (list.length) setSiteId(prev => prev || list[0].id);
      })
      .catch(() => {});
  }, []);

  const call = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    if (!siteId) return null;
    const creds = getMetricsCreds();
    const body: Record<string, unknown> = { siteId, country, action, provider: creds.provider, ...extra };
    if (action !== "read") {
      Object.assign(body, { apiKey: creds.apiKey, baseUrl: creds.baseUrl, cap: creds.cap });
    }
    const res = await fetch("/api/metrics/gap", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (Array.isArray(d.rows)) setRows(d.rows);
    if (Array.isArray(d.competitors)) setCompetitors(d.competitors);
    if (!res.ok) {
      setNotice(d.error === "cap_exceeded" ? t("kwCapExceeded")
        : d.error === "provider_unsupported" ? t("blpAhrefsOnly")
        : d.error === "not_migrated" ? t("gapNotMigrated")
        : d.error === "write_not_visible" ? t("gapWriteNotVisible")
        : t("gapFailed"));
      return null;
    }
    setNotice("");
    return d;
  }, [siteId, country, t]);

  // Free read of what is stored, on every site/market change.
  useEffect(() => { if (siteId) call("read").catch(() => {}); }, [siteId, country, call]);

  async function discover() {
    if (busy) return;
    setBusy("competitors");
    const d = await call("competitors", { limit: 20 });
    if (d?.found) setFound(d.found);
    setBusy(null);
  }

  async function pull(competitor: string) {
    if (busy || !competitor) return;
    setBusy("keywords");
    await call("keywords", { competitor, limit, withDifficulty: withKd, maxPosition: 20 });
    setBusy(null);
  }

  const creds = getMetricsCreds();
  const discoverCost = estimateCostUsd(estimateCompetitorUnits(20), creds.provider);
  const pullUnits = estimateOrganicKeywordUnits(limit, withKd);
  const pullCost = estimateCostUsd(pullUnits, creds.provider);

  const counts = useMemo(() => {
    const c = { close: 0, weak: 0, missing: 0 };
    for (const r of rows) c[bucketOf(r)]++;
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const order: Record<Bucket, number> = { close: 0, weak: 1, missing: 2 };
    return rows
      .filter(r => bucket === "all" || bucketOf(r) === bucket)
      .filter(r => !search || r.keyword.includes(search.toLowerCase()))
      .sort((a, b) => {
        const d = order[bucketOf(a)] - order[bucketOf(b)];
        if (d !== 0) return d;
        return (b.volume ?? 0) - (a.volume ?? 0);
      })
      .slice(0, 500);
  }, [rows, bucket, search]);

  const cell: React.CSSProperties = { padding: "9px 12px", fontSize: "13px" };
  const th: React.CSSProperties = { ...cell, fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" };

  return (
    // Not `.main-content`: the SEO Tools layout already supplies the page padding and max
    // width, and stacking the two put the content in a narrower, doubly-inset column.
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <Users size={22} style={{ color: "var(--color-accent-blue)" }} />
        <h1 className="title" style={{ margin: 0 }}>{t("menuCompetitors")}</h1>
      </div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "4px" }}>{t("gapSub")}</div>

      <div className="panel" style={{ display: "flex", alignItems: "flex-end", gap: "10px", flexWrap: "wrap" }}>
        <div>
          <span className="tool-field-label">{t("importSite")}</span>
          <select className="tool-input inline" value={siteId} onChange={e => setSiteId(e.target.value)}>
            {sites.map(s => <option key={s.id} value={s.id}>{s.url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "")}</option>)}
          </select>
        </div>
        <div>
          <span className="tool-field-label">{t("importCountry")}</span>
          <select className="tool-input inline" value={country} onChange={e => { setCountry(e.target.value); localStorage.setItem("seoMetricsCountry", e.target.value); }}>
            {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </div>
        <button className="metric-action" onClick={discover} disabled={!!busy || !hasKey || !siteId}
          title={!hasKey ? t("gapNoKey") : undefined}>
          {busy === "competitors" ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
          {t("gapDiscover")}
        </button>
        {hasKey && <span className="metric-cost">≈ {formatUsd(discoverCost)}</span>}
        {notice && <span style={{ fontSize: "12px", color: "var(--color-danger)" }}>{notice}</span>}
      </div>

      {/* Competitor input — always available once a site is picked. Auto-discovered suggestions
          appear at the top when Ahrefs knows them, but for a small/new domain Ahrefs returns
          nothing, and hiding the manual entry behind "found something" made the tool look broken
          exactly there. The pull button works for any domain the user types. */}
      {siteId && (
        <div className="panel">
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "10px" }}>
            <span className="tool-section-label" style={{ marginBottom: 0 }}>{t("gapCompetitors")}</span>
            <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)", cursor: "pointer" }} title={t("kwWithKdHint")}>
              <input type="checkbox" checked={withKd} onChange={e => setWithKd(e.target.checked)} /> {t("kwWithKd")}
            </label>
            <select className="tool-input inline" value={limit} onChange={e => setLimit(Number(e.target.value))}>
              {[100, 200, 500, 1000].map(n => <option key={n} value={n}>{n} {t("gapKeywords")}</option>)}
            </select>
            <span className="metric-cost">{pullUnits.toLocaleString()} {t("metricsUnits")} · ≈ {formatUsd(pullCost)}</span>
          </div>

          {found.length > 0 && (
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
              {found.map(f => (
                /* Green outline = already pulled. Deliberately not .pill.active: that means
                   "currently selected filter" everywhere else in the app and would read as a
                   mode here rather than as a state. */
                <button key={f.domain} className="pill" onClick={() => pull(f.domain)} disabled={!!busy}
                  style={{
                    cursor: busy ? "not-allowed" : "pointer",
                    borderColor: competitors.includes(f.domain) ? "var(--color-accent-green)" : "transparent",
                  }}>
                  {busy === "keywords" ? <Loader2 size={11} className="spin" /> : <Download size={11} />}
                  {f.domain}
                  {f.sharedKeywords != null && (
                    <span style={{ color: "var(--color-text-secondary)" }}>· {fmt(f.sharedKeywords)}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Manual entry — the only path for a domain Ahrefs has no organic-keyword footprint for.
              Shown whether or not discovery returned anything, with a hint explaining why a small
              site may need it. */}
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
            <input className="tool-input inline" value={manual} onChange={e => setManual(e.target.value)}
              placeholder={t("gapManualPh")} onKeyDown={e => { if (e.key === "Enter") pull(manual); }}
              style={{ minWidth: "220px", fontFamily: "monospace" }} />
            <button className="metric-action" onClick={() => pull(manual)} disabled={!!busy || !manual.trim() || !hasKey}
              title={!hasKey ? t("gapNoKey") : undefined}>
              {busy === "keywords" && manual.trim() ? <Loader2 size={11} className="spin" /> : <Download size={11} />}
              {t("gapPull")}
            </button>
            <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{t("gapManualHint")}</span>
          </div>
        </div>
      )}

      {/* Buckets */}
      {rows.length > 0 && (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          {([["all", `${t("gapAll")} (${rows.length})`], ["close", `${t("gapClose")} (${counts.close})`],
            ["weak", `${t("gapWeak")} (${counts.weak})`], ["missing", `${t("gapMissing")} (${counts.missing})`]] as const).map(([k, label]) => (
            <button key={k} className={bucket === k ? "pill active" : "pill"}
              onClick={() => setBucket(k as Bucket | "all")} style={{ cursor: "pointer" }}>{label}</button>
          ))}
          <input className="tool-input inline" value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t("sdkSearch")} style={{ marginLeft: "auto", minWidth: "200px" }} />
        </div>
      )}

      {rows.length === 0 ? (
        <div className="panel" style={{ padding: "40px", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          {t("gapEmpty")}
        </div>
      ) : (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
                <th style={th}>{t("sdkColQuery")}</th>
                <th style={{ ...th, width: "120px" }}>{t("gapWho")}</th>
                <th style={{ ...th, textAlign: "center", width: "80px" }}>{t("gapTheirPos")}</th>
                <th style={{ ...th, textAlign: "center", width: "80px" }}>{t("gapOurPos")}</th>
                <th style={{ ...th, textAlign: "right", width: "80px" }}>{t("kwColVolume")}</th>
                <th style={{ ...th, textAlign: "center", width: "56px" }}>{t("kwColKd")}</th>
                <th style={{ ...th, width: "90px" }}>{t("gapAction")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => {
                const bk = bucketOf(r);
                return (
                  <tr key={`${r.competitor}|${r.keyword}`} style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <td style={{ ...cell, fontWeight: 600 }}>{r.keyword}</td>
                    <td style={{ ...cell, color: "var(--color-text-secondary)", fontSize: "12px" }}>
                      <a href={r.competitorUrl || `https://${r.competitor}`} target="_blank" rel="noreferrer noopener nofollow"
                        style={{ color: "var(--color-text-secondary)", textDecoration: "none" }}>
                        {r.competitor} <ExternalLink size={9} style={{ opacity: 0.5 }} />
                      </a>
                    </td>
                    <td style={{ ...cell, textAlign: "center" }}>{r.competitorPosition ?? "—"}</td>
                    {/* Our own position comes from GSC, so an em dash here means "never shown
                        for this query", not "not measured". */}
                    <td style={{ ...cell, textAlign: "center", fontWeight: 700, color: BUCKET_COLOR[bk] }}>
                      {r.ourUrl ? (
                        <a href={r.ourUrl} target="_blank" rel="noreferrer" title={r.ourUrl} style={{ color: BUCKET_COLOR[bk], textDecoration: "none" }}>
                          {r.ourPosition ?? "—"}
                        </a>
                      ) : (r.ourPosition ?? "—")}
                    </td>
                    <td style={{ ...cell, textAlign: "right" }}>{fmt(r.volume)}</td>
                    <td style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)" }}>{r.difficulty ?? "—"}</td>
                    <td style={{ ...cell, fontSize: "11px", color: BUCKET_COLOR[bk], fontWeight: 600 }}>
                      {bk === "close" ? t("gapActClose") : bk === "weak" ? t("gapActWeak") : t("gapActMissing")}
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
