"use client";

// Ads Intelligence: what Google Ads Transparency knows about how a site advertises — for the
// scanned domain or any competitor's, and around any keyword. Lives as an optional section of
// the crawler (/crawler), which is where arbitrary domains already get looked up.
//
// Two research directions, and the distinction is the whole tab:
//
// 1. **By domain** — who advertises FOR a domain: the advertisers behind its Google ads, the
//    ad copy, creatives, countries and weekly volume. A domain with no Google Ads answers
//    empty, which is the normal answer for one's own site — the interesting lookups are the
//    competitors, hence the editable domain field.
// 2. **By keyword** — who buys ads AROUND a keyword: the advertisers and the OTHER domains
//    that show up on it. This is the competitive map: type the market's keyword, see who is
//    buying.
//
// Same contract as the rest of the metrics layer: cached sections render for free, and only
// the Load buttons spend GoAnyAPI credits — 9 for the domain overview (advertiser mapping +
// hostId), 5 per detail section, 5 per title's country split, 4 per keyword lookup. Sections
// cache independently for 7 days, so detailing the tab never re-buys the overview.

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getGoAnyKey } from "@/lib/seo/keys";

interface Advertiser { advertiser: string; country: string; adsCount: number | null; creativeIds: string[] }
interface AdTitle { title: string; startDay: string; endDay: string }
interface WeekCountry { country: string; countryName: string; adCount: number | null }
interface WeekAdvertiser { advertiser: string; country: string; adCount: number | null; countries: WeekCountry[] }
interface WeekRow { month: string; week: number; advertisers: WeekAdvertiser[] }
interface Statistics { weeks: WeekRow[]; totals: WeekAdvertiser[] }
interface TitleCountry { country: string; countryName: string; adCount: number | null }
interface KeywordAds { keyword: string; advertisers: { name: string; country: string; id: string; adsCount: number | null }[]; domains: string[] }

interface Overview { advertisers: Advertiser[]; hostId: number | null; host: string | null; note?: string }

interface Cached<T> { payload: T | null; cached?: boolean; checkedAt?: string }

const COST_OVERVIEW = 9;
const COST_SECTION = 5;
const COST_KEYWORD = 4;

const fmtDay = (d: string) =>
  /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

const normDomain = (d: string) =>
  d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

export default function AdsIntelTab({ domain }: { domain: string }) {
  const { t } = useLanguage();
  const siteDomain = normDomain(domain);

  // The research target: prefilled with the site, editable to any competitor.
  const [target, setTarget] = useState(siteDomain);
  const [domainInput, setDomainInput] = useState(siteDomain);

  const [overview, setOverview] = useState<Cached<Overview>>({ payload: null });
  const [titles, setTitles] = useState<Cached<AdTitle[]>>({ payload: null });
  const [stats, setStats] = useState<Cached<Statistics>>({ payload: null });
  const [images, setImages] = useState<Cached<Record<string, string>>>({ payload: null });
  const [kw, setKw] = useState<(Cached<KeywordAds> & { keyword?: string }) | null>(null);
  const [keywordInput, setKeywordInput] = useState("");
  const [countries, setCountries] = useState<Record<string, { rows: TitleCountry[]; checkedAt?: string }>>({});
  const [openTitle, setOpenTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    setHasKey(getGoAnyKey().trim().length > 4);
  }, []);

  // Free wallet read, so the spend buttons sit next to what they will draw from.
  useEffect(() => {
    if (!getGoAnyKey().trim()) return;
    fetch("/api/goanyapi", {
      method: "POST", headers: { "Content-Type": "application/json", "x-goanyapi-key": getGoAnyKey() },
      body: JSON.stringify({ op: "balance" }),
    }).then(r => (r.ok ? r.json() : null)).then(d => {
      if (d && typeof d.remainingCredits === "number") setBalance(d.remainingCredits);
    }).catch(() => {});
  }, []);

  const call = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch("/api/ads-intel", {
      method: "POST", headers: { "Content-Type": "application/json", "x-goanyapi-key": getGoAnyKey() },
      body: JSON.stringify({ domain: target, ...body }),
    });
    return res.json().catch(() => ({}));
  }, [target]);

  // Cached sections render for free; every domain switch re-reads them.
  const readAll = useCallback(async (forDomain: string) => {
    if (!forDomain.includes(".")) return;
    const read = async (section: string) => {
      const res = await fetch("/api/ads-intel", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: forDomain, section, fetch: false }),
      });
      const d = await res.json().catch(() => ({}));
      return d?.payload ? d as { payload: unknown; checkedAt?: string } : null;
    };
    const [o, ti, st, im] = await Promise.all([
      read("overview"), read("titles"), read("statistics"), read("images"),
    ]);
    setOverview(o ? { payload: o.payload as Overview, cached: true, checkedAt: o.checkedAt } : { payload: null });
    setTitles(ti ? { payload: ti.payload as AdTitle[], cached: true, checkedAt: ti.checkedAt } : { payload: null });
    setStats(st ? { payload: st.payload as Statistics, cached: true, checkedAt: st.checkedAt } : { payload: null });
    setImages(im ? { payload: im.payload as Record<string, string>, cached: true, checkedAt: im.checkedAt } : { payload: null });
    setCountries({});
    setOpenTitle(null);
  }, []);

  useEffect(() => { readAll(target).catch(() => {}); }, [target, readAll]);

  const load = useCallback(async (section: "overview" | "titles" | "statistics" | "images") => {
    if (busy) return;
    setBusy(section); setErr(null);
    try {
      const d = await call({ section, fetch: true });
      if (d?.payload != null) {
        const at = d.checkedAt;
        if (section === "overview") setOverview({ payload: d.payload, cached: false, checkedAt: at });
        else if (section === "titles") setTitles({ payload: d.payload, cached: false, checkedAt: at });
        else if (section === "statistics") setStats({ payload: d.payload, cached: false, checkedAt: at });
        else if (section === "images") setImages({ payload: d.payload, cached: false, checkedAt: at });
        if (typeof d.remainingCredits === "number") setBalance(d.remainingCredits);
      } else {
        setErr(String(d?.error ?? "no_data"));
      }
    } catch { setErr("network"); }
    setBusy(null);
  }, [busy, call]);

  const loadKeyword = useCallback(async () => {
    const kwTrim = keywordInput.trim().toLowerCase();
    if (!kwTrim || busy) return;
    setBusy("keyword"); setErr(null);
    try {
      const d = await call({ section: "keyword", fetch: true, keyword: kwTrim });
      if (d?.payload != null) {
        setKw({ payload: d.payload as KeywordAds, cached: false, checkedAt: d.checkedAt, keyword: kwTrim });
        if (typeof d.remainingCredits === "number") setBalance(d.remainingCredits);
      } else {
        setErr(String(d?.error ?? "no_data"));
      }
    } catch { setErr("network"); }
    setBusy(null);
  }, [keywordInput, busy, call]);

  const loadCountries = useCallback(async (title: string) => {
    if (countries[title] || busy) return;
    setBusy("countries"); setErr(null);
    try {
      const d = await call({ section: "countries", fetch: true, title });
      if (Array.isArray(d?.payload)) {
        setCountries(prev => ({ ...prev, [title]: { rows: d.payload, checkedAt: d.checkedAt } }));
        if (typeof d.remainingCredits === "number") setBalance(d.remainingCredits);
      } else {
        setErr(String(d?.error ?? "no_data"));
      }
    } catch { setErr("network"); }
    setBusy(null);
  }, [countries, busy, call]);

  if (!siteDomain.includes(".")) return null;

  const advertisers = overview.payload?.advertisers ?? [];
  const hostId = overview.payload?.hostId ?? null;
  const noKey = !hasKey;

  const sectionHeader = (label: string, section: "titles" | "statistics" | "images", state: Cached<any>, emptyText: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", margin: "22px 0 10px", flexWrap: "wrap" }}>
      <h4 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{label}</h4>
      {(
        <button className="metric-action" disabled={busy != null || !hostId || !hasKey}
          onClick={() => load(section)}
          title={!hostId ? t("adsNeedOverview") : !hasKey ? t("adsNoKey") : undefined}>
          {busy === section ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          {t("adsLoad")} · {COST_SECTION} {t("adsCredits")}
        </button>
      )}
      {state.checkedAt && <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>
        {new Date(state.checkedAt).toLocaleDateString()}
      </span>}
      {state.payload && Array.isArray(state.payload) && state.payload.length === 0 && (
        <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{emptyText}</span>
      )}
      {state.payload && !Array.isArray(state.payload) && Object.keys(state.payload ?? {}).length === 0 && (
        <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{emptyText}</span>
      )}
    </div>
  );

  const maxWeekAdCount = Math.max(1, ...(stats.payload?.weeks ?? []).map(w =>
    Math.max(1, ...w.advertisers.map(a => a.adCount ?? 0))));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {balance != null && (
        <div style={{ marginBottom: "10px" }}>
          <span className="metric-chip" style={{ fontWeight: 500 }}>GoAnyAPI · {balance.toLocaleString()} {t("adsCredits")}</span>
        </div>
      )}

      {/* Research target — the site is only the default; competitors are the point. */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px", flexWrap: "wrap" }}>
        <span className="tool-field-label" style={{ marginBottom: 0 }}>{t("adsDomainLabel")}:</span>
        <input className="tool-input" value={domainInput} style={{ maxWidth: "280px", fontFamily: "monospace" }}
          onChange={e => setDomainInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { const d = normDomain(domainInput); if (d.includes(".")) setTarget(d); } }}
          placeholder="competitor.com" />
        <button className="pill" onClick={() => {
          const d = normDomain(domainInput);
          if (d.includes(".") && d !== target) setTarget(d);
        }} style={{ cursor: "pointer" }}>{t("adsCheckDomain")}</button>
        {target !== siteDomain && (
          <button className="pill" onClick={() => { setDomainInput(siteDomain); setTarget(siteDomain); }}
            style={{ cursor: "pointer" }} title={siteDomain}>← {siteDomain}</button>
        )}
      </div>

      {/* Keyword mode — who buys ads around a keyword, and which other domains show up */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "20px", flexWrap: "wrap" }}>
        <span className="tool-field-label" style={{ marginBottom: 0 }}>{t("adsKeywordSearch")}:</span>
        <input className="tool-input" value={keywordInput} style={{ maxWidth: "280px" }}
          onChange={e => setKeywordInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") loadKeyword(); }}
          placeholder="online casino…" />
        <button className="metric-action" disabled={busy != null || !keywordInput.trim() || !hasKey}
          onClick={loadKeyword}
          title={!hasKey ? t("adsNoKey") : undefined}>
          {busy === "keyword" ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
          {t("adsKeywordSearch")} · {COST_KEYWORD} {t("adsCredits")}
        </button>
      </div>

      {noKey && (
        <div style={{ marginBottom: "16px", padding: "10px 14px", borderRadius: "var(--radius-md)", fontSize: "12px",
          color: "var(--color-text-secondary)", background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
          {t("adsNoKey")}
        </div>
      )}
      {err && (
        <div style={{ marginBottom: "14px", fontSize: "12px", color: "var(--color-warning)" }}>
          {err === "no_data" ? t("adsNoData") : err === "load_overview_first" ? t("adsNeedOverview") : err}
        </div>
      )}

      {/* Keyword results — the "which other domains are buying" answer */}
      {kw?.payload && (
        <div style={{ marginBottom: "20px", padding: "14px 16px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", background: "var(--color-bg)" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "10px" }}>
            «{kw.payload.keyword}»
          </div>
          {kw.payload.domains.length > 0 && (
            <>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>{t("adsDomains")}</div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "12px" }}>
                {kw.payload.domains.map(d => (
                  <a key={d} href={`https://${d}`} target="_blank" rel="noreferrer noopener nofollow"
                    className="metric-chip" style={{ fontWeight: 600, textDecoration: "none", color: "var(--color-text-primary)" }}>
                    {d} ↗
                  </a>
                ))}
              </div>
            </>
          )}
          {kw.payload.advertisers.length > 0 && (
            <>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>{t("adsAdvertisers")}</div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {kw.payload.advertisers.map(a => (
                  <span key={a.id} className="metric-chip" title={`${t("adsCountry")}: ${a.country}`}>
                    {a.name} · {a.adsCount ?? "—"}
                  </span>
                ))}
              </div>
            </>
          )}
          {kw.payload.domains.length === 0 && kw.payload.advertisers.length === 0 && (
            <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{t("adsNoData")}</div>
          )}
        </div>
      )}

      {/* Domain overview — the site's own domain often answers empty, and that is the honest answer */}
      {advertisers.length > 0 ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", margin: "18px 0 10px", flexWrap: "wrap" }}>
            <h4 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("adsAdvertisers")} · {target}</h4>
            {(
              <button className="metric-action" disabled={busy != null} onClick={() => load("overview")} title={t("blpRefresh")}>
                {busy === "overview" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              </button>
            )}
            {overview.checkedAt && <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>
              {new Date(overview.checkedAt).toLocaleDateString()}
            </span>}
          </div>
          <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
                  {(["adsAdvertiser", "adsCountry", "adsCount", "adsCreativeIds"] as const).map(k => (
                    <th key={k} style={{ padding: "8px 12px", fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", textAlign: "left" }}>{t(k)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {advertisers.map(a => (
                  <tr key={a.advertiser} style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <td style={{ padding: "8px 12px", fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>{a.advertiser}</td>
                    <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--color-text-secondary)" }}>{a.country || "—"}</td>
                    <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--color-text-secondary)" }}>{a.adsCount ?? "—"}</td>
                    <td style={{ padding: "8px 12px", fontSize: "12px", color: "var(--color-text-tertiary)", fontFamily: "monospace" }}>
                      {a.creativeIds.length ? a.creativeIds.slice(0, 3).join(", ") + (a.creativeIds.length > 3 ? "…" : "") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : overview.checkedAt ? (
        <div style={{ marginBottom: "8px", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          {t("adsNoData")} · {t("adsOwnSiteHint")}
        </div>
      ) : !noKey && !err && target && (
        <div style={{ padding: "28px", textAlign: "center", border: "1px dashed var(--color-border)", borderRadius: "var(--radius-md)", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          {`${t("adsLoad")} · ${COST_OVERVIEW} ${t("adsCredits")} — ${target}`}
        </div>
      )}

      {/* Weekly activity */}
      {sectionHeader(t("adsWeekly"), "statistics", stats, t("adsNoData"))}
      {(stats.payload?.weeks?.length ?? 0) > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "flex-end", gap: "3px", height: "72px", marginBottom: "8px", flexWrap: "nowrap", overflowX: "auto" }}>
            {stats.payload!.weeks.map(w => {
              const total = w.advertisers.reduce((s, a) => s + (a.adCount ?? 0), 0);
              const h = Math.max(4, Math.round((total / maxWeekAdCount) * 64));
              return (
                <div key={`${w.month}-${w.week}`} title={`${w.month} · ${t("adsWeek")} ${w.week}: ${total}`}
                  style={{ width: "16px", flexShrink: 0, height: `${h}px`, borderRadius: "3px 3px 0 0",
                    background: "var(--color-accent-blue)", opacity: 0.75 }} />
              );
            })}
          </div>
          <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
                  {(["adsAdvertiser", "adsCountry", "adsCount"] as const).map(k => (
                    <th key={k} style={{ padding: "8px 12px", fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", textAlign: "left" }}>{t(k)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(stats.payload!.totals ?? []).slice(0, 15).map(a => (
                  <tr key={a.advertiser} style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--color-text-primary)" }}>{a.advertiser}</td>
                    <td style={{ padding: "8px 12px", fontSize: "13px", color: "var(--color-text-secondary)" }}>
                      {a.countries.length
                        ? a.countries.slice().sort((x, y) => (y.adCount ?? 0) - (x.adCount ?? 0)).slice(0, 4)
                            .map(c => `${c.countryName || c.country} ${c.adCount ?? 0}`).join(", ")
                        : a.country || "—"}
                    </td>
                    <td style={{ padding: "8px 12px", fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>{a.adCount ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Ad titles + per-title countries */}
      {sectionHeader(t("adsTitles"), "titles", titles, t("adsNoData"))}
      {(titles.payload?.length ?? 0) > 0 && (
        <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
          {titles.payload!.map((ti, i) => (
            <div key={i} style={{ borderBottom: "1px solid var(--color-border)" }}>
              <button onClick={() => {
                const next = openTitle === ti.title ? null : ti.title;
                setOpenTitle(next);
                if (next) loadCountries(next);
              }} style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%", textAlign: "left",
                padding: "9px 12px", background: "transparent", border: "none", cursor: "pointer", flexWrap: "wrap" }}>
                <span style={{ flex: 1, fontSize: "13px", color: "var(--color-text-primary)" }}>{ti.title}</span>
                <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>
                  {fmtDay(ti.startDay)} → {fmtDay(ti.endDay)}
                </span>
              </button>
              {openTitle === ti.title && (
                <div style={{ padding: "6px 12px 12px 24px", background: "var(--color-bg)" }}>
                  {countries[ti.title] ? (
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      {countries[ti.title].rows.slice().sort((a, b) => (b.adCount ?? 0) - (a.adCount ?? 0)).map(c => (
                        <span key={c.country} className="metric-chip" style={{ fontWeight: 500 }}>
                          {c.countryName || c.country} · {c.adCount ?? "—"}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      {busy === "countries" ? <Loader2 size={12} className="spin" /> : null}
                      {t("adsCountries")} · {COST_SECTION} {t("adsCredits")}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Creatives */}
      {sectionHeader(t("adsImages"), "images", images, t("adsNoData"))}
      {images.payload && Object.keys(images.payload).length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "12px" }}>
          {Object.entries(images.payload).map(([detailUrl, asset]) => (
            asset.includes("/sadbundle/") ? (
              <a key={detailUrl} href={detailUrl} target="_blank" rel="noreferrer noopener nofollow"
                style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "18px 10px",
                  fontSize: "12px", color: "var(--color-accent-blue)", border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)", textDecoration: "none", wordBreak: "break-all" }}>
                HTML · {t("adsOpen")}
              </a>
            ) : (
              <a key={detailUrl} href={detailUrl} target="_blank" rel="noreferrer noopener nofollow"
                style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", overflow: "hidden", display: "block" }}>
                {/* Google's asset hosts are publicly fetchable; no-referrer keeps it that way. */}
                <img src={asset} referrerPolicy="no-referrer" loading="lazy" alt=""
                  style={{ width: "100%", display: "block", background: "#fff" }}
                  onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
              </a>
            )
          ))}
        </div>
      )}
    </div>
  );
}
