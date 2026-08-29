"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, AlertTriangle, Search, ArrowLeft, Plus, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import SeoContentAnalysis from "@/components/SeoContentAnalysis";
import SeoJobProgress from "@/components/SeoJobProgress";
import SeoRecentList from "@/components/SeoRecentList";
import { getSeoGenCreds, getTaskCreds, getSerpCreds, getFirecrawlKey, loadPolicies, getActivePolicyName } from "@/lib/seo/keys";
import { COUNTRIES, LANGUAGES, defaultLanguageFor } from "@/lib/seo/regions";
import { takeView } from "@/lib/seo/history";
import { startJob, importJob } from "@/lib/seo/jobs";

const card = "panel";
const SITE_TYPE_COLOR: Record<string, string> = { official_store: "#10A37F", aggregator: "#ff9f0a", forum_ugc: "#34c759", editorial: "#2997ff", monobrand: "#bf5af2" };
const SITE_TYPE_KEY: Record<string, string> = { official_store: "seoStOfficial", aggregator: "seoStAggregator", forum_ugc: "seoStForum", editorial: "seoStEditorial", monobrand: "seoStMonobrand" };

function host(u: string): string { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }

export default function AnalysisPage() {
  const { t } = useLanguage();
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // step 1
  const [keyword, setKeyword] = useState("");
  const [country, setCountry] = useState("us");
  const [language, setLanguage] = useState("en");
  // Language follows the country's market default until the user picks one explicitly.
  const [langTouched, setLangTouched] = useState(false);
  const [city, setCity] = useState("");
  const [topN, setTopN] = useState(10);

  // step 2
  const [targetUrl, setTargetUrl] = useState("");
  const [serp, setSerp] = useState<any[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [manual, setManual] = useState("");

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState("");
  const [report, setReport] = useState<any>(null);
  const [anJobId, setAnJobId] = useState<string | null>(null);
  const timer = useRef<any>(null);

  // Read after mount only — SSR/first-render mismatch causes React #418.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const serpCreds = mounted ? getSerpCreds() : { provider: "", apiKey: "" };
  const ai = mounted ? getSeoGenCreds() : { provider: "", apiKey: "", model: "" };
  const noKeys = !serpCreds.apiKey || !ai.apiKey;

  useEffect(() => {
    const v = takeView();
    if (v?.type === "analysis") { setReport(v.data); setStep(3); if (v.data?.main_keyword || v.keyword) setKeyword(v.data?.main_keyword || v.keyword); }
  }, []);

  function startTimer() {
    setElapsed(0); setProgress(4);
    const t0 = Date.now();
    timer.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - t0) / 1000));
      setProgress(p => (p < 90 ? p + Math.max(0.4, (90 - p) * 0.012) : p));
    }, 1000);
  }
  function stopTimer() { if (timer.current) { clearInterval(timer.current); timer.current = null; } }
  useEffect(() => () => stopTimer(), []);

  // Step 1 → SERP → step 2
  async function findCompetitors() {
    setErr("");
    if (!keyword.trim()) { setErr(t("seoErrFillKwUrl")); return; }
    const { provider: sp, apiKey: sk, baseUrl: sbu } = getSerpCreds();
    if (!sk) { setErr(t("seoErrNoSerpKey")); return; }
    setBusy(true); setStage(t("seoStageSerp"));
    try {
      // Saver #3: cache SERP by query for 30 min — re-running the same keyword won't re-hit the API.
      const cacheKey = `serpCache:${sp}:${country}:${language}:${city}:${topN}:${keyword.trim().toLowerCase()}`;
      let data: any = null;
      try { const c = sessionStorage.getItem(cacheKey); if (c) { const o = JSON.parse(c); if (Date.now() - o.ts < 1800000) data = o.data; } } catch {}
      if (!data) {
        const res = await fetch("/api/seo/serp", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keyword, provider: sp, apiKey: sk, baseUrl: sbu, gl: country, hl: language, location: city || undefined, num: topN }),
        });
        data = await res.json();
        if (!res.ok) { setErr(data.error || t("seoErrSerp")); setBusy(false); return; }
        try { sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data })); } catch {}
      }
      const items = (data.results || []).slice(0, topN);
      setSerp(items);
      const sel: Record<string, boolean> = {};
      items.forEach((r: any) => { sel[r.url] = true; });
      setSelected(sel);
      setStep(2);
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setBusy(false); setStage("");
  }

  const selectedCount = serp.filter(r => selected[r.url]).length + manual.split(/\n/).map(s => s.trim()).filter(Boolean).length;

  // Step 2 → scrape + analyze → step 3
  async function runAnalysis() {
    setErr("");
    if (!targetUrl.trim()) { setErr(t("seoCaErrNoTarget")); return; }
    const { provider: ap, apiKey: ak, model: am, baseUrl: abu } = getTaskCreds("analysis");
    if (!ak) { setErr(t("seoErrNoAiKey")); return; }

    const manualUrls = manual.split(/\n/).map(s => s.trim()).filter(Boolean).slice(0, 5);
    const compUrls = [...serp.filter(r => selected[r.url]).map(r => r.url), ...manualUrls]
      .filter(u => host(u) !== host(targetUrl));
    if (compUrls.length === 0) { setErr(t("seoCaErrNoCompetitors")); return; }

    setStep(3); setReport(null); setBusy(true); startTimer();
    try {
      const fc = getFirecrawlKey();
      setStage(t("seoStageScrape"));
      const [compScrape, targetScrape] = await Promise.all([
        fetch("/api/seo/scrape", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: compUrls, firecrawlKey: fc }) }).then(r => r.json()),
        fetch("/api/seo/scrape", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: [targetUrl], firecrawlKey: fc }) }).then(r => r.json()),
      ]);
      const pages = compScrape.pages || [];
      const target = (targetScrape.pages || [])[0];

      const serpByUrl: Record<string, any> = {};
      serp.forEach(r => { serpByUrl[r.url] = r; });
      const competitors = compUrls.map((url, i) => {
        const p = pages.find((x: any) => x.url === url);
        const s = serpByUrl[url];
        return { position: s?.position || i + 1, url, site_type: s?.site_type || undefined, title: p?.title || s?.title || url, headings: p?.headings || [], word_count: p?.wordCount || 0, has_price_table: !!p?.hasPriceTable, has_faq: !!p?.hasFaq };
      });
      const targetPage = { url: targetUrl, title: target?.title, meta: target?.metaDescription, headings: target?.headings || [], word_count: target?.wordCount || 0, has_price_table: !!target?.hasPriceTable, has_faq: !!target?.hasFaq, text_sample: target?.textSample };

      setStage(t("seoStageGap"));
      const policy = loadPolicies().find(p => p.name === getActivePolicyName());
      const { jobId: jid, error } = await startJob("analysis", { keyword, targetPage, competitors, language, country, policy, aiProvider: ap, aiApiKey: ak, model: am || undefined, aiBaseUrl: abu || undefined });
      if (error || !jid) { setErr(error === "parse_failed" ? t("seoErrParseJsonShort") : (error || t("seoErrAnalysis"))); stopTimer(); setBusy(false); return; }
      stopTimer(); setBusy(false); setStage("");
      setAnJobId(jid); // background job — live progress takes over; user can leave
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    stopTimer(); setBusy(false); setStage("");
  }

  function reset() { setStep(1); setReport(null); setSerp([]); setErr(""); }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      {noKeys && step !== 3 && (
        <div className={card} style={{ borderColor: "rgba(255,159,10,0.35)", background: "rgba(255,159,10,0.06)", display: "flex", gap: "10px", alignItems: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          <AlertTriangle size={18} color="var(--color-accent-orange)" /> {t("seoNeedKeysPrefix")} <b>{t("seoSerpProviderLabel")}</b> + <b>{t("seoAiProviderLabel")}</b>. <Link href="/settings?tab=api-keys" style={{ color: "var(--color-accent-blue)" }}>{t("seoSettingsShort")}</Link>
        </div>
      )}

      {/* Stepper */}
      <div className={card}>
        <h2 style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 16px" }}>{t("seoCaProgressTitle")}</h2>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          {[[1, t("seoCaStep1")], [2, t("seoCaStep2")], [3, t("seoCaStep3")]].map(([n, label]) => {
            const active = step >= (n as number);
            return (
              <div key={n as number} style={{ display: "flex", flexDirection: "column", alignItems: (n as number) === 1 ? "flex-start" : (n as number) === 3 ? "flex-end" : "center", gap: "8px", flex: 1 }}>
                <span style={{ fontSize: "13px", fontWeight: 600, color: active ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}>{label}</span>
                <span style={{ width: 32, height: 32, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: 700, background: active ? "var(--color-text-primary)" : "var(--color-bg)", color: active ? "var(--color-bg)" : "var(--color-text-tertiary)", border: active ? "none" : "1px solid var(--color-border)" }}>{n as number}</span>
              </div>
            );
          })}
        </div>
      </div>

      {err && <div className={card} style={{ borderColor: "rgba(255,69,58,0.35)", background: "rgba(255,69,58,0.06)", color: "var(--color-accent-red)", fontSize: "13px", display: "flex", gap: "8px", alignItems: "center" }}><AlertTriangle size={16} /> {err}</div>}

      {/* STEP 1 */}
      {step === 1 && (
        <div className={card}>
          <h3 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 16px" }}>{t("seoCaStep1Title")}</h3>
          <span className="tool-field-label">{t("seoCaMainKeyword")} *</span>
          <input className="tool-input" value={keyword} onChange={e => setKeyword(e.target.value)} placeholder={t("seoKeywordRanksPh")} onKeyDown={e => e.key === "Enter" && findCompetitors()} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "12px", marginTop: "14px" }}>
            <div><span className="tool-field-label">{t("seoCountry")}</span>
              <select className="tool-input" value={country} onChange={e => { const gl = e.target.value; setCountry(gl); if (!langTouched) setLanguage(defaultLanguageFor(gl)); }}>{COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}</select>
            </div>
            <div><span className="tool-field-label">{t("seoLanguage")}</span>
              <select className="tool-input" value={language} onChange={e => { setLangTouched(true); setLanguage(e.target.value); }}>{LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}</select>
            </div>
            <div><span className="tool-field-label">{t("seoCaLocation")}</span>
              <input className="tool-input" value={city} onChange={e => setCity(e.target.value)} placeholder={t("seoCaLocationPh")} />
            </div>
            <div><span className="tool-field-label">{t("seoCaTopPositions")}</span>
              <select className="tool-input" value={topN} onChange={e => setTopN(Number(e.target.value))}>{[10, 12, 15, 18, 20].map(n => <option key={n} value={n}>{n}</option>)}</select>
            </div>
          </div>
          <button onClick={findCompetitors} disabled={busy} style={primaryBtn}>
            {busy ? <Loader2 size={15} className="spin" /> : <Search size={15} />} {t("seoCaNextCompetitors")}
          </button>
        </div>
      )}

      {/* STEP 2 */}
      {step === 2 && (
        <>
          <div className={card} style={{ background: "var(--color-bg)" }}>
            <h3 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px" }}>{t("seoCaYourUrl")}</h3>
            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 14px" }}>{t("seoCaYourUrlHint")}</p>
            <span className="tool-field-label">{t("seoCaYourArticleUrl")}</span>
            <input className="tool-input" value={targetUrl} onChange={e => setTargetUrl(e.target.value)} placeholder="https://example.com/page" />
          </div>

          <div className={card}>
            <h3 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px" }}>{t("seoCaSelectCompetitors")}</h3>
            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 14px" }}>{t("seoCaSelectCompetitorsHint")}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {serp.map((r, i) => {
                const on = !!selected[r.url];
                return (
                  <label key={r.url} style={{ display: "flex", gap: "12px", alignItems: "flex-start", padding: "13px 15px", borderRadius: "11px", border: `1px solid ${on ? "var(--color-accent-purple)" : "var(--color-border)"}`, background: on ? "rgba(191,90,242,0.06)" : "transparent", cursor: "pointer" }}>
                    <input type="checkbox" checked={on} onChange={e => setSelected(s => ({ ...s, [r.url]: e.target.checked }))} style={{ marginTop: "3px" }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span className="pill" style={{ flexShrink: 0 }}>#{r.position || i + 1}</span>
                        <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{r.title}</span>
                        {r.intent && <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "20px", flexShrink: 0, color: r.intent === "buy" ? "#10A37F" : "var(--color-text-secondary)", background: r.intent === "buy" ? "rgba(16,163,127,0.12)" : "var(--color-bg)" }}>{t(r.intent === "buy" ? "seoIntentBuy" : "seoIntentInfo")}</span>}
                        {r.site_type && <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "20px", flexShrink: 0, color: SITE_TYPE_COLOR[r.site_type] || "var(--color-text-secondary)", background: `${SITE_TYPE_COLOR[r.site_type] || "#888"}1a` }}>{t((SITE_TYPE_KEY[r.site_type] || "") as any) || r.site_type}</span>}
                      </div>
                      <div style={{ fontSize: "12px", color: "var(--color-accent-blue)", marginTop: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.url}</div>
                    </div>
                  </label>
                );
              })}
            </div>
            <div style={{ marginTop: "12px", padding: "11px 14px", borderRadius: "9px", background: "var(--color-bg)", fontSize: "13px", color: "var(--color-text-secondary)" }}>
              {t("seoCaSelectedN")}: <b style={{ color: "var(--color-text-primary)" }}>{selectedCount}</b>
            </div>
          </div>

          <div className={card}>
            <h3 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px" }}>{t("seoCaAddCustom")}</h3>
            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 12px" }}>{t("seoCaAddCustomHint")}</p>
            <textarea className="tool-input" style={{ minHeight: "84px", resize: "vertical" }} value={manual} onChange={e => setManual(e.target.value)} placeholder={"https://competitor.com/article"} />
            <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "8px 0 0" }}>{t("seoCaAddCustomMulti")}</p>
          </div>

          <button onClick={runAnalysis} disabled={busy} style={{ ...darkBtn, width: "100%" }}>
            {busy ? <Loader2 size={15} className="spin" /> : null} {t("seoCaStartAnalysis")}
          </button>
          <button onClick={() => setStep(1)} style={ghostBtn}><ArrowLeft size={14} /> {t("seoCaBackStep")}</button>
        </>
      )}

      {/* STEP 3 */}
      {step === 3 && anJobId && (
        <SeoJobProgress
          jobId={anJobId}
          keyword={keyword}
          onDone={async (job) => { const rec = await importJob(job); setAnJobId(null); if (rec) setReport(rec.data); }}
          onError={(m) => { setErr(m === "parse_failed" ? t("seoErrParseJsonShort") : m); setAnJobId(null); }}
          onCancel={() => { setAnJobId(null); setStep(1); }}
        />
      )}
      {step === 3 && !anJobId && (
        busy || (!report && !err) ? (
          <div className={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
              <h3 style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0, display: "flex", alignItems: "center", gap: "10px" }}><Loader2 size={18} className="spin" /> {t("seoCaAnalyzing")}</h3>
              <span className="pill">processing</span>
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "14px" }}>{t("seoCaKeyword")}: {keyword} · URL: {targetUrl}</div>
            <div style={{ height: "10px", borderRadius: "6px", background: "var(--color-bg)", overflow: "hidden", marginBottom: "8px" }}>
              <div style={{ width: `${progress}%`, height: "100%", background: "var(--color-text-primary)", transition: "width 0.6s" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--color-text-secondary)" }}>
              <span>{Math.round(progress)}%</span><span>{stage}</span>
            </div>
            <div style={{ marginTop: "16px", padding: "13px 15px", borderRadius: "10px", background: "rgba(41,151,255,0.06)", border: "1px solid rgba(41,151,255,0.25)", fontSize: "13px", color: "var(--color-text-secondary)" }}>
              {t("seoCaAnalyzingHint")} · {t("seoCaElapsed")}: {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
            </div>
          </div>
        ) : report ? (
          <>
            <button onClick={reset} style={ghostBtn}><Plus size={14} /> {t("seoCaNewAnalysis")}</button>
            <SeoContentAnalysis report={report} />
          </>
        ) : (
          <button onClick={reset} style={ghostBtn}><X size={14} /> {t("seoCaBackStep")}</button>
        )
      )}

      {step === 1 && !anJobId && <SeoRecentList type="analysis" />}
    </div>
  );
}

const primaryBtn: React.CSSProperties = { marginTop: "18px", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", padding: "12px", borderRadius: "10px", border: "none", background: "var(--color-text-primary)", color: "var(--color-bg)", fontSize: "14px", fontWeight: 700, cursor: "pointer" };
const darkBtn: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", padding: "13px", borderRadius: "10px", border: "none", background: "var(--color-text-primary)", color: "var(--color-bg)", fontSize: "14px", fontWeight: 700, cursor: "pointer" };
const ghostBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "7px", padding: "9px 16px", borderRadius: "9px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "13px", fontWeight: 600, cursor: "pointer", alignSelf: "flex-start" };
