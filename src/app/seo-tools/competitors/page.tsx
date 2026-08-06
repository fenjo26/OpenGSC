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
import { useRouter } from "next/navigation";
import { Users, Loader2, Download, ExternalLink, Search, PenLine, FileDown } from "lucide-react";
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
  const router = useRouter();

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
  /**
   * Columns this gateway is known not to forward, learned server-side from a previous response.
   *
   * A reseller may speak the official protocol and still drop a field. `keyword_difficulty` is the
   * measured case: it never arrives on this endpoint through the group-buy host, while the pull was
   * priced with its 10-unit surcharge. Once known, the checkbox is disabled and the surcharge comes
   * out of the quote — the tool stops selling a column it cannot deliver.
   */
  const [unsupported, setUnsupported] = useState<string[]>([]);
  const kdBlocked = unsupported.includes("difficulty");

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
    if (Array.isArray(d.unsupported)) setUnsupported(d.unsupported);
    if (!res.ok) {
      setNotice(d.error === "cap_exceeded" ? t("kwCapExceeded")
        : d.error === "provider_unsupported" ? t("blpAhrefsOnly")
        : d.error === "not_migrated" ? t("gapNotMigrated")
        : d.error === "write_not_visible" ? t("gapWriteNotVisible")
        : t("gapFailed"));
      return null;
    }
    // A 200 that carries an error is the "we asked and the answer was nothing" case. It is not a
    // failure — the request worked — but it must still say so, because the panel below renders
    // identically whether nobody has pressed anything or the provider came back empty.
    if (d.error === "no_competitor_keywords") {
      setNotice(t("gapNoCompetitorKeywords").replace("{d}", String(d.competitor ?? "")));
      return d;
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
    await call("keywords", { competitor, limit, withDifficulty: withKd && !kdBlocked, maxPosition: 20 });
    setBusy(null);
  }


  /**
   * Hand a gap straight to the outline writer.
   *
   * This is the step the tool was missing. It could tell you a competitor ranks for something you
   * have nothing for, and then stopped — the verdict column said "write it" and there was nowhere
   * to click. Reuses the `seoClusterSeed` contract the cluster detail view already writes, so the
   * outline page needs no change and both entry points stay in step.
   *
   * `keyword` seeds the outline; the rest of the current selection rides along as additional
   * keywords, because a gap is almost never one query — it is a page's worth of them.
   */
  function toOutline(seed: string, extra: string[] = []) {
    sessionStorage.setItem("seoClusterSeed", JSON.stringify({
      keyword: seed,
      additional: extra.filter(k => k !== seed).join("\n"),
      gl: country,
    }));
    router.push("/seo-tools/outline");
  }


  /**
   * The current filter, as a file.
   *
   * A gap analysis is rarely acted on the same day: it goes into a content plan, a brief for a
   * writer, or another tool entirely. Exporting the filtered view — not the whole table — keeps
   * the decision the user just made ("show me only what I have no page for") in the file, which
   * is the part worth carrying out of the app.
   *
   * BOM first, because Excel reads a UTF-8 CSV as Latin-1 without it and Greek, French and
   * Cyrillic queries — most of this portfolio — arrive as mojibake.
   */
  function exportCsv() {
    const head = ["keyword", "verdict", "competitor", "competitor_position", "competitor_url",
                  "our_position", "our_url", "our_impressions", "volume", "difficulty", "market"];
    const verdict = (r: GapRow) => bucketOf(r);
    const rows = [head, ...visible.map(r => [
      r.keyword, verdict(r), r.competitor,
      r.competitorPosition ?? "", r.competitorUrl ?? "",
      r.ourPosition ?? "", r.ourUrl ?? "", r.ourImpressions ?? 0,
      r.volume ?? "", r.difficulty ?? "", country,
    ])];
    const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
    const site = sites.find(x => x.id === siteId)?.url || "site";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" }));
    a.download = `gap-${site}-${country}-${bucket}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const creds = getMetricsCreds();
  const discoverCost = estimateCostUsd(estimateCompetitorUnits(20), creds.provider);
  const pullUnits = estimateOrganicKeywordUnits(limit, withKd && !kdBlocked);
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
              <input type="checkbox" checked={withKd && !kdBlocked} disabled={kdBlocked}
                onChange={e => setWithKd(e.target.checked)} /> {t("kwWithKd")}
              {kdBlocked && <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>({t("gapKdUnsupported")})</span>}
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
          {/* Bulk hand-off: the highest-volume row of the current filter becomes the outline seed
              and everything else visible becomes its additional keywords. Placed next to the
              bucket filters on purpose — "Нет контента" filtered, then this button, is the whole
              workflow this screen exists for. */}
          {visible.length > 0 && (
            <button className="metric-action" style={{ marginLeft: "auto" }}
              title={t("gapToOutlineHint")}
              onClick={() => toOutline(visible[0].keyword, visible.slice(0, 40).map(v => v.keyword))}>
              <PenLine size={11} /> {t("gapToOutlineBulk")}
            </button>
          )}
          {visible.length > 0 && (
            <button className="metric-action" onClick={exportCsv} title={t("gapExportHint")}>
              <FileDown size={11} /> {t("gapExport")}
            </button>
          )}
          <input className="tool-input inline" value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t("sdkSearch")} style={{ minWidth: "200px" }} />
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
                    {/* The verdict is now the action. It read as advice and behaved as a label,
                        which is the same dead end as a warning with no button under it. */}
                    <td style={{ ...cell, fontSize: "11px", fontWeight: 600 }}>
                      <button
                        onClick={() => toOutline(r.keyword, visible.slice(0, 40).map(v => v.keyword))}
                        title={t("gapToOutlineOne")}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: "4px",
                          background: "transparent", border: "none", padding: 0, cursor: "pointer",
                          font: "inherit", color: BUCKET_COLOR[bk], textDecoration: "underline",
                          textDecorationStyle: "dotted", textUnderlineOffset: "3px",
                        }}>
                        {bk === "close" ? t("gapActClose") : bk === "weak" ? t("gapActWeak") : t("gapActMissing")}
                      </button>
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
