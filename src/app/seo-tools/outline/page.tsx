"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Search, Loader2, Check, AlertTriangle, Wand2, Copy, Plus, X,
  LayoutGrid, List as ListIcon, ExternalLink, TrendingUp, CheckCircle2,
  Database, Sparkles, Globe2,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { OutlineView } from "@/components/SeoRenderers";
import SeoJobProgress from "@/components/SeoJobProgress";
import SeoRecentList from "@/components/SeoRecentList";
import { getSeoGenCreds, getTaskCreds, getSerpCreds, getFirecrawlKey, loadPolicies, getActivePolicyName, getKeywordSource, getKwAuto, getKwLimit } from "@/lib/seo/keys";
import { getMetricsWithKd, formatUsd, priceExpand } from "@/lib/seo/metricsClient";
import { COUNTRIES, LANGUAGES } from "@/lib/seo/regions";
import { TONES, toneToPrompt } from "@/lib/seo/tones";
import { OUTLINE_TEMPLATES, TEMPLATE_GROUPS } from "@/lib/seo/templates";
import { addHistory, takeView } from "@/lib/seo/history";
import { startJob, importJob } from "@/lib/seo/jobs";
import { FingerprintControls, useFingerprintControls } from "@/components/FingerprintControls";

const card = "panel";
const inputStyle = "tool-input";

function Field({ l, children }: { l: string; children: React.ReactNode }) {
  return <div><span className="tool-field-label">{l}</span>{children}</div>;
}

// Page goal (structure/titles) is derived from the chosen narrative tone — the tone labels
// already say "for commercial content" / "for informational articles", so one control drives both.
function domainOf(url: string): string { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }

function goalFromTone(toneValue: string): "informational" | "commercial" | "mixed" {
  const v = (toneValue || "").toLowerCase();
  if (v === "professional" || v === "business") return "commercial";
  if (v === "expert" || v === "analytical" || v === "neutral") return "informational";
  return "mixed"; // friendly / inspiring / practical / custom / default
}

const SITE_TYPE_COLOR: Record<string, string> = {
  official_store: "#10A37F", aggregator: "#ff9f0a", forum_ugc: "#34c759", editorial: "#2997ff", monobrand: "#bf5af2",
};
const SITE_TYPE_KEY: Record<string, string> = {
  official_store: "seoStOfficial", aggregator: "seoStAggregator", forum_ugc: "seoStForum", editorial: "seoStEditorial", monobrand: "seoStMonobrand",
};
// Cluster ordering for the grouped ("clusters") competitors view; unknown/manual → "other".
const SITE_TYPE_ORDER = ["official_store", "monobrand", "editorial", "aggregator", "forum_ugc", "other"];
const INTENT_KEY: Record<string, string> = {
  buy: "seoIntentBuy", info: "seoIntentInfo", review: "seoIntentReview", listicle: "seoIntentListicle", use_case: "seoIntentUseCase",
};
const INTENT_COLOR: Record<string, string> = {
  buy: "#10A37F", review: "#2997ff", listicle: "#ff9f0a", use_case: "#8e8e93", info: "#8e8e93",
};

type SerpItem = { position: number; url: string; title: string; snippet: string; domain: string; site_type: string | null; intent?: string };
type Scraped = { url: string; ok: boolean; via: string; title: string; metaDescription: string; textSample?: string; headings: string[]; wordCount: number; hasPriceTable: boolean; hasFaq: boolean; error?: string };

export default function OutlinePage() {
  const { t } = useLanguage();
  const router = useRouter();
  const fpc = useFingerprintControls();
  const [keyword, setKeyword] = useState("");
  const [country, setCountry] = useState("us");
  const [language, setLanguage] = useState("en");
  const [location, setLocation] = useState("");
  const [engine, setEngine] = useState<"google" | "bing">("google");
  const [topN, setTopN] = useState(10);

  const [serp, setSerp] = useState<SerpItem[]>([]);
  const [paa, setPaa] = useState<string[]>([]);
  const [related, setRelated] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scraped, setScraped] = useState<Record<string, Scraped>>({});
  const [serpView, setSerpView] = useState<"clusters" | "list">("list");
  const [parsing, setParsing] = useState<Set<string>>(new Set());
  const [keywordsData, setKeywordsData] = useState<{ keyword: string; volume: number; globalVolume?: number | null; cpc: number; competition: number; difficulty?: number | null; intent?: string }[]>([]);
  const [kwLoading, setKwLoading] = useState(false);
  /** Which provider answered — shown in the UI and sent to the prompt so neither of them guesses. */
  const [kwSource, setKwSource] = useState("");
  const [kwNotice, setKwNotice] = useState("");

  // step-2 config
  const [tone, setTone] = useState("");        // "" = default from policy
  const [customTone, setCustomTone] = useState("");
  const [persona, setPersona] = useState("");
  const [narration, setNarration] = useState<"" | "first" | "third">("");
  const [customTemplate, setCustomTemplate] = useState("");
  const [selectedTplId, setSelectedTplId] = useState<string | null>(null);
  const [ragOn, setRagOn] = useState(true);
  const [ragStats, setRagStats] = useState<{ slots: number; casinos: number } | null>(null);
  const [structureRules, setStructureRules] = useState("");
  const [addKeywords, setAddKeywords] = useState("");
  const [targetWords, setTargetWords] = useState("");
  const [manualUrl, setManualUrl] = useState("");

  const [loading, setLoading] = useState<"" | "serp" | "outline" | "text" | "avg">("");
  const [err, setErr] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [outline, setOutline] = useState<any>(null);
  const [article, setArticle] = useState("");

  // localStorage-derived values must not differ between SSR and first client render
  // (React #418 hydration mismatch) — read them only after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Append keyword(s) to the "additional keywords" field without duplicating entries.
  //
  // Joined with newlines, not commas, because the field's own placeholder says "one keyword per
  // line". The parser accepts both, so a comma-joined list worked — but a button that fills a box
  // in a format the box tells you not to use leaves the user unsure whether it took effect, which
  // is a real cost even when the behaviour is correct.
  const addKw = (kw: string | string[]) => {
    const incoming = (Array.isArray(kw) ? kw : [kw])
      .flatMap(s => s.split(/[\n,]+/)).map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!incoming.length) return;
    setAddKeywords(prev => {
      const existing = new Set(prev.split(/[\n,]+/).map(s => s.trim().toLowerCase()).filter(Boolean));
      const merged = [...prev.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)];
      for (const k of incoming) if (!existing.has(k)) { merged.push(k); existing.add(k); }
      return merged.join("\n");
    });
  };

  // Read after mount only — localStorage during render would make the first client pass disagree
  // with the server-rendered HTML.
  const kwSrc = mounted ? getKeywordSource() : { source: "off" as const, apiKey: "", baseUrl: undefined };
  const kwPrice = mounted ? priceExpand(kwSrc.source, getKwLimit(), getMetricsWithKd()) : { units: 0, usd: 0 };
  const ai = mounted ? getSeoGenCreds() : { provider: "", apiKey: "", model: "" };
  const serpCreds = mounted ? getSerpCreds() : { provider: "", apiKey: "" };
  const activePolicy = mounted ? (loadPolicies().find(p => p.name === getActivePolicyName()) || loadPolicies()[0]) : null;

  const resolveTone = () => tone === "custom" ? customTone
    : tone ? toneToPrompt(tone)
    : toneToPrompt(activePolicy?.voice?.toneOfVoice || "");

  // Load an item handed over from History (eye → view).
  useEffect(() => {
    const v = takeView();
    if (!v) return;
    if (v.type === "outline") { setOutline(v.data); if (v.keyword) setKeyword(v.keyword); }
    else if (v.type === "text") { setArticle(typeof v.data === "string" ? v.data : v.data?.article || ""); if (v.keyword) setKeyword(v.keyword); }
  }, []);

  // A cluster handed over from the Cluster tool: main keyword + the rest as additional.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("seoClusterSeed");
      if (!raw) return;
      sessionStorage.removeItem("seoClusterSeed");
      const s = JSON.parse(raw);
      if (s?.keyword) setKeyword(String(s.keyword));
      if (s?.additional) setAddKeywords(String(s.additional));
      if (s?.gl) setCountry(String(s.gl));
      if (s?.hl) setLanguage(String(s.hl));
    } catch { /* ignore */ }
  }, []);

  const stepNum = outline ? 3 : serp.length > 0 ? 2 : 1;

  // Knowledge-base sizes for the Casino RAG card (once per page load).
  useEffect(() => {
    fetch("/api/seo/rag/stats").then(r => r.ok ? r.json() : null).then(d => {
      if (d && typeof d.slots === "number") setRagStats({ slots: d.slots, casinos: d.casinos });
    }).catch(() => {});
  }, []);
  const ragAvailable = !!ragStats && (ragStats.slots + ragStats.casinos) > 0;

  async function ensureScraped(urls: string[], base: Record<string, Scraped> = scraped): Promise<Record<string, Scraped>> {
    const missing = urls.filter(u => !base[u]);
    if (!missing.length) return base;
    setParsing(p => new Set([...Array.from(p), ...missing]));
    try {
      // The scrape API caps at 15 urls per request — chunk so Top N 20/30 is fully parsed.
      const fetched: Record<string, Scraped> = {};
      for (let i = 0; i < missing.length; i += 15) {
        const chunk = missing.slice(i, i + 15);
        const res = await fetch("/api/seo/scrape", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls: chunk, firecrawlKey: getFirecrawlKey() }),
        });
        const data = await res.json();
        (data.pages || []).forEach((p: Scraped) => { fetched[p.url] = p; });
        setScraped(prev => ({ ...prev, ...fetched }));
        setParsing(p => { const n = new Set(p); chunk.forEach(u => n.delete(u)); return n; });
      }
      return { ...base, ...fetched };
    } finally {
      setParsing(p => { const n = new Set(p); missing.forEach(u => n.delete(u)); return n; });
    }
  }

  // Keyword grounding, from whichever provider the user actually configured.
  //
  // This used to be DataForSEO or nothing. `getKeywordSource()` now resolves Ahrefs → Semrush →
  // DataForSEO by which key exists, and the source that answered travels back with the data so
  // the prompt can name it instead of claiming "DataForSEO" regardless of the truth.
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
      setKwNotice(res.ok ? "" : String(data.error || ""));
    } catch { setKeywordsData([]); setKwSource(""); }
    setKwLoading(false);
  }

  async function runSerp() {
    setErr(""); setOutline(null); setArticle(""); setSerp([]); setSelected(new Set()); setScraped({}); setKeywordsData([]);
    if (!keyword.trim()) { setErr(t("seoErrEnterKeyword")); return; }
    const { provider, apiKey } = getSerpCreds();
    if (!apiKey) { setErr(t("seoErrNoSerpKey")); return; }
    setLoading("serp");
    try {
      const res = await fetch("/api/seo/serp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword, provider, apiKey, gl: country, hl: language, location, num: topN, engine }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error || t("seoErrSerp")); setLoading(""); return; }
      setSerp(data.results || []);
      setPaa(data.peopleAlsoAsk || []);
      setRelated(data.relatedSearches || []);
      setSelected(new Set((data.results || []).map((r: SerpItem) => r.url)));
      // Only when the user opted in. Off by default: a SERP scrape must not be able to spend
      // Ahrefs credits as a side effect of pressing a different button.
      if (getKwAuto()) fetchKeywords();
      // Kick off background scraping of ALL results so per-row word counts appear
      // immediately (competitor-style "Парсинг…" → count). Best-effort, non-blocking.
      ensureScraped((data.results || []).map((r: SerpItem) => r.url), {}).catch(() => {});
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setLoading("");
  }

  function toggle(url: string) {
    setSelected(s => { const n = new Set(s); n.has(url) ? n.delete(url) : n.add(url); return n; });
  }

  async function useAverage() {
    const urls = serp.filter(s => selected.has(s.url)).map(s => s.url);
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
      // Scrape manual additions in the background so their word counts show up too.
      if (additions.length) ensureScraped(additions.map(a => a.url)).catch(() => {});
      return [...prev, ...additions];
    });
    setManualUrl("");
  }

  async function generate() {
    setErr(""); setArticle("");
    const { provider, apiKey, model, baseUrl } = getTaskCreds("outline");
    if (!apiKey) { setErr(t("seoErrNoAiKey")); return; }
    const urls = serp.filter(s => selected.has(s.url)).map(s => s.url);
    if (!urls.length) { setErr(t("seoErrSelectComp")); return; }
    setLoading("outline");
    try {
      const cache = await ensureScraped(urls);
      const competitors = serp.filter(s => selected.has(s.url)).map(s => {
        const p = cache[s.url];
        return {
          position: s.position, url: s.url, site_type: s.site_type || undefined, intent: s.intent,
          title: p?.title || s.title, headings: p?.headings || [],
          word_count: p?.wordCount || 0, has_price_table: !!p?.hasPriceTable, has_faq: !!p?.hasFaq,
          text_sample: p?.textSample || undefined,
        };
      });
      const resolvedTone = resolveTone();
      const resolvedPersona = persona || activePolicy?.voice?.authorPersona || "";
      const pageGoal = goalFromTone(tone || activePolicy?.voice?.toneOfVoice || "");
      const { jobId: jid, error } = await startJob("outline", {
        keyword, language, country, competitors,
        aiProvider: provider, aiApiKey: apiKey, model: model || undefined, aiBaseUrl: baseUrl || undefined,
        policy: activePolicy, paa, related,
        tone: resolvedTone, persona: resolvedPersona,
        additionalKeywords: addKeywords.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).join(", "),
        targetWordCount: targetWords ? Number(targetWords) : undefined,
        keywordsData, keywordsSource: kwSource || undefined, pageGoal,
        narration: narration || undefined,
        customTemplate: customTemplate.trim() || undefined,
        structureRules: structureRules.trim() || undefined,
        useRag: ragOn && ragAvailable,
        ...fpc.payload(),
      });
      if (error || !jid) { setErr(error === "parse_failed" ? t("seoErrParseJson") : (error || t("seoErrGen"))); setLoading(""); return; }
      setJobId(jid); // background job started — render live progress; user can leave
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setLoading("");
  }

  async function generateText() {
    if (!outline) return;
    const { provider, apiKey, model, baseUrl } = getTaskCreds("text");
    if (!apiKey) { setErr(t("seoErrNoAiKeyShort")); return; }
    setLoading("text"); setErr("");
    try {
      const res = await fetch("/api/seo/text", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outline, policy: activePolicy, language, tone: resolveTone() || undefined, aiProvider: provider, aiApiKey: apiKey, model: model || undefined, aiBaseUrl: baseUrl || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error || t("seoErrText")); setLoading(""); return; }
      setArticle(data.text);
      const rec = addHistory({ type: "text", keyword: outline?.meta?.keyword || keyword, data: data.text });
      router.push(`/seo-tools/history/${rec.id}`); // open the rich rendered-HTML text page (no raw markdown markers)
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setLoading("");
  }

  const noSerpKey = !serpCreds.apiKey;
  const noAiKey = !ai.apiKey;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      {/* progress */}
      <Stepper step={stepNum} t={t} />

      {!jobId && (noSerpKey || noAiKey) && (
        <div className={card} style={{ borderColor: "rgba(255,159,10,0.35)", background: "rgba(255,159,10,0.06)", display: "flex", gap: "10px", alignItems: "flex-start" }}>
          <AlertTriangle size={18} color="var(--color-accent-orange)" style={{ flexShrink: 0, marginTop: "1px" }} />
          <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
            {t("seoNeedKeysPrefix")} {noSerpKey && <b>{t("seoSerpProviderLabel")}</b>}{noSerpKey && noAiKey && " + "}{noAiKey && <b>{t("seoAiProviderLabel")}</b>}.{" "}
            <Link href="/settings?tab=api-keys" style={{ color: "var(--color-accent-blue)" }}>{t("seoOpenSettings")}</Link>
          </div>
        </div>
      )}

      {/* Step 1: params (hidden while a job runs) */}
      {!jobId && (
      <div className={card}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "12px", marginBottom: "12px" }}>
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
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr auto", gap: "12px", alignItems: "end" }}>
          <Field l={t("seoLocationOpt")}><input className={inputStyle} value={location} onChange={e => setLocation(e.target.value)} placeholder={t("seoLocationPh")} /></Field>
          <Field l={t("seoEngine")}>
            <select className={inputStyle} value={engine} onChange={e => setEngine(e.target.value as any)}>
              <option value="google">Google</option>
              <option value="bing">{t("seoEngineBing")}</option>
            </select>
          </Field>
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

      {jobId && !outline && (
        <SeoJobProgress
          jobId={jobId}
          keyword={keyword}
          onDone={async (job) => { const rec = await importJob(job); setJobId(null); if (rec) router.push(`/seo-tools/history/${rec.id}`); }}
          onError={(m) => { setErr(m === "parse_failed" ? t("seoErrParseJson") : m === "generation_failed" ? t("seoErrGen") : m); setJobId(null); }}
          onCancel={() => setJobId(null)}
        />
      )}

      {/* Step 2: competitors + config (hidden while a job runs) */}
      {!jobId && serp.length > 0 && (
        <div className={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
            <h3 style={{ fontSize: "14px", fontWeight: 700, margin: 0, color: "var(--color-text-primary)" }}>
              {t("seoCompetitors")} ({selected.size}/{serp.length} {t("seoSelectedWord")})
            </h3>
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <div style={{ display: "flex", border: "1px solid var(--color-border)", borderRadius: "8px", overflow: "hidden" }}>
                {([["clusters", t("seoViewClusters"), <LayoutGrid key="c" size={13} />], ["list", t("seoViewList"), <ListIcon key="l" size={13} />]] as [typeof serpView, string, React.ReactNode][]).map(([v, lbl, ic]) => (
                  <button key={v} onClick={() => setSerpView(v)} style={{
                    display: "flex", alignItems: "center", gap: "5px", padding: "7px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none",
                    background: serpView === v ? "var(--color-text-primary)" : "var(--color-bg)",
                    color: serpView === v ? "var(--color-bg)" : "var(--color-text-secondary)",
                  }}>{ic} {lbl}</button>
                ))}
              </div>
              <button onClick={() => setSelected(new Set(serp.map(s => s.url)))} style={{ ...btnGhost, padding: "7px 12px" }}>{t("seoSelectAll")}</button>
              <button onClick={() => setSelected(new Set())} style={{ ...btnGhost, padding: "7px 12px" }}>{t("seoClearAll")}</button>
            </div>
          </div>

          {/* Dominant intent bar */}
          {(() => {
            const counts: Record<string, number> = {};
            serp.forEach(s => { if (s.intent) counts[s.intent] = (counts[s.intent] || 0) + 1; });
            const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
            if (!sorted.length) return null;
            return (
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", padding: "10px 12px", borderRadius: "10px", border: "1px solid var(--color-border)", background: "var(--color-bg)", marginBottom: "12px" }}>
                <TrendingUp size={14} color="var(--color-text-tertiary)" />
                <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("seoDominantIntent")}</span>
                {sorted.map(([intent, n], i) => (
                  <span key={intent} style={{
                    fontSize: "11px", fontWeight: 700, padding: "4px 11px", borderRadius: "20px",
                    color: i === 0 ? "var(--color-accent-blue)" : "var(--color-text-secondary)",
                    background: i === 0 ? "rgba(41,151,255,0.1)" : "transparent",
                    border: `1px solid ${i === 0 ? "rgba(41,151,255,0.35)" : "var(--color-border)"}`,
                  }}>
                    {t((INTENT_KEY[intent] || "seoIntentInfo") as any)}{sorted.length > 1 ? ` (${n})` : ""}
                  </span>
                ))}
              </div>
            );
          })()}

          {/* Competitor rows: shared renderer for both views */}
          {(() => {
            const gridCols = "26px 34px minmax(0,1fr) 130px 100px 120px";
            const Row = (s: SerpItem) => {
              const on = selected.has(s.url);
              const p = scraped[s.url];
              const wc = p?.wordCount;
              const isParsing = parsing.has(s.url) && !p;
              return (
                <div key={s.url} onClick={() => toggle(s.url)} style={{
                  display: "grid", gridTemplateColumns: gridCols, gap: "10px", alignItems: "center",
                  padding: "10px 11px", borderRadius: "8px", cursor: "pointer",
                  background: on ? "rgba(41,151,255,0.08)" : "transparent",
                  border: `1px solid ${on ? "rgba(41,151,255,0.3)" : "var(--color-border)"}`,
                }}>
                  <div style={{
                    width: 18, height: 18, borderRadius: "5px",
                    border: `1.5px solid ${on ? "var(--color-accent-blue)" : "var(--color-border)"}`,
                    background: on ? "var(--color-accent-blue)" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>{on && <Check size={12} color="#fff" />}</div>
                  <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>#{s.position}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
                    <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "4px" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s.url}</span>
                      <a href={s.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: "var(--color-text-tertiary)", flexShrink: 0, display: "flex" }}><ExternalLink size={10} /></a>
                    </div>
                  </div>
                  <span>
                    {s.site_type && (
                      <span style={{ fontSize: "10px", fontWeight: 700, padding: "3px 9px", borderRadius: "20px",
                        color: SITE_TYPE_COLOR[s.site_type] || "var(--color-text-secondary)",
                        background: `${SITE_TYPE_COLOR[s.site_type] || "#888"}1a` }}>
                        {t((SITE_TYPE_KEY[s.site_type] || "") as any) || s.site_type}
                      </span>
                    )}
                  </span>
                  <span>
                    {s.intent && (
                      <span style={{ fontSize: "10px", fontWeight: 700, padding: "3px 9px", borderRadius: "20px",
                        color: INTENT_COLOR[s.intent] || "var(--color-text-secondary)",
                        background: `${INTENT_COLOR[s.intent] || "#888"}1a` }}>
                        {t((INTENT_KEY[s.intent] || "seoIntentInfo") as any)}
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: "5px", justifyContent: "flex-end" }}>
                    {isParsing ? (<><Loader2 size={12} className="spin" /> {t("seoParsing")}</>)
                      : wc ? (<><CheckCircle2 size={13} color="#34c759" /> <b style={{ color: "var(--color-text-primary)" }}>{wc.toLocaleString()}</b></>)
                      : p ? "—" : null}
                  </span>
                </div>
              );
            };
            const Header = () => (
              <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: "10px", padding: "4px 11px", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", color: "var(--color-text-tertiary)" }}>
                <span>{t("seoColSelect")}</span><span>#</span><span>{t("seoColUrl")}</span><span>{t("seoColSiteType")}</span><span>{t("seoColIntent")}</span><span style={{ textAlign: "right" }}>{t("seoColWords")}</span>
              </div>
            );
            if (serpView === "list") {
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <Header />
                  {serp.map(Row)}
                </div>
              );
            }
            // Clusters view: group by site type
            const groups = SITE_TYPE_ORDER
              .map(gt => ({ gt, items: serp.filter(s => (s.site_type && SITE_TYPE_ORDER.includes(s.site_type) ? s.site_type : "other") === gt) }))
              .filter(g => g.items.length);
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {groups.map(({ gt, items }) => {
                  const clr = SITE_TYPE_COLOR[gt] || "var(--color-text-tertiary)";
                  const allOn = items.every(s => selected.has(s.url));
                  return (
                    <div key={gt} style={{ border: "1px solid var(--color-border)", borderRadius: "10px", padding: "10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: clr }} />
                        <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-primary)" }}>
                          {t((SITE_TYPE_KEY[gt] || "seoStOther") as any)}
                        </span>
                        <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>({items.length})</span>
                        <button onClick={() => setSelected(prev => {
                          const n = new Set(prev);
                          items.forEach(s => allOn ? n.delete(s.url) : n.add(s.url));
                          return n;
                        })} style={{ ...btnGhost, padding: "4px 9px", fontSize: "11px", marginLeft: "auto" }}>
                          {allOn ? t("seoClearAll") : t("seoSelectAll")}
                        </button>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>{items.map(Row)}</div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          {(paa.length > 0 || related.length > 0) && (
            <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid var(--color-border)", fontSize: "12px", color: "var(--color-text-secondary)" }}>
              {paa.length > 0 && <div style={{ marginBottom: "6px" }}><b>People Also Ask:</b> {paa.join(" · ")}</div>}
              {related.length > 0 && <div><b>Related:</b> {related.join(" · ")}</div>}
            </div>
          )}

          {/* The gap is stated, not left to be inferred from an absent block. Until this
              existed, an outline built with no volume data was indistinguishable from one built
              with it — and the prompt happily ranked headings by frequencies it had invented. */}
          {!kwLoading && keywordsData.length === 0 && serp.length > 0 && (
            <div style={{ marginTop: "14px", padding: "10px 12px", borderRadius: "9px", border: "1px solid rgba(245,158,11,0.28)", background: "rgba(245,158,11,0.08)", display: "flex", gap: "9px", alignItems: "flex-start" }}>
              <AlertTriangle size={14} color="#f59e0b" style={{ flexShrink: 0, marginTop: "2px" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "3px" }}>{t("seoKwNoSourceTitle")}</div>
                <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("seoKwNoSourceBody")}</div>
                {kwNotice && <div style={{ fontSize: "11px", color: "var(--color-accent-orange)", marginTop: "4px" }}>{kwNotice}</div>}
                {/* With a source configured this is one press away, priced up front. Without one
                    the only useful action is the settings link. */}
                {kwSrc.apiKey ? (
                  <button
                    onClick={fetchKeywords}
                    style={{ marginTop: "7px", display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 13px", borderRadius: "8px", border: "none", background: "var(--color-accent-purple)", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                  >
                    <TrendingUp size={12} /> {t("seoKwLoadBtn")}
                    <span style={{ opacity: 0.8, fontWeight: 400 }}>
                      · {kwPrice.units ? `${kwPrice.units.toLocaleString()} ${t("metricsUnits")} ≈ ${formatUsd(kwPrice.usd)}` : t("seoKwPriceAfter")}
                    </span>
                  </button>
                ) : (
                  <Link href="/seo-tools/settings" style={{ fontSize: "11px", color: "var(--color-accent-blue)", textDecoration: "none", display: "inline-block", marginTop: "5px" }}>{t("seoKwNoSourceCta")} →</Link>
                )}
              </div>
            </div>
          )}

          {(kwLoading || keywordsData.length > 0) && (
            <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid var(--color-border)" }}>
              {/* Names the provider that actually answered, rather than the one that used to be
                  the only option. The old label read "(DataForSEO)" no matter what. */}
              <div className="tool-section-label">
                {t("seoKwBlockTitleGeneric")}{kwSource ? ` (${kwSource === "dataforseo" ? "DataForSEO" : kwSource === "ahrefs" ? "Ahrefs" : "Semrush"})` : ""}
              </div>
              {kwLoading ? (
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: "7px" }}><Loader2 size={13} className="spin" /> {t("seoKwLoading")}</div>
              ) : (
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px", maxHeight: "240px", overflow: "auto" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                    <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{t("seoKwFeedNote")}</div>
                    {/* Bulk-add the visible keywords into the "additional keywords" field below, so the
                        SEO does not copy-paste row by row. Uses the same helper that guards dupes. */}
                    <button onClick={() => addKw(keywordsData.slice(0, 40).map(k => k.keyword))}
                      style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: 600, color: "var(--color-accent-blue)", background: "transparent", border: "1px solid var(--color-border)", borderRadius: "6px", padding: "3px 8px", cursor: "pointer" }}
                      title={t("seoKwAddAllHint")}>
                      <Plus size={11} /> {t("seoKwAddAll")}
                    </button>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px", maxHeight: "240px", overflow: "auto" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 70px 60px 80px 28px", gap: "8px", fontSize: "10px", fontWeight: 700, color: "var(--color-text-tertiary)", textTransform: "uppercase", padding: "4px 0", borderBottom: "1px solid var(--color-border)" }}>
                      <span>{t("seoKeyword")}</span><span style={{ textAlign: "right" }}>{t("seoKwVolume")}</span><span style={{ textAlign: "right" }}>{t("seoKwCpc")}</span><span style={{ textAlign: "right" }}>{t("seoKwComp")}</span><span />
                    </div>
                    {keywordsData.slice(0, 40).map((k, i) => (
                      <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 70px 60px 80px 28px", gap: "8px", fontSize: "12px", padding: "4px 0", color: "var(--color-text-secondary)", alignItems: "center" }}>
                        <span style={{ color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.keyword}</span>
                        {/* Local volume; when it is zero but a global volume exists, show it muted so a
                            brand/niche term does not read as "dead" — it is just not searched here. */}
                        <span style={{ textAlign: "right", fontWeight: 600, color: "var(--color-text-primary)" }}>
                          {k.volume.toLocaleString()}
                          {k.volume === 0 && k.globalVolume ? <span style={{ color: "var(--color-text-tertiary)", fontWeight: 400 }}> · 🌍{k.globalVolume.toLocaleString()}</span> : null}
                        </span>
                        <span style={{ textAlign: "right" }}>{k.cpc ? `$${k.cpc.toFixed(2)}` : "—"}</span>
                        <span style={{ textAlign: "right" }}>{k.competition ? `${Math.round(k.competition * 100)}%` : "—"}</span>
                        {/* Per-row add into "additional keywords". A keyword already there still shows the
                            button (cheap to re-click, and the helper dedupes), so there is no second
                            state to keep in sync with the textarea. */}
                        <button onClick={() => addKw(k.keyword)} title={t("seoKwAddHint")}
                          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "22px", height: "22px", border: "none", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer", borderRadius: "5px", padding: 0 }}
                          onMouseEnter={e => { e.currentTarget.style.background = "var(--color-bg)"; e.currentTarget.style.color = "var(--color-accent-blue)"; }}
                          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-text-tertiary)"; }}>
                          <Plus size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* config */}
          <div style={{ marginTop: "18px", paddingTop: "16px", borderTop: "1px solid var(--color-border)" }}>
            <div className="tool-section-label">{t("seoConfigTitle")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginTop: "4px" }}>
              <Field l={t("seoCfgTone")}>
                <select className={inputStyle} value={tone} onChange={e => setTone(e.target.value)}>
                  <option value="">{t("seoTonePolicyDefault")}</option>
                  {TONES.map(tn => <option key={tn.value} value={tn.value}>{t(tn.labelKey as any)}</option>)}
                  <option value="custom">{t("seoToneCustom")}</option>
                </select>
              </Field>
              <Field l={t("seoCfgPersona")}>
                <input className={inputStyle} value={persona} onChange={e => setPersona(e.target.value)} placeholder={activePolicy?.voice?.authorPersona || t("seoCfgPersonaPh")} />
              </Field>
            </div>
            {tone === "custom" && (
              <div style={{ marginTop: "12px" }}>
                <Field l={t("seoToneCustom")}>
                  <input className={inputStyle} value={customTone} onChange={e => setCustomTone(e.target.value)} placeholder={t("seoToneCustomPh")} />
                </Field>
              </div>
            )}
            <div style={{ marginTop: "12px" }}>
              <Field l={t("seoCfgNarration")}>
                <select className={inputStyle} value={narration} onChange={e => setNarration(e.target.value as any)}>
                  <option value="">{t("seoNarrationDefault")}</option>
                  <option value="first">{t("seoNarrationFirst")}</option>
                  <option value="third">{t("seoNarrationThird")}</option>
                </select>
              </Field>
            </div>
            <div style={{ marginTop: "12px" }}>
              <Field l={t("seoCfgAddKeywords")}>
                <textarea className={inputStyle} style={{ minHeight: "54px", resize: "vertical" }} value={addKeywords} onChange={e => setAddKeywords(e.target.value)} placeholder={t("seoCfgAddKeywordsPh")} />
              </Field>
            </div>
            <div style={{ marginTop: "12px" }}>
              <span className="tool-field-label">{t("seoCfgTargetWords")}</span>
              <div style={{ display: "flex", gap: "8px" }}>
                <input className={inputStyle} style={{ flex: 1 }} type="number" value={targetWords} onChange={e => setTargetWords(e.target.value)} placeholder="2500" />
                <button onClick={useAverage} disabled={loading === "avg" || !selected.size} style={btnGhost}>
                  {loading === "avg" ? <Loader2 size={13} className="spin" /> : null} {t("seoCfgUseAverage")}
                </button>
              </div>
              <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "4px" }}>{t("seoCfgAverageNote")}</div>
            </div>

            {/* add competitor URL — appends to the SERP list above (for rising sites not yet in top) */}
            <div style={{ marginTop: "14px" }}>
              <span className="tool-field-label">{t("seoCfgAddCompUrl")}</span>
              <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginBottom: "8px" }}>{t("seoCfgAddCompUrlSub")}</div>
              <div style={{ display: "flex", gap: "6px" }}>
                <input className={inputStyle} style={{ flex: 1 }} value={manualUrl} onChange={e => setManualUrl(e.target.value)} onKeyDown={e => e.key === "Enter" && addCompetitorUrls()} placeholder="https://competitor.com/page" />
                <button onClick={addCompetitorUrls} disabled={!manualUrl.trim()} style={{ ...btnGhost, opacity: manualUrl.trim() ? 1 : 0.5 }}><Plus size={13} /> {t("seoCfgAddCompUrlBtn")}</button>
              </div>
            </div>

            {/* Casino RAG knowledge-base card */}
            {ragStats !== null && (
              <div style={{ marginTop: "14px" }}>
                <span className="tool-field-label">{t("seoRagSub")}</span>
                <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginBottom: "8px" }}>{t("seoRagHint")}</div>
                <div onClick={() => ragAvailable && setRagOn(v => !v)} style={{
                  border: `1.5px solid ${ragOn && ragAvailable ? "var(--color-text-primary)" : "var(--color-border)"}`,
                  borderRadius: "12px", padding: "14px 16px", cursor: ragAvailable ? "pointer" : "default",
                  background: ragOn && ragAvailable ? "var(--color-bg)" : "transparent",
                  opacity: ragAvailable ? 1 : 0.6, maxWidth: "560px",
                }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
                    <div style={{ width: 38, height: 38, borderRadius: "9px", background: "var(--color-bg-secondary)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Database size={18} color="var(--color-text-secondary)" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("seoRagTitle")}</div>
                      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("seoRagSub")}</div>
                    </div>
                    <div style={{
                      width: 22, height: 22, borderRadius: "6px", flexShrink: 0,
                      border: `1.5px solid ${ragOn && ragAvailable ? "var(--color-text-primary)" : "var(--color-border)"}`,
                      background: ragOn && ragAvailable ? "var(--color-text-primary)" : "transparent",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>{ragOn && ragAvailable && <Check size={14} color="var(--color-bg)" />}</div>
                  </div>
                  {ragAvailable ? (
                    <>
                      <div style={{ display: "flex", gap: "18px", marginTop: "10px" }}>
                        <span style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "var(--color-text-secondary)" }}>
                          <Sparkles size={13} /> <b style={{ color: "var(--color-text-primary)" }}>{ragStats.slots.toLocaleString()}</b> {t("seoRagSlots")}
                        </span>
                        <span style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "var(--color-text-secondary)" }}>
                          <Sparkles size={13} /> <b style={{ color: "var(--color-text-primary)" }}>{ragStats.casinos.toLocaleString()}</b> {t("seoRagCasinos")}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "6px", marginTop: "10px" }}>
                        <span style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "11px", fontWeight: 600, padding: "4px 11px", borderRadius: "20px", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}>
                          <Globe2 size={11} /> {t("seoRagAllLangs")}
                        </span>
                        <span style={{ fontSize: "11px", fontWeight: 600, padding: "4px 11px", borderRadius: "20px", color: "#10A37F", background: "rgba(16,163,127,0.1)", border: "1px solid rgba(16,163,127,0.3)" }}>
                          {t("seoRagFree")}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", marginTop: "8px" }}>{t("seoRagEmpty")}</div>
                  )}
                </div>
              </div>
            )}

            {/* custom structure template + ready-made presets (incl. iGaming) */}
            <div style={{ marginTop: "14px" }}>
              <span className="tool-field-label">{t("seoCfgCustomTemplate")} <span style={{ textTransform: "none", fontWeight: 400, color: "var(--color-text-tertiary)" }}>· {t("seoCfgOptional")}</span></span>
              <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginBottom: "8px" }}>{t("seoCfgCustomTemplateSub")}</div>
              {TEMPLATE_GROUPS.map(g => {
                const tpls = OUTLINE_TEMPLATES.filter(tpl => tpl.group === g.id);
                if (!tpls.length) return null;
                return (
                  <div key={g.id} style={{ marginBottom: "8px" }}>
                    <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: "5px" }}>
                      {t(g.labelKey as any)} <span style={{ fontWeight: 400, color: "var(--color-text-tertiary)" }}>({tpls.length})</span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                      {tpls.map(tpl => {
                        const active = selectedTplId === tpl.id;
                        return (
                          <button key={tpl.id}
                            onClick={() => {
                              if (active) { setSelectedTplId(null); setCustomTemplate(""); return; }
                              setSelectedTplId(tpl.id);
                              setCustomTemplate(tpl.body.replace(/\{year\}/gi, String(new Date().getFullYear())));
                            }}
                            style={{ ...btnGhost, padding: "6px 11px",
                              background: active ? "var(--color-text-primary)" : "var(--color-bg)",
                              color: active ? "var(--color-bg)" : "var(--color-text-secondary)",
                              borderColor: active ? "var(--color-text-primary)" : "var(--color-border)" }}>
                            {t(tpl.labelKey as any)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {selectedTplId && (
                <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "2px 0 6px" }}>
                  {t("seoTplSelected")}: <span style={{ fontWeight: 600, color: "var(--color-text-secondary)" }}>{t(OUTLINE_TEMPLATES.find(x => x.id === selectedTplId)?.labelKey as any)}</span>
                </div>
              )}
              {customTemplate && (
                <div style={{ marginBottom: "8px" }}>
                  <button onClick={() => { setCustomTemplate(""); setSelectedTplId(null); }} style={{ ...btnGhost, padding: "6px 11px", color: "var(--color-accent-red)" }}><X size={12} /> {t("seoCfgClear")}</button>
                </div>
              )}
              <textarea className={inputStyle} style={{ minHeight: "90px", resize: "vertical", fontFamily: "monospace", fontSize: "12px" }} value={customTemplate} onChange={e => { setCustomTemplate(e.target.value); setSelectedTplId(null); }} placeholder={"H1: ...\nH2: ...\nH3: ..."} />
            </div>

            {/* free-form structure rules (e.g. "FAQ at the end", "price table in pricing", "more H3") */}
            <div style={{ marginTop: "14px" }}>
              <span className="tool-field-label">{t("seoCfgStructureRules")} <span style={{ textTransform: "none", fontWeight: 400, color: "var(--color-text-tertiary)" }}>· {t("seoCfgOptional")}</span></span>
              <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginBottom: "8px" }}>{t("seoCfgStructureRulesSub")}</div>
              <textarea className={inputStyle} style={{ minHeight: "70px", resize: "vertical", fontSize: "13px" }} value={structureRules} onChange={e => setStructureRules(e.target.value)} placeholder={t("seoCfgStructureRulesPh")} />
            </div>

            {/* 0.8 mirrors the cap genOutline applies to this step (lib/seo/generate.ts) — the
                number is stated in the UI so a user who types 1.4 learns what will actually run. */}
            <div style={{ marginTop: "16px" }}><FingerprintControls {...fpc} clampedTo={0.8} /></div>

            <button onClick={generate} disabled={loading === "outline"} style={{ ...btnDark, width: "100%", justifyContent: "center", marginTop: "12px", padding: "12px" }}>
              {loading === "outline" ? <Loader2 size={15} className="spin" /> : <Wand2 size={15} />}
              {t("seoGenStructure")}
            </button>
          </div>
        </div>
      )}

      {outline && <OutlineView outline={outline} onGenText={generateText} genTextLoading={loading === "text"} />}

      {article && (
        <div className={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <h3 style={{ fontSize: "14px", fontWeight: 700, margin: 0, color: "var(--color-text-primary)" }}>{t("seoGeneratedText")}</h3>
            <button onClick={() => navigator.clipboard.writeText(article)} style={btnGhost}><Copy size={14} /> {t("seoCopy")}</button>
          </div>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "13px", lineHeight: 1.6, color: "var(--color-text-primary)", margin: 0, fontFamily: "inherit" }}>{article}</pre>
        </div>
      )}

      {!outline && <SeoRecentList type="outline" />}
    </div>
  );
}

// ─── Stepper ──────────────────────────────────────────────────────────────────
function Stepper({ step, t }: { step: number; t: any }) {
  const steps = [t("seoStepParams"), t("seoStepCompetitors"), t("seoStepResults")];
  return (
    <div className="panel" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      {steps.map((label, i) => {
        const n = i + 1; const active = step === n; const done = step > n;
        return (
          <div key={n} style={{ display: "flex", alignItems: "center", gap: "10px", flex: i < 2 ? 1 : "0 0 auto" }}>
            <div style={{
              width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: 700,
              background: active ? "var(--color-text-primary)" : done ? "var(--color-accent-green)" : "var(--color-border)",
              color: active || done ? "var(--color-bg)" : "var(--color-text-secondary)",
            }}>{done ? <Check size={14} /> : n}</div>
            <span style={{ fontSize: "13px", fontWeight: active ? 700 : 500, color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}>{label}</span>
            {i < 2 && <div style={{ flex: 1, height: "1px", background: "var(--color-border)", margin: "0 6px" }} />}
          </div>
        );
      })}
    </div>
  );
}

// ─── Outline renderer (rich / EAV) ───────────────────────────────────────────────
// ─── buttons ──────────────────────────────────────────────────────────────────
const btnGhost: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px", padding: "8px 13px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" };
const btnPurple: React.CSSProperties = { display: "flex", alignItems: "center", gap: "7px", padding: "9px 18px", borderRadius: "8px", border: "none", background: "var(--color-accent-purple)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer", height: "38px" };
const btnDark: React.CSSProperties = { display: "flex", alignItems: "center", gap: "7px", padding: "9px 18px", borderRadius: "8px", border: "none", background: "var(--color-text-primary)", color: "var(--color-bg)", fontSize: "13px", fontWeight: 600, cursor: "pointer" };
