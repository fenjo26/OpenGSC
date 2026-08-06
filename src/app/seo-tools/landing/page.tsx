"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Search, Loader2, Check, AlertTriangle, Wand2, Plus, ScanEye, Upload, Eye,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import SeoJobProgress from "@/components/SeoJobProgress";
import SeoRecentList from "@/components/SeoRecentList";
import { getSeoGenCreds, getTaskCreds, getSerpCreds, getFirecrawlKey, loadPolicies, getActivePolicyName, getKeywordSource, getKwAuto, getKwLimit } from "@/lib/seo/keys";
import { getMetricsWithKd } from "@/lib/seo/metricsClient";
import { COUNTRIES, LANGUAGES } from "@/lib/seo/regions";
import { TONES, toneToPrompt } from "@/lib/seo/tones";
import { startJob, importJob } from "@/lib/seo/jobs";
import { analyzeSerpIntent } from "@/lib/seo/serpAnalysis";
import type { StructureNode } from "@/lib/seo/scrape";

const card = "panel";
const inputStyle = "tool-input";

function Field({ l, children }: { l: string; children: React.ReactNode }) {
  return <div><span className="tool-field-label">{l}</span>{children}</div>;
}

function domainOf(url: string): string { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }

const SITE_TYPE_COLOR: Record<string, string> = {
  official_store: "#10A37F", aggregator: "#ff9f0a", forum_ugc: "#34c759", editorial: "#2997ff", monobrand: "#bf5af2",
};
const SITE_TYPE_KEY: Record<string, string> = {
  official_store: "seoStOfficial", aggregator: "seoStAggregator", forum_ugc: "seoStForum", editorial: "seoStEditorial", monobrand: "seoStMonobrand",
};

type SerpItem = { position: number; url: string; title: string; snippet: string; domain: string; site_type: string | null; intent?: string };
type Scraped = { url: string; ok: boolean; via: string; title: string; metaDescription: string; textSample?: string; headings: string[]; wordCount: number; hasPriceTable: boolean; hasFaq: boolean; error?: string };
type GenMode = "tz" | "tz_text" | "tz_wireframe" | "all";
type StructureMode = "serp" | "my_1to1" | "hybrid" | "seo_block";

// "H2: Heading text (~120 сл.)" per line ↔ StructureNode[] — the editable textarea format.
function nodesToText(nodes: StructureNode[]): string {
  return nodes.map(n => `${n.level}: ${n.text} (~${n.words} сл.)`).join("\n");
}
function textToNodes(text: string): StructureNode[] {
  return text.split(/\r?\n/).map(line => {
    const m = line.match(/^\s*(H[1-6])\s*:\s*(.*?)\s*(?:\(~?\s*(\d+)\s*(?:сл\.?|words?)\)\s*)?$/i);
    if (!m || !m[2]?.trim()) return null;
    return { level: m[1].toUpperCase(), text: m[2].trim(), words: m[3] ? Number(m[3]) : 0 };
  }).filter(Boolean) as StructureNode[];
}

export default function LandingPage() {
  const { t } = useLanguage();
  const router = useRouter();

  // Step 1 — same competitor-search flow as Outline.
  const [keyword, setKeyword] = useState("");
  const [country, setCountry] = useState("us");
  const [language, setLanguage] = useState("en");
  const [location, setLocation] = useState("");
  const [topN, setTopN] = useState(10);

  const [serp, setSerp] = useState<SerpItem[]>([]);
  const [paa, setPaa] = useState<string[]>([]);
  const [related, setRelated] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scraped, setScraped] = useState<Record<string, Scraped>>({});
  const [keywordsData, setKeywordsData] = useState<{ keyword: string; volume: number; cpc: number; competition: number }[]>([]);
  const [kwLoading, setKwLoading] = useState(false);
  /** Which provider answered, so the prompt names it instead of assuming DataForSEO. */
  const [kwSource, setKwSource] = useState("");
  const [kwHasSource, setKwHasSource] = useState(false);
  useEffect(() => { setKwHasSource(getKeywordSource().apiKey.length > 4); }, []);
  const [manualUrl, setManualUrl] = useState("");

  // Step 2 — generation config.
  const [genMode, setGenMode] = useState<GenMode>("tz_wireframe");
  const [targetWords, setTargetWords] = useState("800");
  const [narration, setNarration] = useState<"" | "first" | "third">("");
  const [tone, setTone] = useState("");
  const [customTone, setCustomTone] = useState("");
  const [addKeywords, setAddKeywords] = useState("");
  const [lsiPhrases, setLsiPhrases] = useState("");

  // "Under my page" — own-URL structure import.
  const [myUrl, setMyUrl] = useState("");
  const [structureMode, setStructureMode] = useState<StructureMode>("my_1to1");
  const [myStructureText, setMyStructureText] = useState("");
  const [myStructureLoading, setMyStructureLoading] = useState<"" | "html" | "vision">("");
  const [myStructureMeta, setMyStructureMeta] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState<"" | "serp" | "gen" | "avg">("");
  const [err, setErr] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);

  // Read after mount only — SSR/first-render mismatch causes React #418.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const ai = mounted ? getSeoGenCreds() : { provider: "", apiKey: "", model: "" };
  const serpCreds = mounted ? getSerpCreds() : { provider: "", apiKey: "" };
  const activePolicy = mounted ? (loadPolicies().find(p => p.name === getActivePolicyName()) || loadPolicies()[0]) : null;

  const resolveTone = () => tone === "custom" ? customTone
    : tone ? toneToPrompt(tone)
    : toneToPrompt(activePolicy?.voice?.toneOfVoice || "");

  const selectedItems = serp.filter(s => selected.has(s.url));
  const liveIntent = analyzeSerpIntent(selectedItems);

  async function ensureScraped(urls: string[]): Promise<Record<string, Scraped>> {
    const missing = urls.filter(u => !scraped[u]);
    if (!missing.length) return scraped;
    const res = await fetch("/api/seo/scrape", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: missing, firecrawlKey: getFirecrawlKey() }),
    });
    const data = await res.json();
    const next = { ...scraped };
    (data.pages || []).forEach((p: Scraped) => { next[p.url] = p; });
    setScraped(next);
    return next;
  }

  // Same routing as the outline tool — see the note there. Kept as a near-copy rather than a
  // shared hook because the two pages differ in what they do with the result, and the four lines
  // they share are not worth an abstraction that would hide the request from either.
  async function fetchKeywords() {
    const src = getKeywordSource();
    if (src.source === "off" || !src.apiKey || !keyword.trim()) { setKeywordsData([]); setKwSource(""); return; }
    setKwLoading(true);
    try {
      const res = await fetch("/api/seo/keyword-ideas", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seed: keyword, country, language,
          limit: getKwLimit(), withDifficulty: getMetricsWithKd(),
          source: src.source, apiKey: src.apiKey, baseUrl: src.baseUrl,
          cap: Number(localStorage.getItem(`seoMetricsCap_${src.source}`) || 0) || 0,
          fetch: true,
        }),
      });
      const data = await res.json();
      setKeywordsData(res.ok ? (data.items || []) : []);
      setKwSource(res.ok && (data.items || []).length ? String(data.source || "") : "");
    } catch { setKeywordsData([]); setKwSource(""); }
    setKwLoading(false);
  }

  async function runSerp() {
    setErr(""); setSerp([]); setSelected(new Set()); setScraped({}); setKeywordsData([]);
    if (!keyword.trim()) { setErr(t("seoErrEnterKeyword")); return; }
    const { provider, apiKey } = getSerpCreds();
    if (!apiKey) { setErr(t("seoErrNoSerpKey")); return; }
    setLoading("serp");
    try {
      const res = await fetch("/api/seo/serp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword, provider, apiKey, gl: country, hl: language, location, num: topN, engine: "google" }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error || t("seoErrSerp")); setLoading(""); return; }
      setSerp(data.results || []);
      setPaa(data.peopleAlsoAsk || []);
      setRelated(data.relatedSearches || []);
      setSelected(new Set((data.results || []).map((r: SerpItem) => r.url)));
      // Opt-in only: scraping a SERP must not spend keyword credits as a side effect.
      if (getKwAuto()) fetchKeywords();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setLoading("");
  }

  function toggle(url: string) {
    setSelected(s => { const n = new Set(s); n.has(url) ? n.delete(url) : n.add(url); return n; });
  }

  async function useAverage() {
    const urls = selectedItems.map(s => s.url);
    if (!urls.length) return;
    setLoading("avg");
    try {
      const cache = await ensureScraped(urls);
      const counts = urls.map(u => cache[u]?.wordCount || 0).filter(Boolean);
      if (counts.length) setTargetWords(String(Math.round(counts.reduce((a, b) => a + b, 0) / counts.length)));
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setLoading("");
  }

  function addCompetitorUrls() {
    const urls = manualUrl.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (!urls.length) return;
    setSerp(prev => {
      const have = new Set(prev.map(s => s.url));
      const additions: SerpItem[] = [];
      const sel = new Set(selected);
      for (const u of urls) {
        let url = u; try { url = new URL(u.startsWith("http") ? u : `https://${u}`).toString(); } catch { continue; }
        if (have.has(url)) { sel.add(url); continue; }
        have.add(url);
        additions.push({ position: prev.length + additions.length + 1, url, title: domainOf(url), snippet: "", domain: domainOf(url), site_type: "manual" });
        sel.add(url);
      }
      setSelected(sel);
      return [...prev, ...additions];
    });
    setManualUrl("");
  }

  // "Посмотреть структуру" — fast, HTML-based (own site's H1-H6 + real per-section word counts).
  async function viewMyStructure() {
    setErr(""); setMyStructureMeta("");
    if (!myUrl.trim()) return;
    setMyStructureLoading("html");
    try {
      const res = await fetch("/api/seo/structure", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: myUrl.trim(), firecrawlKey: getFirecrawlKey() }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error || t("seoLpStructErr")); setMyStructureLoading(""); return; }
      setMyStructureText(nodesToText(data.nodes || []));
      setMyStructureMeta(`${(data.nodes || []).length} ${t("seoLpHeadingsWord")} · ${data.title || ""}`);
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setMyStructureLoading("");
  }

  // "Разобрать по скриншоту" — upload a screenshot, vision model reconstructs the visual structure
  // (for pages whose H-tags don't reflect what's actually on screen). No screenshot-capture service
  // is wired up in this project, so this works from a manually uploaded image, not a live auto-shot.
  function triggerScreenshotUpload() { fileInputRef.current?.click(); }
  async function handleScreenshotFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setErr(""); setMyStructureMeta("");
    const { provider, apiKey, model, baseUrl } = getTaskCreds("landing");
    if (!apiKey) { setErr(t("seoErrNoAiKey")); return; }
    setMyStructureLoading("vision");
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const res = await fetch("/api/seo/structure-vision", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: dataUrl, mimeType: file.type || "image/png", aiProvider: provider, aiApiKey: apiKey, model: model || undefined, aiBaseUrl: baseUrl || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error === "parse_failed" ? t("seoErrParseJsonShort") : (data.error || t("seoLpStructErr"))); setMyStructureLoading(""); return; }
      setMyStructureText(nodesToText(data.nodes || []));
      setMyStructureMeta(`${(data.nodes || []).length} ${t("seoLpHeadingsWord")} · ${data.title || ""} · ${t("seoLpFromScreenshot")}`);
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setMyStructureLoading("");
  }

  async function generate() {
    setErr("");
    const { provider, apiKey, model, baseUrl } = getTaskCreds("landing");
    if (!apiKey) { setErr(t("seoErrNoAiKey")); return; }
    const urls = selectedItems.map(s => s.url);
    if (!urls.length) { setErr(t("seoErrSelectComp")); return; }
    setLoading("gen");
    try {
      const cache = await ensureScraped(urls);
      const competitors = selectedItems.map(s => {
        const p = cache[s.url];
        return {
          position: s.position, url: s.url, site_type: s.site_type || undefined, intent: s.intent,
          title: p?.title || s.title, headings: p?.headings || [],
          word_count: p?.wordCount || 0, has_price_table: !!p?.hasPriceTable, has_faq: !!p?.hasFaq,
          text_sample: p?.textSample || undefined,
        };
      });
      const resolvedTone = resolveTone();
      const resolvedPersona = activePolicy?.voice?.authorPersona || "";
      const myNodes = myUrl.trim() && myStructureText.trim() ? textToNodes(myStructureText) : [];
      const effStructureMode: StructureMode = myNodes.length ? structureMode : "serp";
      const serpIntent = analyzeSerpIntent(selectedItems);

      const { jobId: jid, error } = await startJob("landing", {
        keyword, language, country, competitors,
        aiProvider: provider, aiApiKey: apiKey, model: model || undefined, aiBaseUrl: baseUrl || undefined,
        policy: activePolicy, paa, related,
        tone: resolvedTone, persona: resolvedPersona,
        additionalKeywords: addKeywords.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).join(", "),
        lsiKeywords: lsiPhrases.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).join(", "),
        targetWordCount: targetWords ? Number(targetWords) : undefined,
        keywordsData, keywordsSource: kwSource || undefined, pageGoal: "commercial",
        narration: narration || undefined,
        generate: genMode,
        structureMode: effStructureMode,
        myStructure: myNodes.length ? myNodes : undefined,
      }, { serpIntent });
      if (error || !jid) { setErr(error === "parse_failed" ? t("seoErrParseJson") : (error || t("seoErrGen"))); setLoading(""); return; }
      setJobId(jid);
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setLoading("");
  }

  const noSerpKey = !serpCreds.apiKey;
  const noAiKey = !ai.apiKey;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleScreenshotFile} />

      <div className={card}>
        <h2 style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px" }}>{t("seoLpTitle")}</h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("seoLpSubtitle")}</p>
      </div>

      {!jobId && (noSerpKey || noAiKey) && (
        <div className={card} style={{ borderColor: "rgba(255,159,10,0.35)", background: "rgba(255,159,10,0.06)", display: "flex", gap: "10px", alignItems: "flex-start" }}>
          <AlertTriangle size={18} color="var(--color-accent-orange)" style={{ flexShrink: 0, marginTop: "1px" }} />
          <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
            {t("seoNeedKeysPrefix")} {noSerpKey && <b>{t("seoSerpProviderLabel")}</b>}{noSerpKey && noAiKey && " + "}{noAiKey && <b>{t("seoAiProviderLabel")}</b>}.{" "}
            <Link href="/settings?tab=api-keys" style={{ color: "var(--color-accent-blue)" }}>{t("seoOpenSettings")}</Link>
          </div>
        </div>
      )}

      {/* Step 1: competitor search */}
      {!jobId && (
      <div className={card}>
        <div className="tool-section-label">{t("seoLpStep1")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "12px", marginTop: "6px", marginBottom: "12px" }}>
          <Field l={t("seoKeyword")}>
            <input className={inputStyle} value={keyword} onChange={e => setKeyword(e.target.value)} placeholder={t("seoKeywordPh")} onKeyDown={e => e.key === "Enter" && runSerp()} />
          </Field>
          <Field l={t("seoCountry")}>
            <select className={inputStyle} value={country} onChange={e => setCountry(e.target.value)}>
              {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </Field>
          <Field l={t("seoLanguage")}>
            <select className={inputStyle} value={language} onChange={e => setLanguage(e.target.value)}>
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: "12px", alignItems: "end" }}>
          <Field l={t("seoLocationOpt")}><input className={inputStyle} value={location} onChange={e => setLocation(e.target.value)} placeholder={t("seoLocationPh")} /></Field>
          <Field l="Top N">
            <select className={inputStyle} value={topN} onChange={e => setTopN(Number(e.target.value))}>
              {[10, 20, 30].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
          <button onClick={runSerp} disabled={loading === "serp"} style={btnPurple}>
            {loading === "serp" ? <Loader2 size={15} className="spin" /> : <Search size={15} />}
            {serp.length > 0 ? t("seoAnalyzeSerp") : t("seoNextCompetitors")}
          </button>
        </div>
      </div>
      )}

      {err && (
        <div className={card} style={{ borderColor: "rgba(255,69,58,0.35)", background: "rgba(255,69,58,0.06)", color: "var(--color-accent-red)", fontSize: "13px", display: "flex", gap: "8px", alignItems: "center" }}>
          <AlertTriangle size={16} /> {err}
        </div>
      )}

      {jobId && (
        <SeoJobProgress
          jobId={jobId}
          keyword={keyword}
          onDone={async (job) => { const rec = await importJob(job); setJobId(null); if (rec) router.push(`/seo-tools/history/${rec.id}`); }}
          onError={(m) => { setErr(m === "parse_failed" ? t("seoErrParseJson") : m === "generation_failed" ? t("seoErrGen") : m); setJobId(null); }}
          onCancel={() => setJobId(null)}
        />
      )}

      {/* Step 2: competitors + generation config */}
      {!jobId && serp.length > 0 && (
        <div className={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <h3 style={{ fontSize: "14px", fontWeight: 700, margin: 0, color: "var(--color-text-primary)" }}>
              {t("seoCompetitors")} ({selected.size}/{serp.length} {t("seoSelectedWord")})
            </h3>
          </div>

          {/* Same warning as the outline tool, for the same reason: this page also feeds
              `keywordsData` into generation and also said nothing when the list came back empty. */}
          {!kwLoading && keywordsData.length === 0 && (
            <div style={{ marginBottom: "12px", padding: "10px 12px", borderRadius: "9px", border: "1px solid rgba(245,158,11,0.28)", background: "rgba(245,158,11,0.08)", display: "flex", gap: "9px", alignItems: "flex-start" }}>
              <AlertTriangle size={14} color="#f59e0b" style={{ flexShrink: 0, marginTop: "2px" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "3px" }}>{t("seoKwNoSourceTitle")}</div>
                <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("seoKwNoSourceBody")}</div>
                {kwHasSource
                  ? <button onClick={fetchKeywords} style={{ marginTop: "7px", padding: "7px 13px", borderRadius: "8px", border: "none", background: "var(--color-accent-purple)", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>{t("seoKwLoadBtn")}</button>
                  : <Link href="/seo-tools/settings" style={{ fontSize: "11px", color: "var(--color-accent-blue)", textDecoration: "none", display: "inline-block", marginTop: "5px" }}>{t("seoKwNoSourceCta")} →</Link>}
              </div>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {serp.map(s => {
              const on = selected.has(s.url);
              const wc = scraped[s.url]?.wordCount;
              return (
                <div key={s.url} onClick={() => toggle(s.url)} style={{
                  display: "flex", alignItems: "center", gap: "10px", padding: "9px 11px",
                  borderRadius: "8px", cursor: "pointer",
                  background: on ? "rgba(41,151,255,0.08)" : "transparent",
                  border: `1px solid ${on ? "rgba(41,151,255,0.3)" : "var(--color-border)"}`,
                }}>
                  <div style={{
                    width: 18, height: 18, borderRadius: "5px", flexShrink: 0,
                    border: `1.5px solid ${on ? "var(--color-accent-blue)" : "var(--color-border)"}`,
                    background: on ? "var(--color-accent-blue)" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>{on && <Check size={12} color="#fff" />}</div>
                  <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)", width: "22px", flexShrink: 0 }}>#{s.position}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "13px", color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
                    <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.domain}</div>
                  </div>
                  {wc ? <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)", flexShrink: 0 }}>{wc} {t("seoWords")}</span> : null}
                  {s.intent && (
                    <span style={{ fontSize: "10px", fontWeight: 700, padding: "3px 8px", borderRadius: "20px", flexShrink: 0,
                      color: s.intent === "buy" ? "#10A37F" : "var(--color-text-secondary)",
                      background: s.intent === "buy" ? "rgba(16,163,127,0.12)" : "var(--color-bg)" }}>
                      {t(s.intent === "buy" ? "seoIntentBuy" : "seoIntentInfo")}
                    </span>
                  )}
                  {s.site_type && (
                    <span style={{ fontSize: "10px", fontWeight: 700, padding: "3px 8px", borderRadius: "20px", flexShrink: 0,
                      color: SITE_TYPE_COLOR[s.site_type] || "var(--color-text-secondary)",
                      background: `${SITE_TYPE_COLOR[s.site_type] || "#888"}1a` }}>
                      {t((SITE_TYPE_KEY[s.site_type] || "") as any) || s.site_type}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {(paa.length > 0 || related.length > 0) && (
            <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid var(--color-border)", fontSize: "12px", color: "var(--color-text-secondary)" }}>
              {paa.length > 0 && <div style={{ marginBottom: "6px" }}><b>People Also Ask:</b> {paa.join(" · ")}</div>}
              {related.length > 0 && <div><b>Related:</b> {related.join(" · ")}</div>}
            </div>
          )}

          {/* add competitor URL */}
          <div style={{ marginTop: "14px" }}>
            <span className="tool-field-label">{t("seoCfgAddCompUrl")}</span>
            <div style={{ display: "flex", gap: "6px" }}>
              <input className={inputStyle} style={{ flex: 1 }} value={manualUrl} onChange={e => setManualUrl(e.target.value)} onKeyDown={e => e.key === "Enter" && addCompetitorUrls()} placeholder="https://competitor.com/page" />
              <button onClick={addCompetitorUrls} disabled={!manualUrl.trim()} style={{ ...btnGhost, opacity: manualUrl.trim() ? 1 : 0.5 }}><Plus size={13} /> {t("seoCfgAddCompUrlBtn")}</button>
            </div>
          </div>

          <SerpIntentPanelInline analysis={liveIntent} t={t} />

          {/* config */}
          <div style={{ marginTop: "18px", paddingTop: "16px", borderTop: "1px solid var(--color-border)" }}>
            <div className="tool-section-label">{t("seoLpStep2")}</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginTop: "10px" }}>
              <Field l={t("seoLpGenerateWhat")}>
                <select className={inputStyle} value={genMode} onChange={e => setGenMode(e.target.value as GenMode)}>
                  <option value="tz">{t("seoLpGenTzOnly")}</option>
                  <option value="tz_text">{t("seoLpGenTzText")}</option>
                  <option value="tz_wireframe">{t("seoLpGenTzWireframe")}</option>
                  <option value="all">{t("seoLpGenAll")}</option>
                </select>
              </Field>
              <Field l={t("seoCfgTargetWords")}>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input className={inputStyle} style={{ flex: 1 }} type="number" value={targetWords} onChange={e => setTargetWords(e.target.value)} placeholder="800" />
                  <button onClick={useAverage} disabled={loading === "avg" || !selected.size} style={btnGhost}>
                    {loading === "avg" ? <Loader2 size={13} className="spin" /> : null} {t("seoCfgUseAverage")}
                  </button>
                </div>
              </Field>
              <Field l={t("seoCfgNarration")}>
                <select className={inputStyle} value={narration} onChange={e => setNarration(e.target.value as any)}>
                  <option value="">{t("seoNarrationDefault")}</option>
                  <option value="first">{t("seoNarrationFirst")}</option>
                  <option value="third">{t("seoNarrationThird")}</option>
                </select>
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginTop: "12px" }}>
              <Field l={t("seoCfgAddKeywords")}>
                <input className={inputStyle} value={addKeywords} onChange={e => setAddKeywords(e.target.value)} placeholder={t("seoCfgAddKeywordsPh")} />
              </Field>
              <Field l={t("seoLpLsi")}>
                <input className={inputStyle} value={lsiPhrases} onChange={e => setLsiPhrases(e.target.value)} placeholder={t("seoLpLsiPh")} />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginTop: "12px" }}>
              <Field l={t("seoCfgTone")}>
                <select className={inputStyle} value={tone} onChange={e => setTone(e.target.value)}>
                  <option value="">{t("seoTonePolicyDefault")}</option>
                  {TONES.map(tn => <option key={tn.value} value={tn.value}>{t(tn.labelKey as any)}</option>)}
                  <option value="custom">{t("seoToneCustom")}</option>
                </select>
              </Field>
              {tone === "custom" && (
                <Field l={t("seoToneCustom")}>
                  <input className={inputStyle} value={customTone} onChange={e => setCustomTone(e.target.value)} placeholder={t("seoToneCustomPh")} />
                </Field>
              )}
            </div>

            {/* under my page */}
            <div style={{ marginTop: "16px", padding: "14px", border: "1px dashed var(--color-border)", borderRadius: "10px" }}>
              <span className="tool-field-label">{t("seoLpMyPage")} <span style={{ textTransform: "none", fontWeight: 400, color: "var(--color-text-tertiary)" }}>· {t("seoCfgOptional")}</span></span>
              <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginBottom: "8px" }}>{t("seoLpMyPageSub")}</div>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "10px" }}>
                <input className={inputStyle} value={myUrl} onChange={e => setMyUrl(e.target.value)} placeholder="https://мой-сайт/товар" />
                <select className={inputStyle} value={structureMode} onChange={e => setStructureMode(e.target.value as StructureMode)}>
                  <option value="my_1to1">{t("seoLpMode1to1")}</option>
                  <option value="hybrid">{t("seoLpModeHybrid")}</option>
                  <option value="seo_block">{t("seoLpModeSeoBlock")}</option>
                </select>
              </div>
              <div style={{ display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" }}>
                <button onClick={viewMyStructure} disabled={!myUrl.trim() || myStructureLoading !== ""} style={btnGhost}>
                  {myStructureLoading === "html" ? <Loader2 size={13} className="spin" /> : <Eye size={13} />} {t("seoLpViewStructure")}
                </button>
                <button onClick={triggerScreenshotUpload} disabled={myStructureLoading !== ""} style={btnGhost}>
                  {myStructureLoading === "vision" ? <Loader2 size={13} className="spin" /> : <ScanEye size={13} />} {t("seoLpParseScreenshot")}
                </button>
                <button onClick={triggerScreenshotUpload} disabled={myStructureLoading !== ""} style={btnGhost}>
                  <Upload size={13} /> {t("seoLpUploadScreenshot")}
                </button>
              </div>
              {myStructureMeta && <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "8px" }}>{myStructureMeta}</div>}
              <textarea className={inputStyle} style={{ minHeight: "110px", resize: "vertical", fontFamily: "monospace", fontSize: "12px", marginTop: "10px" }} value={myStructureText} onChange={e => setMyStructureText(e.target.value)} placeholder={"H1: ...\nH2: ... (~120 сл.)\nH3: ..."} />
              <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "6px" }}>{t("seoLpStructureHint")}</div>
            </div>

            <button onClick={generate} disabled={loading === "gen"} style={{ ...btnDark, width: "100%", justifyContent: "center", marginTop: "16px", padding: "12px" }}>
              {loading === "gen" ? <Loader2 size={15} className="spin" /> : <Wand2 size={15} />}
              {t("seoLpGenerateBtn")} ({selected.size} {t("seoSelectedWord")})
            </button>
          </div>
        </div>
      )}

      {!jobId && <SeoRecentList type="landing" />}
    </div>
  );
}

// Compact live preview — full SerpIntentPanel is reused in the saved detail view; here we only
// need the two-line summary while the user is still picking competitors, before saving anything.
function SerpIntentPanelInline({ analysis, t }: { analysis: ReturnType<typeof analyzeSerpIntent>; t: any }) {
  if (!analysis) return null;
  return (
    <div style={{ marginTop: "14px", padding: "10px 12px", borderRadius: "8px", background: "var(--color-bg)", border: "1px solid var(--color-border)", fontSize: "12px", color: "var(--color-text-secondary)", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>{t("seoSerpAnalysisTitle")}:</span>
      <span>{t("seoDominantIntent")} <b style={{ color: "var(--color-accent-green)" }}>{analysis.dominantIntent}</b></span>
      <span style={{ color: "var(--color-border)" }}>·</span>
      <span>{t("seoPageType")} <span className="pill">{analysis.pageType}</span></span>
      <span style={{ color: "var(--color-text-tertiary)" }}>({analysis.note})</span>
    </div>
  );
}

const btnGhost: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px", padding: "8px 13px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" };
const btnPurple: React.CSSProperties = { display: "flex", alignItems: "center", gap: "7px", padding: "9px 18px", borderRadius: "8px", border: "none", background: "var(--color-accent-purple)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer", height: "38px" };
const btnDark: React.CSSProperties = { display: "flex", alignItems: "center", gap: "7px", padding: "9px 18px", borderRadius: "8px", border: "none", background: "var(--color-text-primary)", color: "var(--color-bg)", fontSize: "13px", fontWeight: 600, cursor: "pointer" };
