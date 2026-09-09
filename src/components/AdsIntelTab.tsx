"use client";

// Ads Intelligence: what Google Ads Transparency knows about a domain's paid activity.
//
// The app measures plenty of organic reality; this tab measures the paid side — which
// advertisers put Google ads on a domain's behalf, with what copy and creatives, in which
// countries, and how the weekly volume moves. For competitor research that is the half the
// Search Console contour can never see.
//
// Same contract as the rest of the metrics layer: cached sections render for free, and only
// the Load buttons spend GoAnyAPI credits — 9 for the overview (advertiser mapping + hostId),
// 5 per detail section, 5 per title's country split. Sections cache independently for 7 days
// under their own credit prices, so detailing the tab never re-buys the overview.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Megaphone, RefreshCw } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getGoAnyKey } from "@/lib/seo/keys";

interface Advertiser { advertiser: string; country: string; adsCount: number | null; creativeIds: string[] }
interface AdTitle { title: string; startDay: string; endDay: string }
interface WeekCountry { country: string; countryName: string; adCount: number | null }
interface WeekAdvertiser { advertiser: string; country: string; adCount: number | null; countries: WeekCountry[] }
interface WeekRow { month: string; week: number; advertisers: WeekAdvertiser[] }
interface Statistics { weeks: WeekRow[]; totals: WeekAdvertiser[] }
interface TitleCountry { country: string; countryName: string; adCount: number | null }

interface Overview { advertisers: Advertiser[]; hostId: number | null; host: string | null; note?: string }

interface Cached<T> { payload: T | null; cached?: boolean; checkedAt?: string }

const COST_OVERVIEW = 9;
const COST_SECTION = 5;

const fmtDay = (d: string) =>
  /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

export default function AdsIntelTab({
  siteDbId, domain, shareToken,
}: { siteDbId: string; domain: string; shareToken?: string }) {
  const { t } = useLanguage();
  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

  const [overview, setOverview] = useState<Cached<Overview>>({ payload: null });
  const [titles, setTitles] = useState<Cached<AdTitle[]>>({ payload: null });
  const [stats, setStats] = useState<Cached<Statistics>>({ payload: null });
  const [images, setImages] = useState<Cached<Record<string, string>>>({ payload: null });
  const [countries, setCountries] = useState<Record<string, { rows: TitleCountry[]; checkedAt?: string }>>({});
  const [openTitle, setOpenTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    setHasKey(!shareToken && getGoAnyKey().trim().length > 4);
  }, [shareToken]);

  // Free wallet read, so the spend buttons sit next to what they will draw from.
  useEffect(() => {
    if (shareToken || !getGoAnyKey().trim()) return;
    fetch("/api/goanyapi", {
      method: "POST", headers: { "Content-Type": "application/json", "x-goanyapi-key": getGoAnyKey() },
      body: JSON.stringify({ op: "balance" }),
    }).then(r => (r.ok ? r.json() : null)).then(d => {
      if (d && typeof d.remainingCredits === "number") setBalance(d.remainingCredits);
    }).catch(() => {});
  }, [shareToken]);

  const read = useCallback(async (section: string, extra: Record<string, unknown> = {}) => {
    const res = await fetch("/api/ads-intel", {
      method: "POST", headers: { "Content-Type": "application/json", "x-goanyapi-key": getGoAnyKey() },
      body: JSON.stringify({ siteId: siteDbId, domain: clean, section, fetch: false, shareToken, ...extra }),
    });
    const d = await res.json().catch(() => ({}));
    return d?.payload ? d as { payload: unknown; checkedAt?: string } : null;
  }, [siteDbId, clean, shareToken]);

  // Cached sections render for free; every mount reads them all.
  useEffect(() => {
    if (!clean.includes(".")) return;
    (async () => {
      const [o, ti, st, im] = await Promise.all([
        read("overview"), read("titles"), read("statistics"), read("images"),
      ]);
      if (o) setOverview({ payload: o.payload as Overview, cached: true, checkedAt: o.checkedAt });
      if (ti) setTitles({ payload: ti.payload as AdTitle[], cached: true, checkedAt: ti.checkedAt });
      if (st) setStats({ payload: st.payload as Statistics, cached: true, checkedAt: st.checkedAt });
      if (im) setImages({ payload: im.payload as Record<string, string>, cached: true, checkedAt: im.checkedAt });
    })().catch(() => {});
  }, [clean, read]);

  const load = useCallback(async (section: "overview" | "titles" | "statistics" | "images", extra: Record<string, unknown> = {}) => {
    if (busy) return;
    setBusy(section); setErr(null);
    try {
      const res = await fetch("/api/ads-intel", {
        method: "POST", headers: { "Content-Type": "application/json", "x-goanyapi-key": getGoAnyKey() },
        body: JSON.stringify({ siteId: siteDbId, domain: clean, section, fetch: true, shareToken, ...extra }),
      });
      const d = await res.json().catch(() => ({}));
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
  }, [busy, siteDbId, clean, shareToken]);

  const loadCountries = useCallback(async (title: string) => {
    if (countries[title] || busy) return;
    setBusy(`countries`); setErr(null);
    try {
      const res = await fetch("/api/ads-intel", {
        method: "POST", headers: { "Content-Type": "application/json", "x-goanyapi-key": getGoAnyKey() },
        body: JSON.stringify({ siteId: siteDbId, domain: clean, section: "countries", fetch: true, title, shareToken }),
      });
      const d = await res.json().catch(() => ({}));
      if (Array.isArray(d?.payload)) {
        setCountries(prev => ({ ...prev, [title]: { rows: d.payload, checkedAt: d.checkedAt } }));
        if (typeof d.remainingCredits === "number") setBalance(d.remainingCredits);
      } else {
        setErr(String(d?.error ?? "no_data"));
      }
    } catch { setErr("network"); }
    setBusy(null);
  }, [countries, busy, siteDbId, clean, shareToken]);

  if (!clean.includes(".")) return null;

  const advertisers = overview.payload?.advertisers ?? [];
  const hostId = overview.payload?.hostId ?? null;
  const noKey = !shareToken && !hasKey;
  const guest = !!shareToken;

  const sectionHeader = (label: string, section: "titles" | "statistics" | "images", state: Cached<any>, emptyText: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", margin: "22px 0 10px", flexWrap: "wrap" }}>
      <h4 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{label}</h4>
      {!guest && !state.payload && (
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
    <div style={{ padding: "24px 32px", maxWidth: "1100px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <Megaphone size={17} color="var(--color-accent-blue)" />
        <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("adsTitle")}</h3>
        {!guest && balance != null && (
          <span className="metric-chip" style={{ fontWeight: 500 }}>GoAnyAPI · {balance.toLocaleString()} {t("adsCredits")}</span>
        )}
        {!guest && !overview.payload && hasKey && (
          <button className="metric-action" style={{ marginLeft: "auto" }} disabled={busy != null}
            onClick={() => load("overview")}>
            {busy === "overview" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            {t("adsLoad")} · {COST_OVERVIEW} {t("adsCredits")}
          </button>
        )}
      </div>
      <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "6px 0 18px", lineHeight: 1.6 }}>
        {t("adsSub")}
      </p>

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

      {!overview.payload && !overview.checkedAt && !err && (
        <div style={{ padding: "28px", textAlign: "center", border: "1px dashed var(--color-border)", borderRadius: "var(--radius-md)", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          {t("adsNoData")}
        </div>
      )}

      {/* Advertisers — the overview's answer */}
      {advertisers.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", margin: "18px 0 10px", flexWrap: "wrap" }}>
            <h4 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("adsAdvertisers")}</h4>
            {!guest && (
              <button className="metric-action" disabled={busy != null} onClick={() => load("overview")}
                title={t("blpRefresh")}>
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
