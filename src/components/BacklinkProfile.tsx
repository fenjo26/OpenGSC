"use client";

// Backlink profile: what the provider sees pointing at this site, as opposed to the manual
// list below it, which is what you built yourself. They answer different questions — "did my
// link land and is it still alive" versus "what does my link graph look like" — so this sits
// alongside that list rather than replacing it.
//
// Same contract as everything else in the metrics layer: the stored profile renders for free,
// including one filled entirely by CSV import, and only the refresh button spends anything.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link2, Loader2, RefreshCw, TrendingDown } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getMetricsCreds, estimateCostUsd, formatUsd } from "@/lib/seo/metricsClient";
import { isGuestView, shareTokenFromPath } from "@/lib/shareParam";
import { estimateProfileUnits } from "@/lib/seo/metrics";

interface RefDomain {
  refDomain: string;
  dr: number | null;
  linksToTarget: number | null;
  dofollow: boolean;
  firstSeen: string;
  lost: boolean;
  lostAt: string;
  source: "api" | "csv";
  fetchedAt: string;
}

interface Snapshot { date: string; refDomains: number | null; backlinks: number | null; dofollowPct: number | null }

function drColor(dr: number) {
  if (dr >= 70) return "var(--color-success)";
  if (dr >= 50) return "var(--color-accent-green)";
  if (dr >= 30) return "var(--color-warning)";
  return "var(--color-text-secondary)";
}

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

export default function BacklinkProfile({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  // A client opening a share link sees the profile and cannot refresh it. The server enforces
  // that too — this only keeps a button on screen that would always fail.
  const guest = isGuestView();

  const [rows, setRows] = useState<RefDomain[]>([]);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [limit, setLimit] = useState(100);
  const [showLost, setShowLost] = useState(false);

  useEffect(() => { setHasKey(!guest && getMetricsCreds().apiKey.length > 4); }, [guest]);

  const call = useCallback(async (doFetch: boolean) => {
    const creds = getMetricsCreds();
    const body: Record<string, unknown> = { siteId: siteDbId, provider: creds.provider, fetch: doFetch };
    const token = shareTokenFromPath();
    if (token) body.shareToken = token;
    if (doFetch) Object.assign(body, { apiKey: creds.apiKey, baseUrl: creds.baseUrl, cap: creds.cap, limit });

    const res = await fetch("/api/metrics/backlinks", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (Array.isArray(d.refDomains)) setRows(d.refDomains);
    if (Array.isArray(d.history)) setHistory(d.history);
    if (!res.ok && doFetch) {
      setNotice(d.error === "cap_exceeded" ? t("kwCapExceeded")
        : d.error === "provider_unsupported" ? t("blpAhrefsOnly")
        : t("blpFailed"));
    } else if (doFetch) {
      // A partial pull cannot prove a link is gone, so it does not mark anything lost. Saying
      // so is the difference between "no losses" and "we did not look".
      setNotice(d.complete === false ? t("blpPartial") : "");
    }
  }, [siteDbId, limit, t]);

  // Free read of what is stored — never reaches a provider.
  useEffect(() => { call(false).catch(() => {}); }, [call]);

  async function refresh() {
    if (busy) return;
    setBusy(true); setNotice("");
    try { await call(true); } catch { setNotice(t("blpFailed")); }
    setBusy(false);
  }

  const live = useMemo(() => rows.filter(r => !r.lost), [rows]);
  const lost = useMemo(() => rows.filter(r => r.lost), [rows]);
  const latest = history[history.length - 1];
  const previous = history.length > 1 ? history[0] : null;
  const units = estimateProfileUnits(limit);
  const usd = estimateCostUsd(units, getMetricsCreds().provider);

  const chip = (label: string, value: string, hint?: string) => (
    <div key={label} title={hint} style={{ padding: "10px 14px", borderRadius: "var(--radius-md)", background: "var(--color-bg)", border: "1px solid var(--color-border)", minWidth: "104px" }}>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: "2px" }}>{label}</div>
      <div style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)" }}>{value}</div>
    </div>
  );

  const cell: React.CSSProperties = { padding: "9px 12px", fontSize: "13px" };
  const th: React.CSSProperties = { ...cell, fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" };

  const visible = showLost ? lost : live;

  return (
    <div className="panel" style={{ marginBottom: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px", flexWrap: "wrap" }}>
        <Link2 size={17} color="var(--color-accent-blue)" />
        <h3 className="title-sm" style={{ margin: 0 }}>{t("blpTitle")}</h3>

        {!guest && <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {hasKey && (
            <>
              <select className="tool-input inline" value={limit} onChange={e => setLimit(Number(e.target.value))}>
                {[50, 100, 250, 500, 1000].map(n => <option key={n} value={n}>{n} {t("blpRefDomains")}</option>)}
              </select>
              <span className="metric-cost">{units.toLocaleString()} {t("metricsUnits")} · ≈ {formatUsd(usd)}</span>
            </>
          )}
          <button className="metric-action" onClick={refresh} disabled={busy || !hasKey}
            title={!hasKey ? t("blpNoKey") : undefined}>
            {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            {busy ? t("blpLoading") : t("blpRefresh")}
          </button>
        </div>}
      </div>
      <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 14px" }}>{t("blpSub")}</p>

      {notice && (
        <div style={{ marginBottom: "12px", fontSize: "12px", color: "var(--color-text-secondary)" }}>{notice}</div>
      )}

      {rows.length === 0 && !latest ? (
        <div style={{ padding: "28px", textAlign: "center", border: "1px dashed var(--color-border)", borderRadius: "var(--radius-md)", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          {t("blpEmpty")}
        </div>
      ) : (
        <>
          <div className="privacy-blur-all" style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "14px" }}>
            {chip(t("blpRefDomains"), fmt(latest?.refDomains ?? live.length))}
            {chip(t("blpBacklinks"), fmt(latest?.backlinks))}
            {chip(t("blpDofollow"), latest?.dofollowPct != null ? `${latest.dofollowPct}%` : "—", t("blpDofollowHint"))}
            {/* Only meaningful once two pulls exist; before that the honest answer is nothing. */}
            {previous?.refDomains != null && latest?.refDomains != null &&
              chip(t("blpChange"), `${latest.refDomains - previous.refDomains >= 0 ? "+" : ""}${latest.refDomains - previous.refDomains}`, t("blpChangeHint"))}
            {lost.length > 0 && chip(t("blpLost"), String(lost.length))}
          </div>

          <div style={{ display: "flex", gap: "6px", marginBottom: "10px" }}>
            {([[false, `${t("blpLive")} (${live.length})`], [true, `${t("blpLost")} (${lost.length})`]] as const).map(([v, label]) => (
              <button key={String(v)} className={showLost === v ? "pill active" : "pill"}
                onClick={() => setShowLost(v)} style={{ cursor: "pointer", border: "1px solid transparent" }}>{label}</button>
            ))}
          </div>

          <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
            <table className="privacy-sensitive" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
                  <th style={th}>{t("blpDomain")}</th>
                  <th style={{ ...th, textAlign: "center", width: "70px" }}>DR</th>
                  <th style={{ ...th, textAlign: "center", width: "80px" }}>{t("blpLinks")}</th>
                  <th style={{ ...th, width: "110px" }}>{showLost ? t("blpLostAt") : t("blpFirstSeen")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, 200).map(r => (
                  <tr key={r.refDomain} style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <td style={cell}>
                      <a href={`https://${r.refDomain}`} target="_blank" rel="noreferrer noopener nofollow"
                        style={{ color: "var(--color-text-primary)", textDecoration: "none" }}>{r.refDomain}</a>
                      {!r.dofollow && (
                        <span className="metric-chip" style={{ marginLeft: "6px", fontWeight: 500 }}>nofollow</span>
                      )}
                    </td>
                    <td style={{ ...cell, textAlign: "center", fontWeight: 700, color: r.dr != null ? drColor(r.dr) : "var(--color-text-secondary)" }}>
                      {r.dr != null ? Math.round(r.dr) : "—"}
                    </td>
                    <td style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)" }}>{r.linksToTarget ?? "—"}</td>
                    <td style={{ ...cell, color: "var(--color-text-secondary)", fontSize: "12px" }}>
                      {showLost ? (r.lostAt || "—") : (r.firstSeen ? r.firstSeen.slice(0, 10) : "—")}
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr><td colSpan={4} style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)", padding: "24px" }}>
                    {showLost ? <><TrendingDown size={14} style={{ verticalAlign: "-2px", marginRight: "6px" }} />{t("blpNoLost")}</> : t("blpEmpty")}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
