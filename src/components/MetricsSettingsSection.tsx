"use client";

// Everything about Ahrefs/Semrush in one screen.
//
// It used to be two: the key was typed under "API Keys" while the provider, host and spending
// cap lived under "SEO Tools". One integration configured in two places is the kind of split
// that makes a settings screen unusable — you cannot tell what is connected without visiting
// both, and neither page is wrong on its own.
//
// The other fix is the access mode. "Custom base URL" is a question nobody can answer without
// already knowing the answer. Whether you hold an official subscription or bought credits from a
// reseller is something you *do* know, so the screen asks that and derives the host itself.

import { useEffect, useMemo, useState } from "react";
import { BarChart3, ExternalLink, FileUp } from "lucide-react";
import Link from "next/link";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { SeoKeyCard, METRICS_PROVIDER_CARDS, METRICS_GATEWAY_URL } from "@/components/SeoToolsSettings";
import {
  getMetricsMode, setMetricsMode, metricsKeyStorage, RESELLER_BASE_URL,
  type MetricsMode,
} from "@/lib/seo/metricsClient";
import type { MetricsProvider } from "@/lib/seo/metrics";

const OFFICIAL_DOCS: Record<MetricsProvider, string> = {
  ahrefs: "https://docs.ahrefs.com/",
  semrush: "https://developer.semrush.com/api/",
};

/** Shown under the key field so the destination is never implicit. */
const OFFICIAL_HOST: Record<MetricsProvider, string> = {
  ahrefs: "https://api.ahrefs.com",
  semrush: "https://api.semrush.com",
};

export default function MetricsSettingsSection() {
  const { t } = useLanguage();

  const [provider, setProvider] = useState<MetricsProvider>("ahrefs");
  const [mode, setMode] = useState<MetricsMode>("official");
  const [customUrl, setCustomUrl] = useState("");
  const [cap, setCap] = useState("");
  const [usage, setUsage] = useState<{ units: number; requests: number } | null>(null);

  // localStorage after mount only — reading it during render would make the first client pass
  // disagree with the server-rendered HTML.
  useEffect(() => {
    setProvider(localStorage.getItem("seoMetricsProvider") === "semrush" ? "semrush" : "ahrefs");
  }, []);

  useEffect(() => {
    setMode(getMetricsMode(provider));
    setCustomUrl(localStorage.getItem(`seoMetricsBaseUrl_${provider}`) || "");
    setCap(localStorage.getItem(`seoMetricsCap_${provider}`) || "");
    fetch(`/api/metrics/usage?provider=${provider}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setUsage({ units: Number(d.units || 0), requests: Number(d.requests || 0) }); })
      .catch(() => {});
  }, [provider]);

  const chooseProvider = (p: MetricsProvider) => {
    setProvider(p);
    localStorage.setItem("seoMetricsProvider", p);
  };

  const chooseMode = (m: MetricsMode) => {
    setMode(m);
    setMetricsMode(provider, m, customUrl);
    if (m === "reseller") setCustomUrl(RESELLER_BASE_URL[provider]);
    if (m === "official") setCustomUrl("");
  };

  const saveCap = (v: string) => {
    const n = Math.max(0, Number(v) || 0);
    if (n > 0) localStorage.setItem(`seoMetricsCap_${provider}`, String(n));
    else localStorage.removeItem(`seoMetricsCap_${provider}`);
  };

  // The card writes into the slot belonging to the *current mode*, not a shared cell. Remounting
  // it on a mode change (via `key`) is what makes the field show that mode's key rather than
  // keeping the previous one on screen.
  const card = useMemo(() => {
    const base = METRICS_PROVIDER_CARDS.find(c => c.id === provider)!;
    return { ...base, storageKey: metricsKeyStorage(provider, mode) };
  }, [provider, mode]);

  const modeOption = (m: MetricsMode, title: string, desc: string) => (
    <button key={m} onClick={() => chooseMode(m)} style={{
      flex: "1 1 200px", textAlign: "left", padding: "12px 14px", cursor: "pointer",
      borderRadius: "var(--radius-md)",
      border: `1px solid ${mode === m ? "var(--color-accent-blue)" : "var(--color-border)"}`,
      background: mode === m ? "color-mix(in srgb, var(--color-accent-blue) 8%, transparent)" : "var(--color-bg)",
    }}>
      <div style={{ fontSize: "13px", fontWeight: 700, color: mode === m ? "var(--color-accent-blue)" : "var(--color-text-primary)" }}>{title}</div>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5, marginTop: "3px" }}>{desc}</div>
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* The free path comes first, deliberately. Most people arrive here thinking a key is
          required; it is not, and the cheapest answer should not be buried under the paid one. */}
      <div style={{
        display: "flex", alignItems: "center", gap: "10px", padding: "12px 16px",
        borderRadius: "var(--radius-sm)", fontSize: "13px", color: "var(--color-text-secondary)",
        background: "color-mix(in srgb, var(--color-accent-blue) 8%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-accent-blue) 20%, transparent)",
      }}>
        <FileUp size={16} style={{ flexShrink: 0, color: "var(--color-accent-blue)" }} />
        <span style={{ flex: 1 }}>{t("metricsNoKeyPath")}</span>
        <Link href="/seo-tools/import" className="pill" style={{ textDecoration: "none", flexShrink: 0 }}>
          {t("menuImport")}
        </Link>
      </div>

      <div className="panel">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
          <BarChart3 size={17} color="var(--color-accent-blue)" />
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("metricsTitle")}</h2>
        </div>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 16px" }}>{t("metricsSub")}</p>

        {/* 1. Which data provider */}
        <span className="tool-section-label">{t("metricsStep1")}</span>
        <div style={{ display: "flex", gap: "8px", marginBottom: "18px" }}>
          {(["ahrefs", "semrush"] as const).map(p => (
            <button key={p} className={provider === p ? "pill active" : "pill"}
              onClick={() => chooseProvider(p)} style={{ cursor: "pointer" }}>
              {p === "ahrefs" ? "Ahrefs" : "Semrush"}
            </button>
          ))}
          <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)", alignSelf: "center", lineHeight: 1.5 }}>
            {t("metricsProviderHint")}
          </span>
        </div>

        {/* 2. Where the key comes from — the question that replaced "custom base URL" */}
        <span className="tool-section-label">{t("metricsStep2")}</span>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" }}>
          {modeOption("official", t("metricsModeOfficial"), t("metricsModeOfficialDesc"))}
          {modeOption("reseller", t("metricsModeReseller"), t("metricsModeResellerDesc"))}
          {modeOption("custom", t("metricsModeCustom"), t("metricsModeCustomDesc"))}
        </div>

        {mode === "official" && (
          <a href={OFFICIAL_DOCS[provider]} target="_blank" rel="noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "var(--color-accent-blue)", textDecoration: "none", marginBottom: "16px" }}>
            {t("metricsGetOfficial")} <ExternalLink size={11} />
          </a>
        )}

        {mode === "reseller" && (
          <div style={{ marginBottom: "16px" }}>
            <a href={METRICS_GATEWAY_URL} target="_blank" rel="noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "var(--color-accent-blue)", textDecoration: "none" }}>
              {t("metricsBuyCredits")} <ExternalLink size={11} />
            </a>
            {/* Said here, next to the link, rather than only in the README — the moment someone
                is about to rely on this is the moment the caveat is worth reading. */}
            <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", lineHeight: 1.55, marginTop: "6px", maxWidth: "620px" }}>
              {t("metricsResellerNote")}
            </div>
            <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", fontFamily: "monospace", marginTop: "6px" }}>
              {RESELLER_BASE_URL[provider]}
            </div>
          </div>
        )}

        {mode === "custom" && (
          <div style={{ marginBottom: "16px", maxWidth: "460px" }}>
            <span className="tool-field-label">{t("metricsBaseUrl")}</span>
            <input className="tool-input" value={customUrl} style={{ fontFamily: "monospace" }}
              onChange={e => setCustomUrl(e.target.value)}
              onBlur={() => setMetricsMode(provider, "custom", customUrl)}
              placeholder={`https://api.${provider}.com`} />
            <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "5px", lineHeight: 1.5 }}>
              {t("metricsBaseUrlHint")}
            </div>
          </div>
        )}

        {/* 3. The key itself */}
        <span className="tool-section-label">{t("metricsStep3")}</span>
        <div style={{ marginBottom: "6px" }}>
          <SeoKeyCard key={card.storageKey} provider={card} hideDocsLink />
        </div>
        {/* The destination, spelled out under the field.
            One key is stored per provider, not per mode — but an official key and a reseller
            key are different strings. Without this line, switching modes leaves the old key
            pointed at a host that will reject it, and the only symptom is a 401 from a screen
            that looked correctly configured. */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginBottom: "18px", fontSize: "11px", color: "var(--color-text-secondary)" }}>
          <span>{t("metricsTarget")}:</span>
          <code style={{ fontFamily: "monospace", color: "var(--color-text-primary)" }}>
            {mode === "official" ? OFFICIAL_HOST[provider]
              : mode === "reseller" ? RESELLER_BASE_URL[provider]
              : (customUrl.trim() || OFFICIAL_HOST[provider])}
          </code>
          <span style={{ color: "var(--color-text-tertiary)" }}>· {t("metricsKeyPerMode")}</span>
        </div>

        {/* 4. Spending */}
        <span className="tool-section-label">{t("metricsStep4")}</span>
        <div style={{ display: "flex", alignItems: "flex-end", gap: "16px", flexWrap: "wrap" }}>
          <div style={{ maxWidth: "220px" }}>
            <span className="tool-field-label">{t("metricsCap")}</span>
            <input className="tool-input" value={cap} inputMode="numeric" placeholder={t("metricsCapPh")}
              onChange={e => setCap(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={() => saveCap(cap)} />
          </div>
          <div style={{ paddingBottom: "9px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
            {t("metricsUsage")}: <strong style={{ color: "var(--color-text-primary)" }}>{(usage?.units ?? 0).toLocaleString()}</strong> {t("metricsUnits")}
            {usage?.requests ? <span style={{ color: "var(--color-text-tertiary)" }}> · {usage.requests} {t("metricsRequests")}</span> : null}
          </div>
        </div>
        <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "6px", lineHeight: 1.5, maxWidth: "620px" }}>
          {t("metricsCapHint")}
        </div>
      </div>
    </div>
  );
}
