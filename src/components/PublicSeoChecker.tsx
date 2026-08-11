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
    <style jsx global>{`
      .public-check-page{min-height:100vh;background:var(--color-bg);color:var(--color-text-primary);}
      .public-check-header{height:64px;padding:0 clamp(16px,4vw,52px);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--color-border);background:color-mix(in srgb,var(--color-card) 88%,transparent);gap:14px;}
      .public-check-brand{display:flex;align-items:center;gap:9px;color:var(--color-text-primary);text-decoration:none;font-size:17px;font-weight:800;}
      .public-check-controls{display:flex;align-items:center;gap:8px}.public-check-langs{display:flex;border:1px solid var(--color-border);border-radius:8px;overflow:hidden}.public-check-langs button{border:0;background:transparent;color:var(--color-text-secondary);font-size:10px;font-weight:700;text-transform:uppercase;padding:6px 7px;cursor:pointer}.public-check-langs button.active{background:var(--color-accent-purple);color:#fff}.icon-control{display:flex;padding:7px;border:1px solid var(--color-border);border-radius:8px;background:var(--color-card);color:var(--color-text-secondary);cursor:pointer}.login-link{font-size:12px;font-weight:700;text-decoration:none;color:#fff;background:var(--color-accent-blue);padding:8px 12px;border-radius:8px}
      .public-check-main{width:min(1080px,calc(100% - 32px));margin:0 auto;padding:clamp(44px,7vw,84px) 0 60px}.public-check-hero{text-align:center;display:flex;align-items:center;flex-direction:column}.public-check-kicker{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:20px;background:rgba(41,151,255,.1);color:var(--color-accent-blue);font-size:11px;font-weight:750}.public-check-hero h1{font-size:clamp(34px,5vw,58px);letter-spacing:-.04em;line-height:1.04;max-width:850px;margin:18px 0 14px}.public-check-hero>p{max-width:720px;font-size:clamp(14px,2vw,18px);line-height:1.6;color:var(--color-text-secondary);margin:0}
      .public-check-form{width:min(760px,100%);display:flex;align-items:center;gap:10px;margin:28px 0 12px;padding:7px 7px 7px 15px;border:1px solid var(--color-border);border-radius:14px;background:var(--color-card);box-shadow:0 14px 45px rgba(0,0,0,.08)}.public-check-form>svg{color:var(--color-text-tertiary);flex-shrink:0}.public-check-form input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--color-text-primary);font-size:15px}.public-check-form button{display:flex;align-items:center;gap:7px;border:0;border-radius:9px;padding:11px 17px;background:var(--color-accent-blue);color:#fff;font-weight:750;cursor:pointer;white-space:nowrap}.public-check-form button:disabled{opacity:.5;cursor:not-allowed}.turnstile-slot{min-height:1px;margin:2px auto 8px}.public-check-trust{display:flex;gap:18px;flex-wrap:wrap;justify-content:center;color:var(--color-text-tertiary);font-size:11px}.public-check-trust span{display:flex;align-items:center;gap:5px}.public-check-error{display:flex;align-items:center;gap:8px;margin-top:18px;color:var(--color-accent-red);background:rgba(255,69,58,.08);border:1px solid rgba(255,69,58,.25);padding:10px 13px;border-radius:9px;font-size:12px}
      .public-check-scope{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:56px}.public-check-scope div{display:flex;flex-direction:column;gap:10px;padding:18px;border:1px solid var(--color-border);border-radius:12px;background:var(--color-card);font-size:12px}.public-check-scope span{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:9px;background:rgba(94,92,230,.1);color:var(--color-accent-purple)}.public-check-scope svg{width:16px}.public-check-loading{display:flex;flex-direction:column;align-items:center;gap:9px;padding:70px 10px;color:var(--color-accent-blue)}.public-check-loading span{font-size:12px;color:var(--color-text-secondary)}
      .public-report{margin-top:48px;display:flex;flex-direction:column;gap:14px}.public-report-head{display:grid;grid-template-columns:220px 1fr;gap:14px}.public-score-card,.public-overview,.public-finding,.public-pass-card,.public-cta{border:1px solid var(--color-border);border-radius:14px;background:var(--color-card)}.public-score-card{padding:22px;display:flex;flex-direction:column;align-items:center;text-align:center}.public-score-ring{width:120px;height:120px;border-radius:50%;display:grid;place-items:center;position:relative}.public-score-ring:after{content:"";position:absolute;inset:10px;border-radius:50%;background:var(--color-card)}.public-score-ring b{z-index:1;font-size:32px}.public-score-card>span{font-size:11px;color:var(--color-text-secondary);margin-top:10px}.public-overview{padding:20px}.public-overview-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.public-overview h2{font-size:18px;margin:0 0 5px;word-break:break-word}.public-overview a{font-size:12px;color:var(--color-accent-blue);text-decoration:none}.public-overview-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:18px}.fact{padding:10px;border-radius:9px;background:var(--color-bg);font-size:11px;color:var(--color-text-secondary)}.fact b{display:block;color:var(--color-text-primary);font-size:14px;margin-bottom:3px}.cached{font-size:10px;color:var(--color-accent-green);padding:4px 8px;border-radius:20px;background:rgba(52,199,89,.1);white-space:nowrap}
      .public-findings-title{display:flex;align-items:center;justify-content:space-between;margin:10px 1px 0}.public-findings-title h2{font-size:17px;margin:0}.public-findings-title span{font-size:11px;color:var(--color-text-tertiary)}.public-finding{padding:17px;display:grid;grid-template-columns:24px minmax(150px,.8fr) minmax(230px,1.5fr);gap:13px;align-items:start}.public-finding-icon{padding-top:2px}.public-finding h3{font-size:13px;margin:0 0 5px}.severity-chip{display:inline-flex;padding:3px 7px;border-radius:20px;font-size:9px;font-weight:800;text-transform:uppercase}.evidence{font-size:10px;color:var(--color-text-tertiary);word-break:break-word}.public-finding-copy{display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:11px;line-height:1.5;color:var(--color-text-secondary)}.public-finding-copy b{display:block;color:var(--color-text-primary);font-size:10px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}.public-pass-card{padding:18px;display:flex;align-items:center;gap:10px;color:var(--color-accent-green);font-size:13px}.public-cta{padding:24px;display:flex;align-items:center;justify-content:space-between;gap:18px;background:linear-gradient(125deg,rgba(41,151,255,.09),rgba(191,90,242,.08))}.public-cta h2{font-size:18px;margin:0 0 5px}.public-cta p{font-size:12px;color:var(--color-text-secondary);margin:0;line-height:1.5}.public-cta a{display:flex;align-items:center;gap:7px;padding:10px 14px;background:var(--color-accent-blue);color:#fff;border-radius:9px;text-decoration:none;font-size:12px;font-weight:750;white-space:nowrap}.again-button{display:flex;align-items:center;gap:6px;border:1px solid var(--color-border);background:var(--color-bg);color:var(--color-text-secondary);padding:7px 10px;border-radius:8px;font-size:11px;cursor:pointer}.public-check-privacy{margin:42px auto 0;max-width:800px;display:flex;gap:8px;align-items:flex-start;font-size:11px;line-height:1.55;color:var(--color-text-tertiary)}.public-check-privacy svg{flex-shrink:0;margin-top:1px}
      @media(max-width:760px){.public-check-header{height:auto;min-height:62px;padding-top:10px;padding-bottom:10px}.public-check-controls{flex-wrap:wrap;justify-content:flex-end}.public-check-langs{order:3}.public-check-scope{grid-template-columns:repeat(2,1fr)}.public-report-head{grid-template-columns:1fr}.public-overview-grid{grid-template-columns:repeat(2,1fr)}.public-finding{grid-template-columns:24px 1fr}.public-finding-copy{grid-column:2;grid-template-columns:1fr}.public-cta{align-items:flex-start;flex-direction:column}.public-check-form{flex-wrap:wrap}.public-check-form input{min-height:40px}.public-check-form button{width:100%}.login-link{display:none}}
    `}</style>
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
