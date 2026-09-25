"use client";

// N9 — the PUBLIC embeddable audit widget (no app shell: DashboardShell renders /embed
// without chrome). Everything here is visitor-facing: the domain field, the score ring,
// the top-5 problems WITHOUT the fixes (those come with the full report), and the lead
// form. The page itself holds no secrets — the widget key is a public id by design.
//
// Accent colour / logo come from the owner's widget settings (GET /api/public/audit);
// the language comes from ?lang=xx with a browser-language fallback; the theme follows
// prefers-color-scheme. Height changes are announced to the embedding page via
// postMessage so the iframe can auto-resize (snippet in docs/LEADS.md).

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LEAD_STRINGS, t2 } from "@/lib/leads/i18n";
import type { FindingSeverity, LeadLang, PublicWidgetConfig } from "@/lib/leads/types";

const KNOWN_LANGS: LeadLang[] = ["en", "ru", "uk", "fr", "es", "de", "zh"];

interface PublicFinding {
  code: string;
  severity: FindingSeverity;
  title: string;
  evidence: string;
}

/** Thin POST wrappers: short error codes only, exactly what the public API answers with. */
async function postJson(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw Object.assign(new Error(String(data.error ?? "server")), { code: String(data.error ?? "server") });
  return data;
}

const CONTROLS = `
.ogsc-w { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 720px; min-width: 320px; margin: 0 auto; padding: 18px; border-radius: 14px; border: 1px solid rgba(0,0,0,.09); background: #fff; color: #111827; }
.ogsc-w * { box-sizing: border-box; }
.ogsc-w input, .ogsc-w textarea { width: 100%; padding: 10px 12px; border-radius: 9px; border: 1px solid rgba(0,0,0,.18); background: #fff; color: #111827; font-size: 14px; outline: none; }
.ogsc-w input:focus, .ogsc-w textarea:focus { border-color: var(--ogsc-accent); }
.ogsc-w button { width: 100%; padding: 11px 14px; border: none; border-radius: 9px; background: var(--ogsc-accent); color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; }
.ogsc-w button:disabled { opacity: .55; cursor: default; }
.ogsc-w .muted { color: #6b7280; font-size: 12px; }
.ogsc-w label { display: block; font-size: 12px; margin: 10px 0 4px; color: #374151; }
@media (prefers-color-scheme: dark) {
  .ogsc-w { background: #111827; color: #f3f4f6; border-color: rgba(255,255,255,.12); }
  .ogsc-w input, .ogsc-w textarea { background: #1f2937; color: #f3f4f6; border-color: rgba(255,255,255,.2); }
  .ogsc-w label { color: #d1d5db; }
  .ogsc-w .muted { color: #9ca3af; }
}
`;

function ScoreRing({ score }: { score: number }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(100, score)) / 100);
  const color = score >= 80 ? "#10B981" : score >= 50 ? "#F59E0B" : "#EF4444";
  return (
    <div style={{ position: "relative", width: 128, height: 128, margin: "6px auto 10px" }} role="img" aria-label={`${score}/100`}>
      <svg width={128} height={128} viewBox="0 0 128 128">
        <circle cx={64} cy={64} r={radius} fill="none" stroke="rgba(128,128,128,.22)" strokeWidth={10} />
        <circle
          cx={64} cy={64} r={radius} fill="none" stroke={color} strokeWidth={10} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset .9s ease", transform: "rotate(-90deg)", transformOrigin: "center" }}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontSize: 30, fontWeight: 800 }}>{score}</div>
        <div className="muted" style={{ fontSize: 11 }}>/100</div>
      </div>
    </div>
  );
}

interface TurnstileGlobal {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
}

function WidgetInner() {
  const params = useSearchParams();
  const key = params.get("key") ?? "";

  // Language: ?lang= wins, then the browser's, then English — decided during the first
  // render (no sync setState in an effect; the widget never re-picks mid-session).
  const [lang] = useState<LeadLang>(() => {
    const param = params.get("lang");
    const nav = typeof navigator !== "undefined" ? (navigator.language || "en").split("-")[0] : "en";
    const pick = [param, nav].find(l => l && KNOWN_LANGS.includes(l as LeadLang));
    return (pick as LeadLang) ?? "en";
  });
  const W = LEAD_STRINGS[lang].widget;
  const tr = useCallback((k: string) => t2(lang, k), [lang]);

  const [config, setConfig] = useState<PublicWidgetConfig | null>(null);
  const [domain, setDomain] = useState("");
  const [phase, setPhase] = useState<"loading" | "input" | "checking" | "result" | "sending" | "done" | "off">("loading");
  const [error, setError] = useState("");
  const [score, setScore] = useState(0);
  const [findings, setFindings] = useState<PublicFinding[]>([]);
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [consent, setConsent] = useState(false);
  const [emailed, setEmailed] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");
  const captchaHostRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // No key → the render below shows the silent "off" box (config stays null); there is
    // nothing to fetch and no synchronous setState to trip over.
    if (!key) return;
    let cancelled = false;
    fetch(`/api/public/audit?key=${encodeURIComponent(key)}&lang=${lang}`)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error("off"))))
      .then((cfg: PublicWidgetConfig) => { if (!cancelled) { setConfig(cfg); setPhase(cfg.enabled ? "input" : "off"); } })
      .catch(() => { if (!cancelled) setPhase("off"); });
    return () => { cancelled = true; };
  }, [key, lang]);

  // Auto-height for the embedding page (docs/LEADS.md snippet listens for this).
  useEffect(() => {
    const post = () => {
      const height = rootRef.current?.scrollHeight ?? document.body.scrollHeight;
      if (window.parent !== window) window.parent.postMessage({ type: "opengsc:widget:height", height }, "*");
    };
    post();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(post);
    if (rootRef.current) observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, [phase, findings.length]);

  // Turnstile: loaded only when the owner configured keys, rendered into a host div.
  useEffect(() => {
    if (!config?.captcha?.enabled || !config.captcha.siteKey || phase !== "input") return;
    const siteKey = config.captcha.siteKey;
    let widgetId = "";
    const render = () => {
      const global = (window as unknown as { turnstile?: TurnstileGlobal }).turnstile;
      if (global && captchaHostRef.current && !widgetId && !captchaHostRef.current.hasChildNodes()) {
        widgetId = global.render(captchaHostRef.current, {
          sitekey: siteKey,
          callback: (t: string) => setCaptchaToken(t),
          "expired-callback": () => setCaptchaToken(""),
          "error-callback": () => setCaptchaToken(""),
        });
      }
    };
    if ((window as unknown as { turnstile?: unknown }).turnstile) { render(); return; }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = render;
    document.head.appendChild(script);
  }, [config, phase]);

  const accent = config?.accentColor || "#3B82F6";
  const consentText = config?.consentText || LEAD_STRINGS[lang].consent;

  const check = async () => {
    if (phase === "checking") return;
    setError("");
    setPhase("checking");
    try {
      const data = await postJson("/api/public/audit", { key, domain, lang, captchaToken });
      setScore(Number(data.score ?? 0));
      setFindings(Array.isArray(data.findings) ? (data.findings as PublicFinding[]) : []);
      setToken(String(data.token ?? ""));
      setPhase("result");
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "rate_limited") setError(tr("leadEmbedRateLimit"));
      else setError(W.error);
      setPhase("input");
    }
  };

  const send = async () => {
    if (!email.trim()) { setError(W.needEmail); return; }
    if (!consent) { setError(consentText); return; }
    setError("");
    setPhase("sending");
    try {
      const data = await postJson("/api/public/lead", { key, token, email, name, message, lang, consent: true });
      setEmailed(data.emailed === true);
      setPhase("done");
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "rate_limited") setError(tr("leadEmbedRateLimit"));
      else setError(W.error);
      setPhase("result");
    }
  };

  const severityDot = (severity: FindingSeverity) =>
    severity === "critical" ? "#EF4444" : severity === "warning" ? "#F59E0B" : "#3B82F6";

  const title = useMemo(() => tr("leadEmbedTitle"), [tr]);

  if (phase === "loading") {
    return <div ref={rootRef} style={{ padding: 24 }}><span className="muted">…</span></div>;
  }
  if (phase === "off" || !config) {
    // Unknown key or disabled widget: nothing to interact with, nothing to enumerate.
    return <div ref={rootRef} style={{ padding: 12 }} />;
  }

  return (
    <div ref={rootRef} className="ogsc-w" style={{ ["--ogsc-accent" as string]: accent }}>
      <style dangerouslySetInnerHTML={{ __html: CONTROLS }} />
      {config.logoUrl
        // eslint-disable-next-line @next/next/no-img-element -- the owner's arbitrary logo URL inside an iframe outside the app shell; next/image brings nothing here
        ? <img src={config.logoUrl} alt="" style={{ maxHeight: 40, maxWidth: 160, objectFit: "contain", marginBottom: 6 }} />
        : null}
      <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 4 }}>{title}</div>

      {phase === "input" || phase === "checking" ? (
        <>
          <label htmlFor="ogsc-domain">{tr("leadEmbedDomain")}</label>
          <input
            id="ogsc-domain"
            value={domain}
            onChange={e => setDomain(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") check(); }}
            placeholder="example.com"
            disabled={phase === "checking"}
            autoComplete="url"
          />
          <div style={{ height: 10 }} />
          <div ref={captchaHostRef} />
          <button onClick={check} disabled={phase === "checking" || (config.captcha.enabled && !captchaToken)}>
            {phase === "checking" ? W.checking : tr("leadEmbedRun")}
          </button>
        </>
      ) : null}

      {phase === "result" || phase === "sending" || phase === "done" ? (
        <>
          <ScoreRing score={score} />
          <div style={{ textAlign: "center", fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
            {tr("leadEmbedScore").replace("{n}", String(score))}
          </div>
          {findings.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 14 }}>
              {findings.map(f => (
                <div key={f.code} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                  <span aria-hidden style={{ flex: "0 0 auto", width: 8, height: 8, borderRadius: 99, marginTop: 5, background: severityDot(f.severity) }} />
                  <span>
                    <span style={{ fontWeight: 600 }}>{f.title}</span>
                    {f.evidence ? <span className="muted"> · {f.evidence}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {phase !== "done" ? (
            <>
              <label htmlFor="ogsc-email" style={{ fontWeight: 700 }}>{tr("leadEmbedEmail")} *</label>
              <input id="ogsc-email" type="email" value={email} onChange={e => setEmail(e.target.value)} disabled={phase === "sending"} autoComplete="email" />
              <label htmlFor="ogsc-name">{W.nameField}</label>
              <input id="ogsc-name" value={name} onChange={e => setName(e.target.value)} disabled={phase === "sending"} autoComplete="name" />
              <label htmlFor="ogsc-msg">{W.messageField}</label>
              <textarea id="ogsc-msg" value={message} onChange={e => setMessage(e.target.value)} rows={2} disabled={phase === "sending"} />
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400, marginTop: 10 }}>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={e => setConsent(e.target.checked)}
                  style={{ width: "auto", marginTop: 2 }}
                  disabled={phase === "sending"}
                />
                <span style={{ fontSize: 12 }}>{consentText}</span>
              </label>
              <div style={{ height: 10 }} />
              <button onClick={send} disabled={phase === "sending"}>
                {phase === "sending" ? W.sending : tr("leadEmbedSend")}
              </button>
            </>
          ) : (
            <div style={{ textAlign: "center", fontSize: 14, fontWeight: 700, padding: "10px 0 4px", color: "#10B981" }}>
              {emailed ? tr("leadEmbedSentMail") : tr("leadEmbedSentContact")}
            </div>
          )}
        </>
      ) : null}

      {error ? <div style={{ color: "#EF4444", fontSize: 12, marginTop: 10 }} role="alert">{error}</div> : null}
    </div>
  );
}

export default function EmbedAuditPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24 }} />}>
      <WidgetInner />
    </Suspense>
  );
}
