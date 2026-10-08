"use client";

// «Яндекс AI» sub-tab: where the site appears in Yandex's AI answers, from Keys.so.
//
// The other sub-tabs ask engines the user's own questions. This one reads the inverse from an
// index — every query whose Yandex AI answer already cites the site — so it needs no tracked
// questions and finds the ones nobody thought to ask. It only exists for users with a Keys.so
// key (the hub hides the tab otherwise) and only spends on the refresh button: 2 credits.
//
// Deliberately small: the query, its Wordstat frequency, our cited URL and where we sit among
// the answer's sources; then the domains cited beside us. The answer text itself is not shown —
// it is third-party HTML, and the question plus the cited URL is the fact worth acting on.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, ExternalLink } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePrivacy } from "@/lib/PrivacyContext";
import { getMetricsCreds, estimateCostUsd, formatUsd } from "@/lib/seo/metricsClient";
import { gatewayStatusFromError } from "@/lib/seo/metricsPricing";
import type { KeyssoAiAnswer, KeyssoAiCompetitor } from "@/lib/seo/keyssoParse";

const UNITS = 2;
const VISIBLE_ROWS = 25;

interface Report {
  total: number | null;
  answers: KeyssoAiAnswer[];
  competitorsTotal: number | null;
  competitors: KeyssoAiCompetitor[];
  fetchedAt: string;
}

const th: React.CSSProperties = { textAlign: "left", padding: "7px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 };
const td: React.CSSProperties = { padding: "7px 10px" };
const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());

export default function YandexAiPanel({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  const { blur } = usePrivacy();
  const blurStyle: React.CSSProperties = blur ? { filter: "blur(5px)", userSelect: "none" } : {};

  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [showAll, setShowAll] = useState(false);

  // setState only inside promise callbacks — never synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/metrics/yandex-ai", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteId: siteDbId }),
    })
      .then(r => r.json())
      .then(d => { if (!cancelled) setReport(d.report ?? null); })
      .catch(() => { /* the empty state explains itself */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [siteDbId]);

  const refresh = useCallback(async () => {
    if (busy) return;
    setBusy(true); setNotice("");
    const creds = getMetricsCreds("keysso");
    try {
      const r = await fetch("/api/metrics/yandex-ai", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, fetch: true, apiKey: creds.apiKey, baseUrl: creds.baseUrl, cap: creds.cap }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.report) setReport(d.report);
      if (d.error) {
        const gw = gatewayStatusFromError(d.error);
        setNotice(d.error === "cap_exceeded" ? t("kwCapExceeded")
          : d.error === "no_key" ? t("blsrcNoKey")
          : gw === 401 ? t("metricsKeyssoBadKey")
          : gw === 402 ? t("blsrcKsOutOfCredits")
          : t("ykaiFailed"));
      }
    } catch { setNotice(t("ykaiFailed")); }
    setBusy(false);
  }, [busy, siteDbId, t]);

  const rows = useMemo(() => report?.answers ?? [], [report]);
  const visible = showAll ? rows : rows.slice(0, VISIBLE_ROWS);
  const updated = report?.fetchedAt
    ? new Date(report.fetchedAt).toLocaleString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" })
    : "";

  const chip = (label: string, value: string) => (
    <div style={{ padding: "10px 14px", borderRadius: "var(--radius-md)", background: "var(--color-bg)", border: "1px solid var(--color-border)", minWidth: "104px" }}>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: "2px" }}>{label}</div>
      <div style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)", fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );

  return (
    <div className="card" style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: "10px", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("ykaiTitle")}</span>
            <span className="metric-chip" style={{ fontWeight: 500 }} title={t("blpKsMarketHint")}>Keys.so · {t("ykaiMarket")}</span>
          </div>
          <div style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", marginTop: "4px", lineHeight: 1.5 }}>{t("ykaiHint")}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span className="metric-cost">{UNITS} {t("blsrcKsCredits")} · ≈ {formatUsd(estimateCostUsd(UNITS, "keysso"))}</span>
          <button className="metric-action" onClick={refresh} disabled={busy}>
            {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            {t("ykaiRefresh")}
          </button>
        </div>
      </div>

      {notice && <div style={{ fontSize: "12px", color: "var(--color-warning)" }}>{notice}</div>}

      {loading ? (
        <div style={{ padding: "20px", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>…</div>
      ) : !report ? (
        <div style={{ padding: "28px", textAlign: "center", border: "1px dashed var(--color-border)", borderRadius: "var(--radius-md)", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          {t("ykaiEmpty")}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            {chip(t("ykaiQueries"), num(report.total))}
            {chip(t("ykaiCompetitors"), num(report.competitorsTotal))}
            {updated && chip(t("ykaiChecked"), updated)}
          </div>

          {rows.length === 0 ? (
            <div style={{ padding: "20px", textAlign: "center", fontSize: "13px", color: "var(--color-text-tertiary)" }}>{t("ykaiNone")}</div>
          ) : (
            <div style={{ overflowX: "auto", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
              <table className="privacy-sensitive" style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px", minWidth: "600px" }}>
                <thead>
                  <tr style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
                    <th style={th}>{t("ykaiQuery")}</th>
                    <th style={{ ...th, textAlign: "center" }} title={t("ykaiWskHint")}>{t("ykaiWsk")}</th>
                    <th style={{ ...th, textAlign: "center" }} title={t("ykaiRankHint")}>#</th>
                    <th style={th}>{t("ykaiOurUrl")}</th>
                    <th style={th}>{t("ykaiBeside")}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(r => (
                    <tr key={r.query} style={{ borderBottom: "1px solid var(--color-border)" }}>
                      <td style={{ ...td, color: "var(--color-text-primary)", ...blurStyle }}>{r.query}</td>
                      <td style={{ ...td, textAlign: "center", fontVariantNumeric: "tabular-nums", color: "var(--color-text-secondary)" }}>{num(r.wsk)}</td>
                      <td style={{ ...td, textAlign: "center", fontWeight: 700, color: r.rank === 1 ? "var(--color-success)" : "var(--color-text-primary)" }}>{r.rank ?? "—"}</td>
                      <td style={{ ...td, maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...blurStyle }}>
                        {r.url ? (
                          <a href={r.url} target="_blank" rel="noreferrer noopener nofollow" title={r.url}
                            style={{ color: "var(--color-accent-blue)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                            {r.url.replace(/^https?:\/\/(www\.)?[^/]+/, "") || "/"} <ExternalLink size={10} />
                          </a>
                        ) : "—"}
                      </td>
                      <td style={{ ...td, fontSize: "11.5px", color: "var(--color-text-tertiary)", maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={r.sources.join(", ")}>
                        {r.sources.filter((_, i) => i + 1 !== r.rank).slice(0, 3).join(", ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rows.length > VISIBLE_ROWS && (
            <button className="pill" onClick={() => setShowAll(v => !v)} style={{ cursor: "pointer", alignSelf: "center" }}>
              {showAll ? t("ykaiShowLess") : `${t("ykaiShowAll")} (${rows.length})`}
            </button>
          )}

          {report.competitors.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("ykaiCompetitorsTitle")}</div>
              <div style={{ overflowX: "auto", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px" }}>
                  <thead>
                    <tr style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
                      <th style={th}>{t("blpDomain")}</th>
                      <th style={{ ...th, textAlign: "center" }} title={t("ykaiSharedHint")}>{t("ykaiShared")}</th>
                      <th style={{ ...th, textAlign: "center" }}>{t("ykaiTheirAi")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.competitors.map(c => (
                      <tr key={c.domain} style={{ borderBottom: "1px solid var(--color-border)" }}>
                        <td style={{ ...td, ...blurStyle }}>
                          <a href={`https://${c.domain}`} target="_blank" rel="noreferrer noopener nofollow" style={{ color: "var(--color-text-primary)", textDecoration: "none" }}>{c.domain}</a>
                        </td>
                        <td style={{ ...td, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{num(c.shared)}</td>
                        <td style={{ ...td, textAlign: "center", fontVariantNumeric: "tabular-nums", color: "var(--color-text-secondary)" }}>{num(c.aiQueries)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
