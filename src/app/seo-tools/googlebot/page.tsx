"use client";

// Googlebot View — "see" a page as Google's crawler does and spot cloaking / hidden redirects
// / PBN tricks by diffing the Googlebot-UA response against a normal browser response.
// For your OWN verified GSC sites, a "True Google View" panel adds Google's real verdict
// (googleCanonical vs userCanonical). See docs/GOOGLEBOT-VIEW-SPEC.md.

import { useState, useEffect } from "react";
import Link from "next/link";
import { Loader2, AlertTriangle, Bot, Monitor, ShieldCheck, ShieldAlert, ShieldX, ArrowRight, Globe, CheckCircle2, ExternalLink, HelpCircle } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { readUrlParam, writeUrlParam } from "@/lib/urlParam";
import { addHistory, getHistoryItem } from "@/lib/seo/history";
import { getFirecrawlKey } from "@/lib/seo/keys";

const card = "panel";
const inputStyle = "tool-input";
const btnPurple: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "7px", padding: "10px 16px", borderRadius: "9px", border: "none", background: "var(--color-accent-purple)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" };

type Hop = { url: string; status: number; location?: string; redirectType?: string; setCookie?: boolean };
type Signals = { canonicalHtml?: string; htmlLang?: string; metaRobots?: string; hreflang: { lang: string; href: string }[]; title: string; metaDescription?: string; h1?: string; jsRedirects: string[]; indexable: boolean; indexableReasons: string[] };
type View = { ua: string; ok: boolean; rendered?: boolean; blocked?: boolean; antiBot?: string; hops: Hop[]; finalUrl: string; finalStatus: number; headers: Record<string, string | undefined>; signals: Signals; wordCount: number; bodyText: string; htmlRaw: string; screenshot?: string; error?: string };
type Diff = { verdict: "clean" | "suspicious" | "cloaking" | "unknown"; score: number; flags: string[]; notes?: string[]; similarity?: number; noiseFloor?: number; confidence?: "high" | "medium" | "low" };
type DiffPair = { a: string; b: string; kind: "baseline" | "cross" | "device"; similarity: number };
type Matrix = { pairs: DiffPair[]; noiseFloor: number; crossDelta: number; confidence: "high" | "medium" | "low" };
type Gsc = { verdict?: string | null; coverageState?: string | null; indexingState?: string | null; robotsTxtState?: string | null; pageFetchState?: string | null; crawledAs?: string | null; googleCanonical?: string | null; userCanonical?: string | null; lastCrawlTime?: string | null };
type AntiBot = { blocked: boolean; provider?: string; bypassed: boolean };
type Result = { url: string; views: View[]; diff: Diff; matrix?: Matrix | null; ownSite?: { id: string; url: string } | null; gsc?: Gsc | null; wayback?: { available: boolean; url?: string; timestamp?: string } | null; antiBot?: AntiBot | null };

const CONF_KEY = { high: "gbvConfHigh", medium: "gbvConfMedium", low: "gbvConfLow" } as const;

const UA_LABEL: Record<string, string> = {
  gbMobile: "Googlebot (mobile)",
  gbDesktop: "Googlebot (desktop)",
  gbReferer: "Googlebot (Referer)",
  chrome: "Browser",
  gbRender: "Googlebot (JS-render)",
  browserRender: "Browser (JS-render)",
  gbRichResults: "Googlebot (Rich Results)",
};

function hostOfSafe(u?: string): string { try { return u ? new URL(u).host.toLowerCase() : ""; } catch { return ""; } }

export default function GooglebotViewPage() {
  const { t } = useLanguage();
  const [url, setUrl] = useState("");
  const [desktop, setDesktop] = useState(false);
  const [referer, setReferer] = useState(false);
  const [firecrawl, setFirecrawl] = useState(false);
  const [wayback, setWayback] = useState(false);
  const [compareMode, setCompareMode] = useState<"raw" | "js">("raw");
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [viewIdx, setViewIdx] = useState(0);
  const [mode, setMode] = useState<"preview" | "text" | "html">("preview");
  // Deep link (?compare=js&view=text): restore on mount, mirror on change. viewIdx stays out of
  // the URL on purpose — it indexes into the views the response happened to produce, so a
  // number in a shared link would point at a different view or none.
  useEffect(() => {
    const c = readUrlParam("compare");
    if (c === "raw" || c === "js") setCompareMode(c);
    const m = readUrlParam("view");
    if (m === "preview" || m === "text" || m === "html") setMode(m);
  }, []);
  useEffect(() => { writeUrlParam("compare", compareMode); writeUrlParam("view", mode); }, [compareMode, mode]);
  const [richLoading, setRichLoading] = useState(false);
  const [richErr, setRichErr] = useState("");
  const [richMsg, setRichMsg] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [pasteHtml, setPasteHtml] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const historyId = params.get("historyId");
      if (historyId) {
        const item = getHistoryItem(historyId);
        if (item && item.type === "googlebot") {
          setRes(item.data);
          setUrl(item.data.url);
          const hasJsRender = item.data.views.some((v: any) => v.ua === "gbRender" || v.ua === "browserRender");
          if (hasJsRender) {
            setFirecrawl(true);
            setCompareMode("js");
          }
          if (item.data.wayback) {
            setWayback(true);
          }
        }
      }
    }
  }, []);

  async function run() {
    if (!url.trim()) return;
    if (firecrawl && !getFirecrawlKey()) {
      setErr(t("gbvFirecrawlMissingKey"));
      return;
    }
    setRunning(true); setErr(""); setRes(null); setViewIdx(0); setMode("preview");
    try {
      const fcKey = firecrawl ? getFirecrawlKey() : undefined;
      const r = await fetch("/api/seo/googlebot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), desktop, referer, firecrawlKey: fcKey, wayback }),
      });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error === "private_host" ? t("gbvErrPrivate") : d.error === "bad_url" ? t("gbvErrUrl") : d.error || "error");
      } else {
        setRes(d);
        const historyData = {
          ...d,
          views: d.views.map((v: any) => ({
            ...v,
            htmlRaw: "",
          })),
        };
        addHistory({
          type: "googlebot",
          keyword: url.trim(),
          data: historyData,
        });
      }
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setRunning(false);
  }

  function mergeRichView(view: View) {
    setRes(prev => {
      if (!prev) return prev;
      const views = [...prev.views.filter(v => v.ua !== "gbRichResults"), view];
      setViewIdx(views.length - 1);
      setMode(view.screenshot ? "preview" : "html");
      return { ...prev, views };
    });
  }

  async function fetchRich(html?: string) {
    if (!res) return;
    setRichLoading(true); setRichErr(""); setRichMsg("");
    try {
      const r = await fetch("/api/seo/googlebot/rich-results", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: res.url, html }),
      });
      const d = await r.json();
      if (d.ok && d.view) {
        mergeRichView(d.view);
        setRichMsg(t("gbvRichLoaded"));
        setShowPaste(false); setPasteHtml("");
      } else {
        const e = d.error === "captcha" ? t("gbvRichErrCaptcha")
          : d.error === "cloudflare_block" ? t("gbvRichErrCloudflare")
          : d.error === "playwright_not_installed" ? t("gbvRichErrNoPlaywright")
          : d.error === "not_html" ? t("gbvRichErrGeneric")
          : t("gbvRichErrGeneric");
        setRichErr(e);
        if (!html) setShowPaste(true);
      }
    } catch { setRichErr(t("gbvRichErrGeneric")); setShowPaste(true); }
    setRichLoading(false);
  }

  const gb = res?.views.find(v => v.ua === "gbMobile");
  const br = res?.views.find(v => v.ua === "chrome");
  const gbRender = res?.views.find(v => v.ua === "gbRender");
  const brRender = res?.views.find(v => v.ua === "browserRender");
  const richView = res?.views.find(v => v.ua === "gbRichResults");

  // When the raw fetch was blocked by an anti-bot wall but a render got through, show the
  // rendered (real) content by default so the user sees the cloak instead of the challenge page.
  useEffect(() => {
    if (res?.antiBot?.blocked && res.antiBot.bypassed) setCompareMode("js");
  }, [res]);

  const hasJsRender = !!gbRender && !!brRender;
  const activeGb = compareMode === "js" && gbRender ? gbRender : gb;
  const activeBr = compareMode === "js" && brRender ? brRender : br;
  // The Rich Results view is the authoritative "real Googlebot" — prefer it for SEO signals.
  const authGb = richView ?? activeGb;

  const verdictUi = {
    clean: { icon: ShieldCheck, color: "var(--color-accent-green)", bg: "rgba(52,199,89,0.08)", bd: "rgba(52,199,89,0.35)", label: t("gbvVerdictClean") },
    suspicious: { icon: ShieldAlert, color: "var(--color-accent-orange)", bg: "rgba(255,159,10,0.08)", bd: "rgba(255,159,10,0.35)", label: t("gbvVerdictSuspicious") },
    cloaking: { icon: ShieldX, color: "var(--color-accent-red)", bg: "rgba(255,69,58,0.08)", bd: "rgba(255,69,58,0.4)", label: t("gbvVerdictCloaking") },
    unknown: { icon: HelpCircle, color: "var(--color-text-secondary)", bg: "var(--color-bg)", bd: "var(--color-border)", label: t("gbvVerdictUnknown") },
  } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div>
        <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px", display: "flex", alignItems: "center", gap: "9px" }}>
          <Bot size={20} color="var(--color-accent-purple)" /> {t("gbvTitle")}
        </h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("gbvSub")}</p>
      </div>

      {/* Input */}
      <div className={card}>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <input
            className={inputStyle}
            style={{ flex: 1, minWidth: "260px" }}
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") run(); }}
            placeholder={t("gbvUrlPh")}
          />
          <button onClick={run} disabled={running || !url.trim()} style={{ ...btnPurple, opacity: running || !url.trim() ? 0.6 : 1 }}>
            {running ? <Loader2 size={15} className="spin" /> : <Bot size={15} />} {t("gbvRun")}
          </button>
        </div>
        <div style={{ display: "flex", gap: "16px", marginTop: "10px", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)", cursor: "pointer" }}>
            <input type="checkbox" checked={desktop} onChange={e => setDesktop(e.target.checked)} /> {t("gbvOptDesktop")}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)", cursor: "pointer" }}>
            <input type="checkbox" checked={referer} onChange={e => setReferer(e.target.checked)} /> {t("gbvOptReferer")}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)", cursor: "pointer" }}>
            <input type="checkbox" checked={firecrawl} onChange={e => setFirecrawl(e.target.checked)} /> {t("gbvOptFirecrawl")}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)", cursor: "pointer" }}>
            <input type="checkbox" checked={wayback} onChange={e => setWayback(e.target.checked)} /> {t("gbvOptWayback")}
          </label>
        </div>
        {firecrawl && (
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "10px", padding: "10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", lineHeight: 1.5 }}>
            {t("gbvFirecrawlExplain")}
          </div>
        )}
        <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "10px", lineHeight: 1.5 }}>{t("gbvDisclaimer")}</div>
      </div>

      {err && <div className={card} style={{ borderColor: "rgba(255,69,58,0.35)", background: "rgba(255,69,58,0.06)", color: "var(--color-accent-red)", fontSize: "12px" }}>{err}</div>}

      {res && (
        <>
          {/* Anti-bot wall callout */}
          {res.antiBot?.blocked && (
            <div className={card} style={{ borderColor: "rgba(255,159,10,0.4)", background: "rgba(255,159,10,0.07)" }}>
              <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "6px" }}>
                <ShieldAlert size={18} color="var(--color-accent-orange)" />
                <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-accent-orange)" }}>{t("gbvBlockedTitle")}</span>
              </div>
              <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>{res.antiBot.bypassed ? t("gbvBlockedBypassed") : t("gbvBlockedHint")}</div>
              <a href={`https://search.google.com/test/rich-results?url=${encodeURIComponent(res.url)}`} target="_blank" rel="noreferrer"
                style={{ display: "inline-flex", alignItems: "center", gap: "6px", marginTop: "10px", padding: "8px 13px", borderRadius: "8px", border: "1px solid rgba(66,133,244,0.5)", background: "var(--color-bg)", color: "#4285F4", fontSize: "12px", fontWeight: 700, textDecoration: "none" }}>
                <ExternalLink size={13} /> {t("gbvBlockedRRT")}
              </a>
            </div>
          )}

          {/* Rich Results — the real Googlebot view (auto via Playwright, or manual paste) */}
          <div className={card} style={{ borderColor: "rgba(66,133,244,0.3)", background: "rgba(66,133,244,0.04)" }}>
            <div className="tool-section-label" style={{ marginBottom: "6px", display: "flex", alignItems: "center", gap: "7px" }}>
              <Globe size={14} color="#4285F4" /> {t("gbvRichTitle")}
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6, marginBottom: "10px" }}>{t("gbvRichNote")}</div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={() => fetchRich()} disabled={richLoading} style={{ ...btnPurple, opacity: richLoading ? 0.6 : 1 }}>
                {richLoading ? <Loader2 size={15} className="spin" /> : <Bot size={15} />} {t("gbvRichAutoBtn")}
              </button>
              <button onClick={() => setShowPaste(v => !v)} style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "10px 14px", borderRadius: "9px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>{t("gbvRichPasteToggle")}</button>
              {richMsg && <span style={{ fontSize: "12px", color: "var(--color-accent-green)" }}>{richMsg}</span>}
            </div>
            {richErr && <div style={{ marginTop: "8px", fontSize: "12px", color: "var(--color-accent-orange)" }}>{richErr}</div>}
            {showPaste && (
              <div style={{ marginTop: "10px" }}>
                <textarea className={inputStyle} style={{ width: "100%", minHeight: "90px", resize: "vertical", fontFamily: "ui-monospace, monospace", fontSize: "11px" }} value={pasteHtml} onChange={e => setPasteHtml(e.target.value)} placeholder={t("gbvRichPastePh")} />
                <button onClick={() => fetchRich(pasteHtml)} disabled={richLoading || pasteHtml.trim().length < 40} style={{ ...btnPurple, marginTop: "8px", opacity: (richLoading || pasteHtml.trim().length < 40) ? 0.6 : 1 }}>{t("gbvRichPasteBtn")}</button>
              </div>
            )}
          </div>

          {/* Signals bar — fetched URL / lang / HTML canonical / hreflang */}
          {authGb && (() => {
            const s = authGb.signals;
            const pageHost = hostOfSafe(authGb.finalUrl);
            const canonHost = hostOfSafe(s.canonicalHtml);
            const offDomain = !!canonHost && !!pageHost && canonHost !== pageHost;
            const chip = (bd: string, bg: string): React.CSSProperties => ({ display: "inline-flex", alignItems: "center", gap: "7px", padding: "7px 11px", borderRadius: "9px", border: `1px solid ${bd}`, background: bg, fontSize: "12px", color: "var(--color-text-primary)" });
            const lbl: React.CSSProperties = { fontSize: "9px", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--color-text-tertiary)", fontWeight: 700 };
            return (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                <span style={chip("var(--color-border)", "var(--color-card)")}><span style={lbl}>URL</span> {pageHost || "—"}</span>
                {s.htmlLang && <span style={chip("var(--color-border)", "var(--color-card)")}><span style={lbl}>html lang</span> {s.htmlLang}</span>}
                <span style={chip(offDomain ? "rgba(255,69,58,0.5)" : "var(--color-border)", offDomain ? "rgba(255,69,58,0.08)" : "var(--color-card)")}>
                  <span style={lbl}>HTML canonical</span>
                  <span style={{ color: offDomain ? "var(--color-accent-red)" : "var(--color-text-primary)", fontWeight: offDomain ? 700 : 400 }}>{canonHost || "—"}</span>
                  {offDomain && <AlertTriangle size={13} color="var(--color-accent-red)" />}
                </span>
                {s.hreflang.length > 0 && (
                  <span style={chip("var(--color-border)", "var(--color-card)")}>
                    <span style={lbl}>hreflang</span>
                    {s.hreflang.slice(0, 8).map((h, i) => <span key={i} style={{ padding: "1px 6px", borderRadius: "5px", background: "var(--color-bg)", border: "1px solid var(--color-border)", fontSize: "11px" }}>{h.lang}</span>)}
                  </span>
                )}
              </div>
            );
          })()}

          {/* Off-domain canonical warning — authority funneling / PBN */}
          {authGb && (() => {
            const s = authGb.signals;
            const pageHost = hostOfSafe(authGb.finalUrl);
            const canonHost = hostOfSafe(s.canonicalHtml);
            if (!canonHost || !pageHost || canonHost === pageHost) return null;
            return (
              <div className={card} style={{ borderColor: "rgba(255,69,58,0.35)", background: "rgba(255,69,58,0.06)", display: "flex", gap: "10px", alignItems: "flex-start", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
                <AlertTriangle size={16} color="var(--color-accent-red)" style={{ flexShrink: 0, marginTop: "1px" }} />
                <span>{t("gbvCanonOffDomain")} <b style={{ color: "var(--color-accent-red)" }}>{canonHost}</b> ≠ {pageHost}</span>
              </div>
            );
          })()}

          {/* Verdict */}
          {(() => {
            const v = verdictUi[res.diff.verdict];
            const Icon = v.icon;
            return (
              <div className={card} style={{ borderColor: v.bd, background: v.bg }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <Icon size={22} color={v.color} />
                  <div>
                    <div style={{ fontSize: "15px", fontWeight: 700, color: v.color }}>{v.label}</div>
                    <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
                      {t("gbvScore")}: {res.diff.score}/100
                      {res.diff.confidence ? ` · ${t("gbvConfidence")}: ${t(CONF_KEY[res.diff.confidence])}` : ""}
                    </div>
                  </div>
                </div>
                {res.diff.flags.length > 0 && (
                  <ul style={{ margin: "10px 0 0", paddingLeft: "18px", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
                    {res.diff.flags.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                )}
                {/* Findings that are not cloaking but change how the page should be read — a
                    client-side redirect served to everyone, for instance. Kept visually separate so
                    they never look like evidence for the verdict above. */}
                {res.diff.notes && res.diff.notes.length > 0 && (
                  <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: "1px solid var(--color-border)" }}>
                    <div style={{ fontSize: "10px", fontWeight: 700, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("gbvNotesTitle")}</div>
                    <ul style={{ margin: "6px 0 0", paddingLeft: "18px", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
                      {res.diff.notes.map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            );
          })()}

          {/* The sampling evidence behind the verdict — shown so the score can be audited rather
              than trusted. Baseline rows are the page arguing with itself; cross rows are the
              actual question. */}
          {res.matrix && res.matrix.pairs.length > 0 && (
            <div className={card}>
              <div className="tool-section-label" style={{ marginBottom: "6px" }}>{t("gbvMatrixTitle")}</div>
              <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", lineHeight: 1.6, marginBottom: "10px" }}>{t("gbvMatrixHint")}</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <tbody>
                    {res.matrix.pairs.map((pair, i) => (
                      <tr key={i} style={{ borderTop: i ? "1px solid var(--color-border)" : "none" }}>
                        <td style={{ padding: "6px 8px 6px 0", color: "var(--color-text-secondary)" }}>
                          {pair.a} ↔ {pair.b}
                          <span style={{ marginLeft: "8px", fontSize: "10px", color: "var(--color-text-tertiary)" }}>
                            {pair.kind === "baseline" ? t("gbvPairBaseline") : pair.kind === "device" ? t("gbvPairDevice") : t("gbvPairCross")}
                          </span>
                        </td>
                        <td style={{ padding: "6px 0", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600, color: pair.similarity >= 0.99 ? "var(--color-accent-green)" : pair.similarity >= 0.9 ? "var(--color-accent-orange)" : "var(--color-accent-red)" }}>
                          {pair.similarity.toFixed(3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: "10px", fontSize: "11px", color: "var(--color-text-secondary)" }}>
                {t("gbvNoiseFloor")}: <b>{(res.matrix.noiseFloor * 100).toFixed(1)}%</b>
              </div>
            </div>
          )}

          {/* Cross-check with the real Google */}
          <div className={card} style={{ borderColor: "rgba(66,133,244,0.3)", background: "rgba(66,133,244,0.04)" }}>
            <div className="tool-section-label" style={{ marginBottom: "6px", display: "flex", alignItems: "center", gap: "7px" }}>
              <Globe size={14} color="#4285F4" /> {t("gbvCrossTitle")}
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6, marginBottom: "10px" }}>{t("gbvCrossNote")}</div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <a href={`https://search.google.com/test/rich-results?url=${encodeURIComponent(res.url)}`} target="_blank" rel="noreferrer"
                style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 13px", borderRadius: "8px", border: "1px solid rgba(66,133,244,0.4)", background: "var(--color-bg)", color: "#4285F4", fontSize: "12px", fontWeight: 600, textDecoration: "none" }}>
                <ExternalLink size={13} /> {t("gbvOpenRRT")}
              </a>
              <a href={`https://pagespeed.web.dev/analysis?url=${encodeURIComponent(res.url)}&form_factor=mobile`} target="_blank" rel="noreferrer"
                style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 13px", borderRadius: "8px", border: "1px solid rgba(66,133,244,0.4)", background: "var(--color-bg)", color: "#4285F4", fontSize: "12px", fontWeight: 600, textDecoration: "none" }}>
                <ExternalLink size={13} /> {t("gbvOpenPSI")}
              </a>
            </div>
          </div>

          {/* Comparison table */}
          {activeGb && activeBr && (
            <div className={card}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px", flexWrap: "wrap", gap: "10px" }}>
                <div className="tool-section-label" style={{ margin: 0 }}>{t("gbvCompare")}</div>
                {hasJsRender && (
                  <div style={{ display: "flex", border: "1px solid var(--color-border)", borderRadius: "8px", overflow: "hidden" }}>
                    <button onClick={() => setCompareMode("raw")} style={{ padding: "5px 10px", fontSize: "11px", fontWeight: 600, cursor: "pointer", border: "none", background: compareMode === "raw" ? "var(--color-text-primary)" : "var(--color-bg)", color: compareMode === "raw" ? "var(--color-bg)" : "var(--color-text-secondary)" }}>
                      Raw Fetch
                    </button>
                    <button onClick={() => setCompareMode("js")} style={{ padding: "5px 10px", fontSize: "11px", fontWeight: 600, cursor: "pointer", border: "none", background: compareMode === "js" ? "var(--color-text-primary)" : "var(--color-bg)", color: compareMode === "js" ? "var(--color-bg)" : "var(--color-text-secondary)" }}>
                      JS-rendered (Firecrawl)
                    </button>
                  </div>
                )}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "var(--color-text-tertiary)", fontSize: "10px", textTransform: "uppercase" }}>
                      <th style={{ padding: "6px 8px" }}></th>
                      <th style={{ padding: "6px 8px" }}><Bot size={13} style={{ verticalAlign: "-2px" }} /> {t("gbvColGooglebot")}</th>
                      <th style={{ padding: "6px 8px" }}><Monitor size={13} style={{ verticalAlign: "-2px" }} /> {t("gbvColBrowser")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compareRow(t("gbvRowStatus"), String(activeGb.finalStatus) + (activeGb.blocked ? ` · ${t("gbvBlocked")}` : ""), String(activeBr.finalStatus) + (activeBr.blocked ? ` · ${t("gbvBlocked")}` : ""), activeGb.finalStatus !== activeBr.finalStatus)}
                    {compareRow(t("gbvRowFinalUrl"), activeGb.finalUrl, activeBr.finalUrl, hostOf(activeGb.finalUrl) !== hostOf(activeBr.finalUrl))}
                    {compareRow(t("gbvCanonicalHtml"), activeGb.signals.canonicalHtml || "—", activeBr.signals.canonicalHtml || "—", !!activeGb.signals.canonicalHtml && !!activeBr.signals.canonicalHtml && activeGb.signals.canonicalHtml !== activeBr.signals.canonicalHtml)}
                    {compareRow(t("gbvMetaRobots"), activeGb.signals.metaRobots || "—", activeBr.signals.metaRobots || "—", (activeGb.signals.metaRobots || "") !== (activeBr.signals.metaRobots || ""))}
                    {compareRow(t("gbvXRobots"), activeGb.headers.xRobotsTag || "—", activeBr.headers.xRobotsTag || "—", (activeGb.headers.xRobotsTag || "") !== (activeBr.headers.xRobotsTag || ""))}
                    {compareRow(t("gbvRowTitle"), activeGb.signals.title || "—", activeBr.signals.title || "—", (activeGb.signals.title || "") !== (activeBr.signals.title || ""))}
                    {compareRow(t("gbvRowWords"), String(activeGb.wordCount), String(activeBr.wordCount), Math.abs(activeGb.wordCount - activeBr.wordCount) / Math.max(activeGb.wordCount, activeBr.wordCount || 1) > 0.4)}
                    {compareRow(t("gbvRowIndexable"), activeGb.signals.indexable ? "✓" : "noindex", activeBr.signals.indexable ? "✓" : "noindex", activeGb.signals.indexable !== activeBr.signals.indexable)}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Content diff — lines only the bot / only the browser sees */}
          {activeGb && activeBr && (activeGb.bodyText || activeBr.bodyText) && (() => {
            const d = lineDiff(activeGb.bodyText, activeBr.bodyText);
            const hasLines = d.onlyA.length > 0 || d.onlyB.length > 0;
            const hashDiffers = res.diff.flags.some(f => f.includes("Контент") || f.toLowerCase().includes("content"));
            if (!hasLines && !hashDiffers) return null;
            return (
              <div className={card}>
                <div className="tool-section-label" style={{ marginBottom: "10px" }}>{t("gbvDiffTitle")}</div>
                {hasLines ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px,1fr))", gap: "16px" }}>
                    <div>
                      <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-accent-green)", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}><Bot size={13} /> {t("gbvOnlyBot")}</div>
                      {d.onlyA.length ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                          {d.onlyA.map((line, i) => (
                            <div key={i} style={{ fontSize: "12px", padding: "6px 10px", borderRadius: "6px", background: "rgba(52,199,89,0.08)", borderLeft: "3px solid rgba(52,199,89,0.6)", color: "var(--color-text-primary)", lineHeight: 1.5, wordBreak: "break-word" }}>{line}</div>
                          ))}
                        </div>
                      ) : <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>—</span>}
                    </div>
                    <div>
                      <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-accent-red)", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}><Monitor size={13} /> {t("gbvOnlyBrowser")}</div>
                      {d.onlyB.length ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                          {d.onlyB.map((line, i) => (
                            <div key={i} style={{ fontSize: "12px", padding: "6px 10px", borderRadius: "6px", background: "rgba(255,69,58,0.08)", borderLeft: "3px solid rgba(255,69,58,0.6)", color: "var(--color-text-primary)", lineHeight: 1.5, wordBreak: "break-word" }}>{line}</div>
                          ))}
                        </div>
                      ) : <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>—</span>}
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("gbvDiffNoneWords")}</div>
                )}
              </div>
            );
          })()}

          {/* Content viewer */}
          {res.views.some(v => v.htmlRaw || v.bodyText) && (() => {
            const sel = res.views[Math.min(viewIdx, res.views.length - 1)];
            return (
              <div className={card}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "10px" }}>
                  <div className="tool-section-label" style={{ margin: 0 }}>{t("gbvContent")}</div>
                  <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{t("gbvViewLabel")}</span>
                  <div style={{ display: "flex", border: "1px solid var(--color-border)", borderRadius: "8px", overflow: "hidden" }}>
                    {res.views.map((v, i) => {
                      const dupReferer = i > 0 && v.ua === "gbMobile" && res.views[0].ua === "gbMobile";
                      const label = (UA_LABEL[v.ua] || v.ua) + (dupReferer ? " · Referer" : "");
                      return (
                        <button key={i} onClick={() => setViewIdx(i)} style={{ padding: "6px 11px", fontSize: "11px", fontWeight: 600, cursor: "pointer", border: "none", background: viewIdx === i ? "var(--color-text-primary)" : "var(--color-bg)", color: viewIdx === i ? "var(--color-bg)" : "var(--color-text-secondary)", whiteSpace: "nowrap" }}>{label}</button>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", border: "1px solid var(--color-border)", borderRadius: "8px", overflow: "hidden", marginLeft: "auto" }}>
                    {(["preview", "text", "html"] as const).map(m => (
                      <button key={m} onClick={() => setMode(m)} style={{ padding: "6px 11px", fontSize: "11px", fontWeight: 600, cursor: "pointer", border: "none", background: mode === m ? "var(--color-accent-purple)" : "var(--color-bg)", color: mode === m ? "#fff" : "var(--color-text-secondary)" }}>{m === "preview" ? t("gbvTabPreview") : m === "text" ? t("gbvTabText") : t("gbvTabHtml")}</button>
                    ))}
                  </div>
                  <button onClick={() => openInTab(sel)} disabled={!sel.htmlRaw} style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "6px 11px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "11px", fontWeight: 600, cursor: sel.htmlRaw ? "pointer" : "default", opacity: sel.htmlRaw ? 1 : 0.5 }}>
                    <ExternalLink size={12} /> {t("gbvOpenTab")}
                  </button>
                </div>

                {!sel.htmlRaw && !sel.bodyText ? (
                  <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{t("gbvNoContent")}</div>
                ) : mode === "preview" ? (
                  sel.screenshot ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={sel.screenshot} alt={t("gbvScreenshot")} style={{ width: "100%", borderRadius: "8px", border: "1px solid var(--color-border)", background: "#fff", display: "block" }} />
                      <div style={{ fontSize: "10px", color: "var(--color-text-tertiary)", marginTop: "6px", lineHeight: 1.4 }}>{t("gbvScreenshot")} · {UA_LABEL[sel.ua] || sel.ua}</div>
                    </>
                  ) : sel.htmlRaw ? (
                    <>
                      <iframe title="preview" sandbox="" srcDoc={srcdocFor(sel)} style={{ width: "100%", height: "520px", border: "1px solid var(--color-border)", borderRadius: "8px", background: "#fff" }} />
                      <div style={{ fontSize: "10px", color: "var(--color-text-tertiary)", marginTop: "6px", lineHeight: 1.4 }}>{t("gbvPreviewNote")}</div>
                    </>
                  ) : <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{t("gbvNoContent")}</div>
                ) : mode === "text" ? (
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "12px", lineHeight: 1.6, color: "var(--color-text-primary)", maxHeight: "520px", overflow: "auto", margin: 0, padding: "12px", background: "var(--color-bg)", borderRadius: "8px", border: "1px solid var(--color-border)" }}>{sel.bodyText || "—"}</pre>
                ) : (
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "11px", lineHeight: 1.5, fontFamily: "ui-monospace, monospace", color: "var(--color-text-secondary)", maxHeight: "520px", overflow: "auto", margin: 0, padding: "12px", background: "var(--color-bg)", borderRadius: "8px", border: "1px solid var(--color-border)" }}>{sel.htmlRaw || "—"}</pre>
                )}
              </div>
            );
          })()}

          {/* Redirect chains */}
          <div className={card}>
            <div className="tool-section-label" style={{ marginBottom: "10px" }}>{t("gbvRedirectChain")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {res.views.map((v, vi) => (
                <div key={vi}>
                  <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-text-secondary)", marginBottom: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
                    {v.ua === "chrome" ? <Monitor size={13} /> : <Bot size={13} />} {UA_LABEL[v.ua] || v.ua}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", fontSize: "11px" }}>
                    {v.hops.map((h, hi) => (
                      <span key={hi} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 8px", borderRadius: "6px", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}>
                          <b style={{ color: statusColor(h.status) }}>{h.status || "×"}</b>
                          <span style={{ maxWidth: "320px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.url}</span>
                          {h.redirectType && h.redirectType !== "http" && <em style={{ color: "var(--color-accent-orange)", fontStyle: "normal" }}>[{h.redirectType}]</em>}
                        </span>
                        {hi < v.hops.length - 1 && <ArrowRight size={12} color="var(--color-text-tertiary)" />}
                      </span>
                    ))}
                    {v.error && <span style={{ color: "var(--color-accent-red)" }}>· {v.error}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* SEO signals (Googlebot view) */}
          {gb && (gb.signals.hreflang.length > 0 || gb.headers.canonicalHeader || gb.signals.jsRedirects.length > 0) && (
            <div className={card}>
              <div className="tool-section-label" style={{ marginBottom: "10px" }}>{t("gbvSignals")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
                {gb.headers.canonicalHeader && <div><b>{t("gbvCanonicalHeader")}:</b> {gb.headers.canonicalHeader}</div>}
                {gb.signals.jsRedirects.length > 0 && <div><b>{t("gbvJsRedirect")}:</b> {gb.signals.jsRedirects.join(", ")}</div>}
                {gb.signals.hreflang.length > 0 && (
                  <div><b>{t("gbvHreflang")}:</b> {gb.signals.hreflang.map(h => `${h.lang}`).join(", ")}</div>
                )}
              </div>
            </div>
          )}

          {/* True Google View — own verified sites only */}
          {res.ownSite && (
            <div className={card} style={{ borderColor: "rgba(66,133,244,0.35)", background: "rgba(66,133,244,0.05)" }}>
              <div className="tool-section-label" style={{ marginBottom: "10px", display: "flex", alignItems: "center", gap: "7px" }}>
                <Globe size={14} color="#4285F4" /> {t("gbvTrueView")}
              </div>
              {res.gsc ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px,1fr))", gap: "8px", fontSize: "12px" }}>
                  {gscRow(t("gbvGscVerdict"), res.gsc.verdict)}
                  {gscRow(t("gbvGscCoverage"), res.gsc.coverageState)}
                  {gscRow(t("gbvGscIndexing"), res.gsc.indexingState)}
                  {gscRow(t("gbvGscRobots"), res.gsc.robotsTxtState)}
                  {gscRow(t("gbvGscFetch"), res.gsc.pageFetchState)}
                  {gscRow(t("gbvGscCrawledAs"), res.gsc.crawledAs)}
                  {gscRow(t("gbvGscUserCanonical"), res.gsc.userCanonical)}
                  {gscRow(t("gbvGscGoogleCanonical"), res.gsc.googleCanonical)}
                  {gscRow(t("gbvLastCrawl"), res.gsc.lastCrawlTime ? new Date(res.gsc.lastCrawlTime).toLocaleString() : null)}
                  {res.gsc.userCanonical && res.gsc.googleCanonical && res.gsc.userCanonical !== res.gsc.googleCanonical && (
                    <div style={{ gridColumn: "1/-1", color: "var(--color-accent-orange)", display: "flex", alignItems: "center", gap: "6px" }}>
                      <AlertTriangle size={14} /> {t("gbvCanonicalMismatch")}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: "6px" }}>
                  <CheckCircle2 size={14} color="#4285F4" /> {t("gbvGscUnavailable")} <Link href="/settings" style={{ color: "var(--color-accent-blue)" }}>{t("gbvGscConnect")}</Link>
                </div>
              )}
            </div>
          )}

          {/* Wayback Snapshot */}
          {res.wayback && (
            <div className={card} style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}>
              <div className="tool-section-label" style={{ marginBottom: "6px" }}>{t("gbvWaybackTitle")}</div>
              {res.wayback.available && res.wayback.url ? (
                <div style={{ fontSize: "12px", color: "var(--color-text-primary)" }}>
                  {t("gbvWaybackView")}{" "}
                  <a href={res.wayback.url} target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)", textDecoration: "underline", fontWeight: 600 }}>
                    {res.wayback.timestamp ? `${res.wayback.timestamp.slice(0, 4)}-${res.wayback.timestamp.slice(4, 6)}-${res.wayback.timestamp.slice(6, 8)} ${res.wayback.timestamp.slice(8, 10)}:${res.wayback.timestamp.slice(10, 12)}` : "Wayback Machine"}
                  </a>
                </div>
              ) : (
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("gbvWaybackNone")}</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function compareRow(label: string, a: string, b: string, diff: boolean) {
  return (
    <tr style={{ borderTop: "1px solid var(--color-border)" }}>
      <td style={{ padding: "7px 8px", color: "var(--color-text-tertiary)", whiteSpace: "nowrap", verticalAlign: "top" }}>{label}</td>
      <td style={{ padding: "7px 8px", color: diff ? "var(--color-accent-orange)" : "var(--color-text-primary)", wordBreak: "break-all", fontWeight: diff ? 600 : 400 }}>{a}</td>
      <td style={{ padding: "7px 8px", color: diff ? "var(--color-accent-orange)" : "var(--color-text-primary)", wordBreak: "break-all", fontWeight: diff ? 600 : 400 }}>{b}</td>
    </tr>
  );
}

function gscRow(label: string, value?: string | null) {
  return (
    <div style={{ padding: "7px 9px", borderRadius: "7px", border: "1px solid var(--color-border)", background: "var(--color-bg)" }}>
      <div style={{ fontSize: "10px", textTransform: "uppercase", color: "var(--color-text-tertiary)" }}>{label}</div>
      <div style={{ color: "var(--color-text-primary)", wordBreak: "break-all", marginTop: "2px" }}>{value || "—"}</div>
    </div>
  );
}

// Build an iframe-ready HTML doc: inject <base> so relative CSS/images resolve against the
// live site. Scripts are neutralised by the iframe sandbox="" — we render the served markup.
function srcdocFor(v: View): string {
  const base = `<base href="${v.finalUrl}">`;
  const h = v.htmlRaw || "";
  if (/<head[^>]*>/i.test(h)) return h.replace(/<head[^>]*>/i, m => m + base);
  return base + h;
}

function openInTab(v: View) {
  if (!v.htmlRaw) return;
  const blob = new Blob([srcdocFor(v)], { type: "text/html" });
  window.open(URL.createObjectURL(blob), "_blank", "noopener");
}

// Line-level diff: split visible text into meaningful lines/sentences, find lines present only
// in one view. Normalises whitespace so trivial formatting differences don't trigger false flags.
// Preserves original-case display. Capped at 50 lines per side.
function lineDiff(aText: string, bText: string): { onlyA: string[]; onlyB: string[] } {
  // Split into non-empty trimmed lines; collapse internal whitespace for matching.
  const toLines = (s: string): string[] =>
    s.split(/\n+/).map(l => l.trim()).filter(l => l.length > 0);
  const norm = (l: string) => l.replace(/\s+/g, " ").toLowerCase();

  const aLines = toLines(aText);
  const bLines = toLines(bText);

  // Build multiset of normalised lines for each side
  const ms = (lines: string[]) => {
    const m = new Map<string, { c: number; disp: string }>();
    for (const l of lines) {
      const k = norm(l);
      const e = m.get(k);
      if (e) e.c++;
      else m.set(k, { c: 1, disp: l });
    }
    return m;
  };

  const A = ms(aLines), B = ms(bLines);
  const onlyA: string[] = [], onlyB: string[] = [];
  for (const [k, e] of A) {
    const d = e.c - (B.get(k)?.c || 0);
    for (let i = 0; i < d; i++) onlyA.push(e.disp);
  }
  for (const [k, e] of B) {
    const d = e.c - (A.get(k)?.c || 0);
    for (let i = 0; i < d; i++) onlyB.push(e.disp);
  }
  return { onlyA: onlyA.slice(0, 50), onlyB: onlyB.slice(0, 50) };
}

function hostOf(u: string): string { try { return new URL(u).host; } catch { return u; } }
function statusColor(s: number): string {
  if (s >= 200 && s < 300) return "var(--color-accent-green)";
  if (s >= 300 && s < 400) return "var(--color-accent-blue)";
  if (s >= 400) return "var(--color-accent-red)";
  return "var(--color-text-tertiary)";
}
