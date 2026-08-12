"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowRight, CheckCircle2, Clock3, ExternalLink, Gauge, Globe2,
  Info, Loader2, LockKeyhole, Moon, RefreshCw, Search, Server, ShieldCheck, Sun, XCircle,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { useTheme } from "@/lib/ThemeContext";

type Severity = "critical" | "warning" | "info";
type Finding = { id: string; severity: Severity; category: string; titleKey: string; evidence?: string };
type Result = {
  requestedUrl: string; finalUrl: string; checkedAt: string; score: number; passed: number; available: number;
  cached: boolean; findings: Finding[];
  facts: {
    status: number; contentType: string; loadMs: number; bytes: number; redirected: boolean; https: boolean;
    certificateDaysRemaining: number | null; title: string; titleLength: number; descriptionLength: number;
    h1Count: number; canonical: boolean; indexable: boolean | null; schemaBlocks: number;
    openGraphMissing: number; imagesNoAlt: number; wordCount: number; missingSecurityHeaders: string[];
    webVitals: "unavailable";
  };
};

declare global { interface Window { turnstile?: { render: (el: HTMLElement, options: Record<string, unknown>) => string; reset: (id: string) => void; remove: (id: string) => void }; } }

const LANGS = ["en", "ru", "uk", "fr", "es", "de", "zh"] as const;
const COLORS: Record<Severity, string> = { critical: "#ff453a", warning: "#ff9f0a", info: "#2997ff" };
const IMPACT: Record<string, string> = {
  crawlability: "publicCheckImpactCrawlability", metadata: "publicCheckImpactMetadata",
  content: "publicCheckImpactContent", performance: "publicCheckImpactPerformance",
  rendering: "publicCheckImpactRendering", security: "publicCheckImpactSecurity", links: "publicCheckImpactLinks",
};
const ACTION: Record<string, string> = {
  crawlability: "publicCheckActionCrawlability", metadata: "publicCheckActionMetadata",
  content: "publicCheckActionContent", performance: "publicCheckActionPerformance",
  rendering: "publicCheckActionRendering", security: "publicCheckActionSecurity", links: "publicCheckActionLinks",
};

export default function PublicSeoChecker({ turnstileSiteKey }: { turnstileSiteKey: string }) {
  const { t, language, setLanguage } = useLanguage();
  const { dark, setDark } = useTheme();
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef("");

  useEffect(() => {
    if (!turnstileSiteKey || !turnstileRef.current) return;
    let cancelled = false;
    const render = () => {
      if (cancelled || !window.turnstile || !turnstileRef.current || widgetId.current) return;
      widgetId.current = window.turnstile.render(turnstileRef.current, {
        sitekey: turnstileSiteKey,
        theme: dark ? "dark" : "light",
        callback: (token: string) => setTurnstileToken(token),
        "expired-callback": () => setTurnstileToken(""),
        "error-callback": () => setTurnstileToken(""),
      });
    };
    const existing = document.getElementById("opengsc-turnstile") as HTMLScriptElement | null;
    if (existing) { if (window.turnstile) render(); else existing.addEventListener("load", render, { once: true }); }
    else {
      const script = document.createElement("script"); script.id = "opengsc-turnstile";
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; script.async = true; script.defer = true;
      script.addEventListener("load", render, { once: true }); document.head.appendChild(script);
    }
    return () => { cancelled = true; if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current); widgetId.current = ""; };
  }, [turnstileSiteKey, dark]);

  const errorText = useMemo(() => {
    const keys: Record<string, string> = {
      invalid_url: "publicCheckErrorUrl", unsupported_protocol: "publicCheckErrorUrl",
      credentials_not_allowed: "publicCheckErrorUrl", private_address: "publicCheckErrorPrivate",
      rate_limited: "publicCheckErrorRate", turnstile_required: "publicCheckErrorCaptcha",
      request_timeout: "publicCheckErrorTimeout", dns_failed: "publicCheckErrorDns",
      network_error: "publicCheckErrorNetwork", response_too_large: "publicCheckErrorLarge",
      request_too_large: "publicCheckErrorRequest",
    };
    return error ? t((keys[error] || "publicCheckErrorGeneric") as any) : "";
  }, [error, t]);

  function resetCaptcha() {
    setTurnstileToken("");
    if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
  }

  async function check(event?: React.FormEvent) {
    event?.preventDefault();
    if (!url.trim() || (turnstileSiteKey && !turnstileToken)) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const res = await fetch("/api/public/seo-check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, turnstileToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || "check_failed"));
      setResult(data);
    } catch (e) { setError(e instanceof Error ? e.message : "check_failed"); }
    finally { setBusy(false); resetCaptcha(); }
  }

  return <div className="public-check-page">
    <header className="public-check-header">
      <Link href="/free-seo-checker" className="public-check-brand"><img src="/favicon.svg" alt="" width={30} height={30} /><span>OpenGSC</span></Link>
      <div className="public-check-controls">
        <div className="public-check-langs">{LANGS.map(lang => <button key={lang} onClick={() => setLanguage(lang)} className={language === lang ? "active" : ""}>{lang}</button>)}</div>
        <button className="icon-control" onClick={() => setDark(!dark)} aria-label={dark ? "Light" : "Dark"}>{dark ? <Sun size={15} /> : <Moon size={15} />}</button>
        <Link href="/login" className="login-link">{t("publicCheckLogin" as any)}</Link>
      </div>
    </header>

    <main className="public-check-main">
      <section className="public-check-hero">
        <span className="public-check-kicker"><ShieldCheck size={14} /> {t("publicCheckKicker" as any)}</span>
        <h1>{t("publicCheckTitle" as any)}</h1>
        <p>{t("publicCheckSubtitle" as any)}</p>
        <form onSubmit={check} className="public-check-form">
          <Globe2 size={19} />
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder={t("publicCheckPlaceholder" as any)} aria-label={t("publicCheckPlaceholder" as any)} maxLength={500} />
          <button disabled={busy || !url.trim() || (!!turnstileSiteKey && !turnstileToken)}>{busy ? <Loader2 className="spin" size={17} /> : <Search size={17} />} {t("publicCheckButton" as any)}</button>
        </form>
        {turnstileSiteKey && <div ref={turnstileRef} className="turnstile-slot" />}
        <div className="public-check-trust"><span><LockKeyhole size={13} /> {t("publicCheckNoLogin" as any)}</span><span><Server size={13} /> {t("publicCheckNoKeys" as any)}</span><span><Clock3 size={13} /> {t("publicCheckRetentionShort" as any)}</span></div>
        {errorText && <div className="public-check-error"><AlertTriangle size={16} /> {errorText}</div>}
      </section>

      {!result && !busy && <section className="public-check-scope">
        {["publicCheckScopeHttps", "publicCheckScopeIndex", "publicCheckScopeMeta", "publicCheckScopeSecurity", "publicCheckScopePerformance"].map((key, i) => <div key={key}><span>{[<LockKeyhole key="a" />, <Search key="b" />, <Globe2 key="c" />, <ShieldCheck key="d" />, <Gauge key="e" />][i]}</span><b>{t(key as any)}</b></div>)}
      </section>}

      {busy && <div className="public-check-loading"><Loader2 className="spin" size={28} /><b>{t("publicCheckRunning" as any)}</b><span>{t("publicCheckRunningHint" as any)}</span></div>}

      {result && <Report result={result} t={t as any} onAgain={() => { setResult(null); setError(""); }} />}

      <section className="public-check-privacy">
        <Info size={16} /> <span>{t("publicCheckPrivacy" as any)}</span>
      </section>
    </main>

  </div>;
}

function Report({ result, t, onAgain }: { result: Result; t: (key: string) => string; onAgain: () => void }) {
  const scoreColor = result.score >= 85 ? "#34c759" : result.score >= 65 ? "#ff9f0a" : "#ff453a";
  const bytes = result.facts.bytes >= 1024 ? `${Math.round(result.facts.bytes / 1024)} KB` : `${result.facts.bytes} B`;
  return <section className="public-report" aria-live="polite">
    <div className="public-report-head">
      <div className="public-score-card"><div className="public-score-ring" style={{ background: `conic-gradient(${scoreColor} ${result.score * 3.6}deg,var(--color-border) 0)` }}><b>{result.score}</b></div><span>{t("publicCheckPassed").replace("{a}", String(result.passed)).replace("{b}", String(result.available))}</span></div>
      <div className="public-overview"><div className="public-overview-top"><div><h2>{new URL(result.finalUrl).hostname}</h2><a href={result.finalUrl} target="_blank" rel="noopener noreferrer">{result.finalUrl} <ExternalLink size={11} style={{ display: "inline" }} /></a></div><div style={{ display: "flex", gap: 7, alignItems: "center" }}>{result.cached && <span className="cached">{t("publicCheckCached")}</span>}<button className="again-button" onClick={onAgain}><RefreshCw size={12} /> {t("publicCheckAgain")}</button></div></div><div className="public-overview-grid"><Fact label="HTTP" value={String(result.facts.status)} /><Fact label="HTTPS" value={result.facts.https ? t("publicCheckYes") : t("publicCheckNo")} /><Fact label={t("publicCheckResponse")} value={result.facts.loadMs ? `${result.facts.loadMs} ms` : t("publicCheckUnavailable")} /><Fact label={t("publicCheckHtmlSize")} value={bytes} /><Fact label="Title" value={String(result.facts.titleLength)} /><Fact label="H1" value={String(result.facts.h1Count)} /><Fact label="JSON-LD" value={String(result.facts.schemaBlocks)} /><Fact label={t("publicCheckIndexable")} value={result.facts.indexable == null ? t("publicCheckUnavailable") : result.facts.indexable ? t("publicCheckYes") : t("publicCheckNo")} /></div></div>
    </div>
    <div className="public-findings-title"><h2>{t("publicCheckFindings")}</h2><span>{new Date(result.checkedAt).toLocaleString()}</span></div>
    {!result.findings.length && <div className="public-pass-card"><CheckCircle2 size={19} /> {t("publicCheckNoFindings")}</div>}
    {result.findings.map(item => <FindingCard key={item.id} item={item} t={t} />)}
    <div className="public-pass-card" style={{ color: "var(--color-text-secondary)" }}><Info size={18} color="var(--color-accent-blue)" /> {t("publicCheckWebVitalsUnavailable")}</div>
    <div className="public-cta"><div><h2>{t("publicCheckCtaTitle")}</h2><p>{t("publicCheckCtaText")}</p></div><Link href="/login">{t("publicCheckCtaButton")} <ArrowRight size={14} /></Link></div>
  </section>;
}

function Fact({ label, value }: { label: string; value: string }) { return <div className="fact"><b>{value}</b>{label}</div>; }
function FindingCard({ item, t }: { item: Finding; t: (key: string) => string }) {
  const color = COLORS[item.severity];
  return <article className="public-finding"><div className="public-finding-icon">{item.severity === "critical" ? <XCircle size={18} color={color} /> : item.severity === "warning" ? <AlertTriangle size={18} color={color} /> : <Info size={18} color={color} />}</div><div><span className="severity-chip" style={{ color, background: `${color}17` }}>{t(`publicCheckSeverity${item.severity[0].toUpperCase()}${item.severity.slice(1)}`)}</span><h3 style={{ marginTop: 8 }}>{t(item.titleKey)}</h3>{item.evidence && <span className="evidence">{item.evidence}</span>}</div><div className="public-finding-copy"><span><b>{t("publicCheckImpact")}</b>{t(IMPACT[item.category] || "publicCheckImpactGeneric")}</span><span><b>{t("publicCheckAction")}</b>{t(ACTION[item.category] || "publicCheckActionGeneric")}</span></div></article>;
}
