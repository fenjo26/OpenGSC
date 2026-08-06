"use client";

// Portfolio-wide keyword warm-up.
//
// The per-page "Load weights" button is the right shape for one screen and the wrong shape for a
// portfolio: Ahrefs bills `max(50, cost × rows)`, so paying the 50-unit floor once per page
// instead of once per batch is most of the bill on a large account. This panel asks the server to
// count the whole cohort first, shows the price, and only then spends anything.
//
// It deliberately shows two numbers the per-page loader cannot: how many keywords are already
// cached (free) and how many sites were skipped because their market is unknown. The second one
// is the honest part — a site on a generic TLD with no market set is not warmed up rather than
// warmed up as the United States.

import { useCallback, useEffect, useState } from "react";
import { Flame, Loader2, AlertTriangle } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getMetricsCreds, getMetricsWithKd, setMetricsWithKd, estimateCostUsd, formatUsd } from "@/lib/seo/metricsClient";

interface MarketRow { country: string; total: number; missing: number; units: number }
interface Summary {
  sitesScanned: number;
  skippedSites: string[];
  totalQueries: number;
  markets: MarketRow[];
  units: number;
  fetched?: number;
  error?: string;
}

type Scope = "all" | "tag";

export default function MetricsWarmup() {
  const { t } = useLanguage();

  const [mounted, setMounted] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [withKd, setWithKd] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [counting, setCounting] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  // The scheduled half. Stored with the other SEO settings so it rides along with the existing
  // server-side mirror; the scheduler reads it from there, since a cron has no localStorage.
  const [autoOn, setAutoOn] = useState(false);
  const [autoCap, setAutoCap] = useState("50000");
  const [autoSaved, setAutoSaved] = useState(false);

  useEffect(() => {
    setMounted(true);
    setWithKd(getMetricsWithKd());
    // The tag list is already assembled for the digest picker; reused rather than recomputed.
    fetch("/api/digest").then(r => r.json()).then(d => setTags(d.tags || [])).catch(() => {});
    try {
      const raw = JSON.parse(localStorage.getItem("seoWarmupSchedule") || "{}");
      setAutoOn(!!raw.enabled);
      setAutoCap(String(raw.cap ?? 50000));
    } catch { /* first run */ }
  }, []);

  const creds = mounted ? getMetricsCreds() : { provider: "ahrefs" as const, apiKey: "", baseUrl: "", cap: 0 };
  const hasKey = creds.apiKey.length > 4;

  const body = useCallback((doFetch: boolean) => ({
    scope, tag: scope === "tag" ? tag : undefined,
    withDifficulty: withKd,
    provider: creds.provider,
    fetch: doFetch,
    ...(doFetch ? { apiKey: creds.apiKey, baseUrl: creds.baseUrl, cap: creds.cap } : {}),
  }), [scope, tag, withKd, creds]);

  async function post(doFetch: boolean) {
    const res = await fetch("/api/metrics/warmup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body(doFetch)),
    });
    const d = await res.json().catch(() => ({}));
    return { ok: res.ok, d } as { ok: boolean; d: Summary & { error?: string; wouldSpend?: number } };
  }

  async function count() {
    setCounting(true); setNotice(""); setSummary(null);
    try {
      const { d } = await post(false);
      setSummary(d);
      // "no_key" on the counting pass is not a failure: counting is free and worth seeing before
      // a key is configured at all.
      if (d.error && d.error !== "no_key") setNotice(errorText(d.error));
    } catch { setNotice(t("warmupErrGeneric")); }
    setCounting(false);
  }

  async function run() {
    setRunning(true); setNotice("");
    try {
      const { ok, d } = await post(true);
      setSummary(d);
      if (!ok || d.error) setNotice(errorText(d.error ?? "error", d.wouldSpend));
      else setNotice(t("warmupDone").replace("{n}", String(d.fetched ?? 0)));
    } catch { setNotice(t("warmupErrGeneric")); }
    setRunning(false);
  }

  function saveAuto(enabled: boolean, cap: string) {
    const payload = { enabled, cap: Number(cap) || 50000, withDifficulty: withKd, lastRunAt: null };
    // Written to localStorage only. `SeoKeysSync` mirrors this key to the server on its own —
    // hand-rolling a second write here would race with it and, since that endpoint takes a whole
    // snapshot rather than a patch, could overwrite everything else with a one-key object.
    localStorage.setItem("seoWarmupSchedule", JSON.stringify(payload));
    setAutoSaved(true); setTimeout(() => setAutoSaved(false), 1500);
  }

  function errorText(code: string, wouldSpend?: number): string {
    if (code === "no_key") return t("warmupErrNoKey");
    if (code === "no_sites") return t("warmupErrNoSites");
    if (code === "cap_exceeded") return t("warmupErrCap").replace("{n}", String(wouldSpend ?? 0));
    return code;
  }

  const missing = summary?.markets.reduce((n, m) => n + m.missing, 0) ?? 0;
  const cached = (summary?.totalQueries ?? 0) - missing;
  const usd = summary ? estimateCostUsd(summary.units, creds.provider) : 0;

  return (
    <div className="panel">
      <div style={{ display: "flex", alignItems: "center", gap: "9px", marginBottom: "4px" }}>
        <Flame size={17} color="var(--color-accent-orange)" />
        <h3 style={{ fontSize: "15px", fontWeight: 700, margin: 0, color: "var(--color-text-primary)" }}>{t("warmupTitle")}</h3>
      </div>
      <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 14px", lineHeight: 1.55, maxWidth: "620px" }}>
        {t("warmupSub")}
      </p>

      <span className="tool-section-label">{t("warmupScope")}</span>
      <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", flexWrap: "wrap", marginBottom: "12px" }}>
        <div style={{ maxWidth: "200px" }}>
          <span className="tool-field-label">{t("warmupScopeLabel")}</span>
          <select className="tool-input" value={scope} onChange={e => { setScope(e.target.value as Scope); setSummary(null); }}>
            <option value="all">{t("warmupScopeAll")}</option>
            <option value="tag">{t("warmupScopeTag")}</option>
          </select>
        </div>
        {scope === "tag" && (
          <div style={{ maxWidth: "200px" }}>
            <span className="tool-field-label">{t("warmupTag")}</span>
            <select className="tool-input" value={tag} onChange={e => { setTag(e.target.value); setSummary(null); }}>
              <option value="">{t("warmupTagPick")}</option>
              {tags.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12px", color: "var(--color-text-secondary)", paddingBottom: "9px", cursor: "pointer" }}>
          <input type="checkbox" checked={withKd} onChange={e => { setWithKd(e.target.checked); setMetricsWithKd(e.target.checked); setSummary(null); }} />
          {t("warmupWithKd")}
        </label>
        <button
          onClick={count}
          disabled={counting || running || (scope === "tag" && !tag)}
          style={btn(counting || running || (scope === "tag" && !tag), "var(--color-accent-blue)")}
        >
          {counting ? <><Loader2 size={13} className="spin" /> {t("warmupCounting")}</> : t("warmupCount")}
        </button>
      </div>

      {summary && (
        <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: "12px" }}>
          <div style={{ display: "flex", gap: "22px", flexWrap: "wrap", fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "10px" }}>
            <span>{t("warmupSites")}: <strong style={{ color: "var(--color-text-primary)" }}>{summary.sitesScanned}</strong></span>
            <span>{t("warmupQueries")}: <strong style={{ color: "var(--color-text-primary)" }}>{summary.totalQueries.toLocaleString()}</strong></span>
            <span>{t("warmupCached")}: <strong style={{ color: "#10B981" }}>{cached.toLocaleString()}</strong></span>
            <span>{t("warmupMissing")}: <strong style={{ color: "var(--color-accent-orange)" }}>{missing.toLocaleString()}</strong></span>
          </div>

          {summary.markets.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginBottom: "10px", maxHeight: "180px", overflow: "auto" }}>
              <div style={{ display: "grid", gridTemplateColumns: "70px 1fr 1fr 1fr", gap: "8px", fontSize: "10px", fontWeight: 700, color: "var(--color-text-tertiary)", textTransform: "uppercase", padding: "4px 0", borderBottom: "1px solid var(--color-border)" }}>
                <span>{t("warmupMarket")}</span>
                <span style={{ textAlign: "right" }}>{t("warmupQueries")}</span>
                <span style={{ textAlign: "right" }}>{t("warmupMissing")}</span>
                <span style={{ textAlign: "right" }}>{t("metricsUnits")}</span>
              </div>
              {summary.markets.map(m => (
                <div key={m.country} style={{ display: "grid", gridTemplateColumns: "70px 1fr 1fr 1fr", gap: "8px", fontSize: "12px", padding: "4px 0", color: "var(--color-text-secondary)" }}>
                  <span style={{ color: "var(--color-text-primary)", fontWeight: 600, textTransform: "uppercase" }}>{m.country}</span>
                  <span style={{ textAlign: "right" }}>{m.total.toLocaleString()}</span>
                  <span style={{ textAlign: "right", color: m.missing ? "var(--color-accent-orange)" : "#10B981" }}>{m.missing.toLocaleString()}</span>
                  <span style={{ textAlign: "right" }}>{m.units.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}

          {summary.skippedSites.length > 0 && (
            <div style={{ padding: "9px 11px", borderRadius: "9px", border: "1px solid rgba(245,158,11,0.28)", background: "rgba(245,158,11,0.08)", display: "flex", gap: "9px", alignItems: "flex-start", marginBottom: "10px" }}>
              <AlertTriangle size={14} color="#f59e0b" style={{ flexShrink: 0, marginTop: "2px" }} />
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.55 }}>
                <strong style={{ color: "var(--color-text-primary)" }}>{t("warmupSkipped").replace("{n}", String(summary.skippedSites.length))}</strong>
                <div style={{ marginTop: "3px" }}>{t("warmupSkippedHint")}</div>
                <div style={{ marginTop: "4px", color: "var(--color-text-tertiary)" }}>{summary.skippedSites.slice(0, 12).join(", ")}{summary.skippedSites.length > 12 ? " …" : ""}</div>
              </div>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <button
              onClick={run}
              disabled={running || !missing || !hasKey}
              style={btn(running || !missing || !hasKey, "var(--color-accent-orange)")}
            >
              {running ? <><Loader2 size={13} className="spin" /> {t("warmupRunning")}</> : t("warmupRun")}
            </button>
            <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
              {summary.units.toLocaleString()} {t("metricsUnits")} · <strong style={{ color: "var(--color-text-primary)" }}>≈ {formatUsd(usd)}</strong>
            </span>
            {!hasKey && <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{t("warmupErrNoKey")}</span>}
          </div>
        </div>
      )}

      {/* Scheduled warm-up. Off by default and capped separately: this is the one thing in the
          app that can spend credits with nobody watching, so it asks for its own budget rather
          than quietly sharing the one a human is standing in front of. */}
      <div style={{ borderTop: "1px solid var(--color-border)", marginTop: "14px", paddingTop: "12px" }}>
        <span className="tool-section-label">{t("warmupAutoTitle")}</span>
        <div style={{ display: "flex", gap: "16px", alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12px", color: "var(--color-text-secondary)", paddingBottom: "9px", cursor: "pointer" }}>
            <input type="checkbox" checked={autoOn} onChange={e => { setAutoOn(e.target.checked); saveAuto(e.target.checked, autoCap); }} />
            {t("warmupAutoEnable")}
          </label>
          <div style={{ maxWidth: "180px" }}>
            <span className="tool-field-label">{t("warmupAutoCap")}</span>
            <input className="tool-input" value={autoCap} inputMode="numeric"
              onChange={e => setAutoCap(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={() => saveAuto(autoOn, autoCap)} />
          </div>
          {autoSaved && <span style={{ fontSize: "11px", color: "#10B981", paddingBottom: "9px" }}>✓</span>}
        </div>
        <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "6px", lineHeight: 1.55, maxWidth: "620px" }}>
          {t("warmupAutoHint")}
        </div>
      </div>

      {notice && (
        <div style={{ marginTop: "10px", fontSize: "12px", color: "var(--color-text-secondary)" }}>{notice}</div>
      )}
    </div>
  );
}

function btn(disabled: boolean, color: string): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", gap: "6px",
    padding: "9px 15px", borderRadius: "9px", border: "none",
    background: disabled ? "rgba(255,255,255,0.06)" : color,
    color: disabled ? "var(--color-text-secondary)" : "#fff",
    fontSize: "13px", fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
  };
}
