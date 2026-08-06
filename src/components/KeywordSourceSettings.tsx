"use client";

// Where the AI content tools get keyword volumes and difficulty.
//
// This setting is the one the app was missing. There has always been a selector for who scrapes
// the SERP and one for whose metrics feed the analytics screens, but the content tools simply
// used DataForSEO if a key happened to exist. Scraping with Serper and paying for Ahrefs
// therefore produced outlines with no keyword data at all — and said nothing about it.
//
// Deliberately shows which source `auto` resolved to. "Automatic" is only reassuring when you can
// see what it decided; otherwise it is the same silence in a friendlier font.

import { useEffect, useState } from "react";
import { KeyRound, CheckCircle2, AlertTriangle } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import {
  getKwSourceSetting, setKwSourceSetting, getKwAuto, setKwAuto,
  getKwLimit, setKwLimit, getKeywordSource, type KwSourceSetting,
} from "@/lib/seo/keys";
import { getMetricsWithKd, setMetricsWithKd, priceExpand, formatUsd } from "@/lib/seo/metricsClient";

const OPTIONS: { value: KwSourceSetting; labelKey: string }[] = [
  { value: "auto", labelKey: "kwSrcAuto" },
  { value: "ahrefs", labelKey: "kwSrcAhrefs" },
  { value: "semrush", labelKey: "kwSrcSemrush" },
  { value: "dataforseo", labelKey: "kwSrcDataForSeo" },
  { value: "off", labelKey: "kwSrcOff" },
];

export default function KeywordSourceSettings() {
  const { t } = useLanguage();

  const [mounted, setMounted] = useState(false);
  const [setting, setSetting] = useState<KwSourceSetting>("auto");
  const [auto, setAutoState] = useState(false);
  const [limit, setLimitState] = useState(100);
  const [withKd, setWithKd] = useState(false);
  const [resolved, setResolved] = useState<{ source: KwSourceSetting; apiKey: string }>({ source: "off", apiKey: "" });

  const refresh = () => setResolved(getKeywordSource() as { source: KwSourceSetting; apiKey: string });

  useEffect(() => {
    setMounted(true);
    setSetting(getKwSourceSetting());
    setAutoState(getKwAuto());
    setLimitState(getKwLimit());
    setWithKd(getMetricsWithKd());
    refresh();
  }, []);

  const choose = (v: KwSourceSetting) => { setSetting(v); setKwSourceSetting(v); refresh(); };

  const configured = resolved.apiKey.length > 4;
  const price = mounted ? priceExpand(resolved.source as any, limit, withKd) : { units: 0, usd: 0 };

  return (
    <div className="panel">
      <div style={{ display: "flex", alignItems: "center", gap: "9px", marginBottom: "4px" }}>
        <KeyRound size={17} color="var(--color-accent-purple)" />
        <h3 style={{ fontSize: "15px", fontWeight: 700, margin: 0, color: "var(--color-text-primary)" }}>{t("kwSrcTitle")}</h3>
      </div>
      <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 14px", lineHeight: 1.55, maxWidth: "640px" }}>
        {t("kwSrcSub")}
      </p>

      <span className="tool-section-label">{t("kwSrcSource")}</span>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
        {OPTIONS.map(o => (
          <button
            key={o.value}
            onClick={() => choose(o.value)}
            style={{
              padding: "8px 14px", borderRadius: "9px", fontSize: "13px", fontWeight: 600, cursor: "pointer",
              border: `1px solid ${setting === o.value ? "var(--color-accent-purple)" : "var(--color-border)"}`,
              background: setting === o.value ? "rgba(175,82,222,0.12)" : "transparent",
              color: setting === o.value ? "var(--color-accent-purple)" : "var(--color-text-secondary)",
            }}
          >{t(o.labelKey as never)}</button>
        ))}
      </div>

      {mounted && setting !== "off" && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: "7px", fontSize: "12px", marginBottom: "14px" }}>
          {configured
            ? <>
                <CheckCircle2 size={14} color="#10B981" style={{ flexShrink: 0, marginTop: "1px" }} />
                <span style={{ color: "var(--color-text-secondary)" }}>
                  {t("kwSrcResolved").replace("{s}", sourceLabel(resolved.source, t))}
                </span>
              </>
            : <>
                <AlertTriangle size={14} color="#f59e0b" style={{ flexShrink: 0, marginTop: "1px" }} />
                <span style={{ color: "var(--color-text-secondary)" }}>{t("kwSrcNoKey")}</span>
              </>}
        </div>
      )}

      <span className="tool-section-label">{t("kwSrcBehaviour")}</span>
      <div style={{ display: "flex", gap: "16px", alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ maxWidth: "180px" }}>
          <span className="tool-field-label">{t("kwSrcLimit")}</span>
          <input
            className="tool-input" value={limit} inputMode="numeric"
            onChange={e => setLimitState(Number(e.target.value.replace(/[^0-9]/g, "")) || 0)}
            onBlur={() => { const n = Math.max(50, Math.min(200, limit || 100)); setLimitState(n); setKwLimit(n); }}
          />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12px", color: "var(--color-text-secondary)", paddingBottom: "9px", cursor: "pointer" }}>
          <input type="checkbox" checked={withKd} onChange={e => { setWithKd(e.target.checked); setMetricsWithKd(e.target.checked); }} />
          {t("kwSrcWithKd")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12px", color: "var(--color-text-secondary)", paddingBottom: "9px", cursor: "pointer" }}>
          <input type="checkbox" checked={auto} onChange={e => { setAutoState(e.target.checked); setKwAuto(e.target.checked); }} />
          {t("kwSrcAutoFetch")}
        </label>
      </div>

      <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "8px", lineHeight: 1.55, maxWidth: "640px" }}>
        {price.units > 0
          ? t("kwSrcPrice")
              .replace("{n}", price.units.toLocaleString())
              .replace("{usd}", formatUsd(price.usd))
              .replace("{limit}", String(limit))
          : t("kwSrcPriceUnknown")}
        {" "}{auto ? t("kwSrcAutoOnHint") : t("kwSrcAutoOffHint")}
      </div>
    </div>
  );
}

function sourceLabel(s: KwSourceSetting, t: (k: never) => string): string {
  if (s === "ahrefs") return "Ahrefs";
  if (s === "semrush") return "Semrush";
  if (s === "dataforseo") return "DataForSEO";
  return t("kwSrcOff" as never);
}
