"use client";

// The Yandex half of the Ads tab: how the researched domain advertises in Yandex Direct, from
// Keys.so. Rendered below the Google Ads Transparency sections only for users with a Keys.so
// key, against the same target domain — one research box, two ad markets, each labelled.
//
// Same contract as the sections above: the cached snapshot reads free, «Load» spends 2 credits.

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ExternalLink } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getMetricsCreds, estimateCostUsd, formatUsd } from "@/lib/seo/metricsClient";
import type { KeyssoDirectAd, KeyssoDirectKeyword } from "@/lib/seo/keyssoParse";

interface Report { adsTotal: number | null; ads: KeyssoDirectAd[]; keywordsTotal: number | null; keywords: KeyssoDirectKeyword[]; fetchedAt: string }

const UNITS = 2;
const label: React.CSSProperties = { fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" };
const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());

export default function YandexDirectBlock({ domain }: { domain: string }) {
  const { t } = useLanguage();
  const [report, setReport] = useState<Report | null>(null);
  const [checkedAt, setCheckedAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!domain.includes(".")) return;
    let cancelled = false;
    fetch("/api/ads-intel/yandex", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain }),
    })
      .then(r => r.json())
      .then(d => { if (!cancelled) { setReport(d.payload ?? null); setCheckedAt(d.checkedAt ?? ""); setErr(""); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [domain]);

  const load = useCallback(async () => {
    if (busy) return;
    setBusy(true); setErr("");
    const c = getMetricsCreds("keysso");
    try {
      const r = await fetch("/api/ads-intel/yandex", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, fetch: true, apiKey: c.apiKey, baseUrl: c.baseUrl, cap: c.cap }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.payload) { setReport(d.payload); setCheckedAt(d.checkedAt ?? ""); }
      if (d.error) {
        const e = String(d.error);
        setErr(e === "cap_exceeded" ? t("kwCapExceeded")
          : /^keysso 402/.test(e) ? t("blsrcKsOutOfCredits")
          : /^keysso 401/.test(e) ? t("metricsKeyssoBadKey")
          : t("ykaiFailed"));
      }
    } catch { setErr(t("ykaiFailed")); }
    setBusy(false);
  }, [busy, domain, t]);

  return (
    <div style={{ marginTop: "24px", paddingTop: "18px", borderTop: "1px solid var(--color-border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "10px" }}>
        <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("ydTitle")}</span>
        <span className="metric-chip" style={{ fontWeight: 500 }} title={t("blpKsMarketHint")}>Keys.so · {t("ykaiMarket")}</span>
        {checkedAt && <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{new Date(checkedAt).toLocaleDateString()}</span>}
        <button className="metric-action" style={{ marginLeft: "auto" }} onClick={() => { void load(); }} disabled={busy || !domain.includes(".")}>
          {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          {t("ydLoad")} · {UNITS} {t("blsrcKsCredits")} · ≈ {formatUsd(estimateCostUsd(UNITS, "keysso"))}
        </button>
      </div>
      {err && <div style={{ marginBottom: "10px", fontSize: "12px", color: "var(--color-warning)" }}>{err}</div>}
      {!report ? (
        <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{t("ydEmpty")}</div>
      ) : (report.ads.length === 0 && report.keywords.length === 0) ? (
        <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{t("ydNone")}</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
          <div>
            <div style={label}>{t("ydAds")} · {num(report.adsTotal)}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {report.ads.map((a, i) => (
                <div key={`${a.title}-${i}`} style={{ padding: "10px 12px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", background: "var(--color-bg)" }}>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", lineHeight: 1.4 }}>{a.title}</div>
                  {a.text && <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "3px", lineHeight: 1.45 }}>{a.text}</div>}
                  <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "6px", fontSize: "11px", color: "var(--color-text-tertiary)" }}>
                    {a.url && (
                      <a href={a.url} target="_blank" rel="noreferrer noopener nofollow" style={{ color: "var(--color-accent-blue)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "3px", maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.url.replace(/^https?:\/\/(www\.)?/, "")} <ExternalLink size={10} />
                      </a>
                    )}
                    {a.keys != null && <span>{t("ydAdKeys")}: {a.keys}</span>}
                    {a.seen && <span>{a.seen}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div style={label}>{t("ydKeywords")} · {num(report.keywordsTotal)}</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px" }}>
              <tbody>
                {report.keywords.map(k => (
                  <tr key={k.keyword} style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <td style={{ padding: "6px 8px", color: "var(--color-text-primary)" }} title={k.title}>{k.keyword}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }} title={t("ykaiWskHint")}>{num(k.wsk)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
