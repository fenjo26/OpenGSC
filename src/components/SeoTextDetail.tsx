"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, Pencil, Copy, FileText, Download, ChevronDown, Save, Check, X, Code2,
  ExternalLink, Target, Hash, ListTree, ArrowUp, Shield, ImageIcon, Loader2, Wand2, AlertTriangle,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { HistoryItem, getHistoryItem, updateHistory, patchHistory } from "@/lib/seo/history";
import { outlineHeadings, articleHeadings, markdownToHtml, htmlDocument, countWords, splitArticleSections, hasVerifiableFacts } from "@/lib/seo/outlineFormat";
import { getSeoGenCreds, getTaskCreds, getSerpCreds, getFirecrawlKey, getAutoFactcheck, getAutoImages, getFactSourceCount, getFactBearingOnly, getFactReuseCorpus, getKieKey } from "@/lib/seo/keys";
import { IMAGE_MODELS, imageModel, type ImageModelId } from "@/lib/seo/imageModels";

export default function SeoTextDetail({ item: initial }: { item: HistoryItem }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [item, setItem] = useState(initial);
  const [tab, setTab] = useState<"text" | "fact" | "img">("text");
  const [edit, setEdit] = useState(false);
  const [editText, setEditText] = useState("");
  const [dlOpen, setDlOpen] = useState(false);
  const [copied, setCopied] = useState("");
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [showHtml, setShowHtml] = useState(false);
  const topRef = useRef<HTMLDivElement>(null);

  const article: string = typeof item.data === "string" ? item.data : (item.data?.article || "");
  const outlineItem = item.meta?.outlineId ? getHistoryItem(item.meta.outlineId) : null;
  const outline = outlineItem?.data;
  const artHeadings = useMemo(() => articleHeadings(article), [article]);
  const outlineHd = useMemo(() => outline ? outlineHeadings(outline) : [], [outline]);

  const planWords = Number(outline?.meta?.target_word_count) || 0;
  const factWords = countWords(article);
  const delta = planWords ? Math.round(((factWords - planWords) / planWords) * 1000) / 10 : 0;

  function flash(k: string) { setCopied(k); setTimeout(() => setCopied(""), 1500); }
  const copiedStyle = (active: boolean): React.CSSProperties => active
    ? { borderColor: "var(--color-accent-green)", background: "rgba(52,199,89,0.12)", color: "var(--color-accent-green)" } : {};
  function copyAll() { navigator.clipboard.writeText(article).then(() => flash("all")); }
  function copyHeadings() { navigator.clipboard.writeText(artHeadings.map(h => `${h.level}: ${h.text}`).join("\n")).then(() => flash("hd")); }
  function copyForDocs() {
    const html = markdownToHtml(article);
    try {
      (navigator.clipboard as any).write([new (window as any).ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([article], { type: "text/plain" }) })]).then(() => flash("docs"));
    } catch { navigator.clipboard.writeText(article).then(() => flash("docs")); }
  }
  function download(kind: "docx" | "html" | "txt" | "md") {
    const kw = (item.keyword || "text").replace(/\s+/g, "-").slice(0, 40);
    let content = article, mime = "text/markdown", ext = "md";
    if (kind === "txt") { mime = "text/plain"; ext = "txt"; }
    if (kind === "html") { content = htmlDocument(item.keyword, markdownToHtml(article)); mime = "text/html"; ext = "html"; }
    if (kind === "docx") { content = htmlDocument(item.keyword, markdownToHtml(article)); mime = "application/msword"; ext = "doc"; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([content], { type: mime })); a.download = `${kw}.${ext}`; a.click(); setDlOpen(false);
  }
  function saveEdit() { updateHistory(item.id, editText); setItem({ ...item, data: editText }); setEdit(false); }

  return (
    <div ref={topRef} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Toolbar */}
      <div className="panel" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <button onClick={() => router.push("/seo-tools/history")} style={{ ...btnGhost, padding: "8px" }}><ArrowLeft size={16} /></button>
        <div>
          <h2 style={{ fontSize: "17px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("seoGeneratedTextTitle")}</h2>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("seoCreatedAt")}: {new Date(item.createdAt).toLocaleString()}</div>
        </div>
        <div style={{ flex: 1 }} />
        {!edit ? <button onClick={() => { setEditText(article); setEdit(true); }} style={btnGhost}><Pencil size={15} /> {t("seoEditBtn")}</button>
          : <button onClick={() => setEdit(false)} style={btnGhost}><X size={14} /> {t("seoCancelEdit")}</button>}
        <button onClick={copyAll} style={{ ...btnGhost, ...copiedStyle(copied === "all") }}>{copied === "all" ? <Check size={15} /> : <Copy size={15} />} {copied === "all" ? t("seoCopied") : t("seoCopyShort")}</button>
        <button onClick={copyForDocs} style={{ ...btnGhost, ...copiedStyle(copied === "docs") }}>{copied === "docs" ? <Check size={15} /> : <FileText size={15} />} {copied === "docs" ? t("seoCopied") : t("seoForGoogleDocs")}</button>
        <button onClick={() => setShowHtml(true)} style={btnGhost}><Code2 size={15} /> {t("seoFormatHtml")}</button>
        <div style={{ position: "relative" }}>
          <button onClick={() => setDlOpen(o => !o)} style={btnGhost}><Download size={15} /> {t("seoDownload")} <ChevronDown size={13} /></button>
          {dlOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setDlOpen(false)} />
              <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 41, background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "8px", overflow: "hidden", minWidth: "140px", boxShadow: "0 8px 24px rgba(0,0,0,0.3)" }}>
                {(["docx", "html", "txt", "md"] as const).map(k => <button key={k} onClick={() => download(k)} style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 14px", fontSize: "13px", color: "var(--color-text-primary)", background: "transparent", border: "none", cursor: "pointer" }}>{k === "docx" ? ".docx (Word)" : k === "html" ? ".html (h1–h6)" : `.${k}`}</button>)}
              </div>
            </>
          )}
        </div>
        {edit && <button onClick={saveEdit} style={btnDark}><Save size={15} /> {t("seoSaveBtn")}</button>}
      </div>

      {/* Outline summary card — always shown; uses the linked outline when present,
          otherwise falls back to the article's own keyword / words / headings. */}
      {(() => {
        const structHd = outline ? outlineHd : artHeadings;
        return (
        <div className="panel">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}><FileText size={15} /> {t("seoOutlineCard")}</div>
            {outline && item.meta?.outlineId && <button onClick={() => router.push(`/seo-tools/history/${item.meta!.outlineId}`)} style={btnGhost}><ExternalLink size={14} /> {t("seoOpenOutline")}</button>}
          </div>
          <Row icon={<Target size={14} />} label={t("seoMainKey")} value={outline?.meta?.keyword || item.keyword} />
          <div style={{ display: "flex", gap: "9px", margin: "10px 0 6px" }}>
            <Hash size={14} color="var(--color-text-tertiary)" style={{ marginTop: "2px", flexShrink: 0 }} />
            <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
              {planWords ? <>{t("seoPlanWords")}: <b style={{ color: "var(--color-text-primary)" }}>{planWords} {t("seoWordsShortUnit")}</b><span style={{ margin: "0 14px" }} /></> : null}
              {t("seoFactWords")}: <b style={{ color: "var(--color-text-primary)" }}>{factWords} {t("seoWordsShortUnit")}</b>
              {planWords ? <b style={{ marginLeft: "14px", color: delta > 0 ? "var(--color-accent-red)" : "var(--color-accent-green)" }}>{delta > 0 ? "+" : ""}{delta}%</b> : null}
            </div>
          </div>
          {outlineItem?.createdAt && <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", marginBottom: "8px" }}>{t("seoOutlineCreated")}: {new Date(outlineItem.createdAt).toLocaleDateString()}</div>}
          {structHd.length > 0 && (
          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: "10px" }}>
            <button onClick={() => setOutlineOpen(o => !o)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>
              <span>{t("seoOutlineStructure")} · {structHd.length} {t("seoHeadingsCount")}</span>
              <ChevronDown size={16} style={{ transform: outlineOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
            </button>
            {outlineOpen && (
              <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "4px" }}>
                {structHd.map((h, i) => (
                  <div key={i} style={{ fontSize: "13px", paddingLeft: h.level === "H3" ? "20px" : h.level === "H4" ? "36px" : 0, color: h.level === "H1" ? "var(--color-text-primary)" : h.level === "H2" ? "var(--color-text-primary)" : "var(--color-text-secondary)", fontWeight: h.level === "H1" ? 700 : 400 }}>{h.text}</div>
                ))}
              </div>
            )}
          </div>
          )}
        </div>
        );
      })()}

      {/* Tabs */}
      <div className="panel">
        <div style={{ display: "flex", gap: "6px", marginBottom: "16px", background: "var(--color-bg)", padding: "4px", borderRadius: "10px", width: "fit-content" }}>
          {([["text", t("seoTabTextView"), FileText], ["fact", t("seoTabFactCheck"), Shield], ["img", t("seoTabImages"), ImageIcon]] as const).map(([k, label, Icon]) => (
            <button key={k} onClick={() => setTab(k as any)} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "7px", fontSize: "13px", fontWeight: tab === k ? 700 : 500, cursor: "pointer", border: "none", background: tab === k ? "var(--color-card)" : "transparent", color: tab === k ? "var(--color-text-primary)" : "var(--color-text-secondary)", boxShadow: tab === k ? "0 1px 3px rgba(0,0,0,0.15)" : "none" }}><Icon size={15} /> {label}</button>
          ))}
        </div>

        <div style={{ display: tab === "text" ? "block" : "none" }}>
        {(
          edit ? (
            <textarea className="tool-input" style={{ minHeight: "460px", resize: "vertical", fontFamily: "monospace", fontSize: "13px" }} value={editText} onChange={e => setEditText(e.target.value)} />
          ) : (
            <div style={{ display: "flex", gap: "20px", alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="seo-article" dangerouslySetInnerHTML={{ __html: markdownToHtml(article) }} />
                {/* Back-to-top right where the reader finishes the article */}
                <div style={{ display: "flex", justifyContent: "center", marginTop: "22px" }}>
                  <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} style={{ ...btnGhost, padding: "12px 28px" }}><ArrowUp size={15} /> {t("seoToTop")}</button>
                </div>
              </div>
              <div style={{ width: "300px", flexShrink: 0 }}>
                <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px", position: "sticky", top: "16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "10px" }}>
                    <ListTree size={15} color="var(--color-text-secondary)" />
                    <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("seoHeadingsLbl")}</span>
                    <span style={{ marginLeft: "auto", fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "10px", background: "var(--color-bg)", color: "var(--color-text-secondary)" }}>{artHeadings.length}</span>
                  </div>
                  <button onClick={copyHeadings} style={{ ...btnGhost, width: "100%", justifyContent: "center", marginBottom: "10px", ...copiedStyle(copied === "hd") }}>{copied === "hd" ? <Check size={13} /> : <Copy size={13} />} {copied === "hd" ? t("seoCopied") : t("seoCopyAllHeadings")}</button>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "calc(100vh - 230px)", overflow: "auto", borderTop: "1px solid var(--color-border)", paddingTop: "10px" }}>
                    {artHeadings.map((h, i) => (
                      <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start", paddingLeft: h.level === "H3" ? "14px" : h.level === "H4" ? "26px" : 0 }}>
                        <span style={{ fontSize: "9px", fontWeight: 700, padding: "2px 5px", borderRadius: "4px", flexShrink: 0, background: h.level === "H1" ? "var(--color-bg)" : h.level === "H2" ? "rgba(41,151,255,0.12)" : "rgba(52,199,89,0.14)", color: h.level === "H1" ? "var(--color-text-secondary)" : h.level === "H2" ? "var(--color-accent-blue)" : "var(--color-accent-green)" }}>{h.level}</span>
                        <span style={{ fontSize: "12px", color: h.level === "H3" ? "var(--color-text-secondary)" : "var(--color-text-primary)", lineHeight: 1.4, fontWeight: h.level === "H1" ? 700 : 400 }}>{h.text}</span>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} style={{ ...btnGhost, width: "100%", justifyContent: "center", marginTop: "10px" }}><ArrowUp size={14} /> {t("seoToTop")}</button>
                </div>
              </div>
            </div>
          )
        )}
        </div>

        <div style={{ display: tab === "fact" ? "block" : "none" }}>
          <FactCheck item={item} setItem={setItem} article={article} t={t} autoStart />
        </div>
        <div style={{ display: tab === "img" ? "block" : "none" }}>
          <Images item={item} setItem={setItem} outline={outline} article={article} t={t} autoStart />
        </div>
      </div>

      <style>{`
        .seo-article h1 { font-size: 28px; font-weight: 700; margin: 0 0 12px; color: var(--color-text-primary); }
        .seo-article h2 { font-size: 21px; font-weight: 700; margin: 26px 0 10px; color: var(--color-text-primary); border-top: 1px solid var(--color-border); padding-top: 18px; }
        .seo-article h3 { font-size: 17px; font-weight: 600; margin: 18px 0 8px; color: var(--color-text-primary); }
        .seo-article p { font-size: 15px; line-height: 1.7; color: var(--color-text-primary); margin: 0 0 12px; }
        .seo-article ul, .seo-article ol { margin: 0 0 12px; padding-left: 22px; color: var(--color-text-primary); }
        .seo-article li { font-size: 15px; line-height: 1.7; margin-bottom: 4px; }
        .seo-article table { width: 100%; border-collapse: collapse; margin: 0 0 16px; font-size: 14px; }
        .seo-article th, .seo-article td { border: 1px solid var(--color-border); padding: 8px 11px; text-align: left; color: var(--color-text-primary); }
        .seo-article th { background: var(--color-bg); font-weight: 700; }
      `}</style>

      {showHtml && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", padding: "24px" }} onClick={() => setShowHtml(false)}>
          <div className="panel" style={{ width: "820px", maxWidth: "95vw", maxHeight: "85vh", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
              <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}><Code2 size={16} /> {t("seoFormatHtml")}</div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button onClick={() => navigator.clipboard.writeText(htmlDocument(item.keyword, markdownToHtml(article))).then(() => flash("html"))} style={{ ...btnGhost, ...copiedStyle(copied === "html") }}>{copied === "html" ? <Check size={14} /> : <Copy size={14} />} {copied === "html" ? t("seoCopied") : t("seoCopyShort")}</button>
                <button onClick={() => setShowHtml(false)} style={{ ...btnGhost, padding: "8px" }}><X size={14} /></button>
              </div>
            </div>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "12px", lineHeight: 1.55, color: "var(--color-text-primary)", margin: 0, fontFamily: "monospace", overflow: "auto" }}>{htmlDocument(item.keyword, markdownToHtml(article))}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Fact-check tab (real per-section source verification) ───────────────────────
function buildFcReport(results: any[]) {
  let c = 0, p = 0, u = 0, src = 0;
  results.forEach(sec => { (sec.facts || []).forEach((f: any) => { if (f.status === "confirmed") c++; else if (f.status === "unconfirmed") u++; else p++; }); src += (sec.sources || []).length; });
  const total = c + p + u || 1;
  return { overall_percent: Math.round((c + p * 0.5) / total * 100), summary: { confirmed: c, partial: p, unconfirmed: u }, total_facts: c + p + u, total_sources: src, sections: results };
}

function FactCheck({ item, setItem, article, t, autoStart }: any) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [err, setErr] = useState("");
  const [fixing, setFixing] = useState(false);
  const [fixed, setFixed] = useState(false);
  const [allOpen, setAllOpen] = useState<boolean | null>(null);
  const report = item.meta?.factcheck;
  const hasSerp = typeof window !== "undefined" && !!getSerpCreds().apiKey;
  const badFacts: { claim: string; status: string; note: string }[] = (report?.sections || [])
    .flatMap((sec: any) => (sec.facts || []).filter((f: any) => f.status !== "confirmed").map((f: any) => ({ claim: f.claim, status: f.status, note: f.note || "" })))
    .filter((f: any) => f.claim);

  async function fixText() {
    const ai = getTaskCreds("text");
    if (!ai.apiKey || !badFacts.length || fixing) return;
    setFixing(true); setErr("");
    try {
      const res = await fetch("/api/seo/factfix", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ article, claims: badFacts, keyword: item.keyword, aiProvider: ai.provider, aiApiKey: ai.apiKey, model: ai.model || undefined, aiBaseUrl: ai.baseUrl || undefined }),
      });
      const data = await res.json();
      if (res.ok && data.text) {
        // Apply the fixed text AND drop the now-stale fact-check report so the user re-checks.
        updateHistory(item.id, data.text);
        patchHistory(item.id, { meta: { factcheck: undefined } });
        setItem((prev: any) => ({ ...prev, data: data.text, meta: { ...prev.meta, factcheck: undefined } }));
        setFixed(true);
      } else setErr(data.error || t("seoErrText"));
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setFixing(false);
  }

  useEffect(() => {
    if (autoStart && getAutoFactcheck() && !report && !running && getTaskCreds("text").apiKey) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    setErr("");
    const ai = getTaskCreds("text"); const serp = getSerpCreds();
    if (!ai.apiKey) { setErr(t("seoErrNoAiKey")); return; }
    // Region/language of the article (from the source outline) → locale-relevant sources
    // (French regulator pages for a French article instead of generic US results).
    const srcOutline = item.meta?.outlineId ? getHistoryItem(item.meta.outlineId) : null;
    const gl = srcOutline?.data?.meta?.country || undefined;
    const hl = srcOutline?.data?.meta?.language || undefined;
    let sections = splitArticleSections(article);
    if (!sections.length) { setErr("—"); return; }
    // Saver #2: only fact-check sections that actually contain verifiable facts.
    if (getFactBearingOnly()) {
      const withFacts = sections.filter(s => hasVerifiableFacts(s.text));
      if (withFacts.length) sections = withFacts; // keep all if nothing matched (avoid empty report)
    }
    setRunning(true); setProgress({ done: 0, total: sections.length });

    // Saver #1: build ONE shared competitor corpus and verify every section against it,
    // instead of a live SERP per section. Off by default; uses the same SERP+scrape path once.
    let shared: any[] | null = null;
    if (getFactReuseCorpus() && serp.apiKey) {
      try {
        const sr = await fetch("/api/seo/serp", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keyword: item.keyword, provider: serp.provider, apiKey: serp.apiKey, num: 10, engine: "google" }),
        }).then(r => r.json());
        const results0 = sr.results || [];
        const cnt = getFactSourceCount();
        const top = results0.slice(0, cnt).map((r: any) => r.url);
        let pages: any[] = [];
        if (cnt > 0 && top.length) {
          pages = (await fetch("/api/seo/scrape", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: top, firecrawlKey: getFirecrawlKey() || undefined }) }).then(r => r.json())).pages || [];
        }
        shared = results0.map((r: any) => {
          const p = pages.find((x: any) => x.url === r.url);
          const ev = p ? `${p.metaDescription || ""} ${p.textSample || ""}`.trim().slice(0, 1100) : "";
          return { title: r.title, snippet: ev || r.snippet, url: r.url, domain: r.domain };
        });
      } catch { shared = null; }
    }

    const results: any[] = [];
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      try {
        const body: any = { heading: s.heading, text: s.text, keyword: item.keyword, aiProvider: ai.provider, aiApiKey: ai.apiKey, model: ai.model || undefined, aiBaseUrl: ai.baseUrl || undefined };
        if (shared) { body.sources = shared; } // reuse-corpus mode → route skips its own SERP
        else { body.serpProvider = serp.provider; body.serpKey = serp.apiKey; body.firecrawlKey = getFirecrawlKey() || undefined; body.scrapeCount = getFactSourceCount(); body.engine = "google"; body.gl = gl; body.hl = hl; }
        const res = await fetch("/api/seo/factcheck-section", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        results.push(res.ok ? { heading: s.heading, status: data.status, facts: data.facts, sources: data.sources } : { heading: s.heading, status: "partial", facts: [], sources: data.sources || [] });
      } catch { results.push({ heading: s.heading, status: "partial", facts: [], sources: [] }); }
      setProgress({ done: i + 1, total: sections.length });
      const partial = buildFcReport(results);
      patchHistory(item.id, { meta: { factcheck: partial } });
      setItem((prev: any) => ({ ...prev, meta: { ...prev.meta, factcheck: partial } }));
    }
    setRunning(false);
  }

  if (!report && !running) return (
    <div style={{ textAlign: "center", padding: "30px 12px" }}>
      {fixed && (
        <div style={{ maxWidth: "520px", margin: "0 auto 14px", padding: "11px 14px", borderRadius: "10px", background: "rgba(52,199,89,0.1)", border: "1px solid rgba(52,199,89,0.3)", fontSize: "13px", color: "var(--color-accent-green)", display: "flex", alignItems: "center", gap: "8px", justifyContent: "center" }}>
          <Check size={15} /> {t("seoFcFixedNote")}
        </div>
      )}
      <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", marginBottom: "12px", maxWidth: "520px", margin: "0 auto 12px" }}>{hasSerp ? t("seoFcRealNote") : t("seoFcNoSerpNote")}</div>
      {err && <div style={{ color: "var(--color-accent-red)", fontSize: "13px", marginBottom: "10px" }}>{err}</div>}
      <button onClick={run} style={btnPurple}><Shield size={15} /> {hasSerp ? t("seoFcRunReal") : t("seoFcRun")}</button>
    </div>
  );

  const s = report?.summary || {};
  const total = (s.confirmed || 0) + (s.partial || 0) + (s.unconfirmed || 0) || 1;
  return (
    <div>
      {running && (
        <div style={{ marginBottom: "14px", padding: "10px 14px", borderRadius: "8px", background: "rgba(41,151,255,0.06)", border: "1px solid rgba(41,151,255,0.2)", fontSize: "13px", color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: "9px" }}>
          <Loader2 size={15} className="spin" color="var(--color-accent-blue)" /> {t("seoFcChecking")} {progress.done}/{progress.total}
        </div>
      )}
      {report && (
        <>
          <div style={{ height: "5px", borderRadius: "3px", overflow: "hidden", display: "flex", marginBottom: "14px" }}>
            <div style={{ width: `${(s.confirmed || 0) / total * 100}%`, background: "var(--color-accent-green)" }} />
            <div style={{ width: `${(s.partial || 0) / total * 100}%`, background: "var(--color-accent-orange)" }} />
            <div style={{ width: `${(s.unconfirmed || 0) / total * 100}%`, background: "var(--color-accent-red)" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}><Shield size={17} /> {t("seoFcResult")}</div>
            <span style={{ fontSize: "13px", fontWeight: 700, padding: "5px 12px", borderRadius: "20px", background: "var(--color-text-primary)", color: "var(--color-bg)" }}>{report.overall_percent}% {t("seoFcConfirmedPct")}</span>
          </div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "14px" }}>{report.total_facts} {t("seoFcFacts")} · {report.total_sources} {t("seoFcSourcesWord")} · {(report.sections || []).length} {t("seoFcSections")}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px", marginBottom: "12px" }}>
            <Stat n={s.confirmed || 0} label={t("seoFcConfirmed")} color="var(--color-accent-green)" />
            <Stat n={s.partial || 0} label={t("seoFcPartial")} color="var(--color-accent-orange)" />
            <Stat n={s.unconfirmed || 0} label={t("seoFcUnconfirmed")} color="var(--color-accent-red)" />
          </div>
          {badFacts.length > 0 && (
            <div style={{ marginBottom: "14px", padding: "12px 14px", borderRadius: "10px", background: "rgba(255,159,10,0.06)", border: "1px solid rgba(255,159,10,0.25)" }}>
              <div className="tool-section-label" style={{ marginBottom: "10px" }}>{t("seoFcIssuesTitle")} ({badFacts.length})</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "9px", marginBottom: "12px" }}>
                {badFacts.map((f, i) => (
                  <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "12.5px", lineHeight: 1.45 }}>
                    <span style={{ flexShrink: 0, marginTop: "2px", fontSize: "10px", fontWeight: 700, padding: "2px 7px", borderRadius: "20px", color: statusColor(f.status), background: `${statusColor(f.status)}1a`, whiteSpace: "nowrap" }}>{statusLabel(f.status, t)}</span>
                    <div>
                      <span style={{ color: "var(--color-text-primary)" }}>{f.claim}</span>
                      {f.note && <span style={{ color: "var(--color-text-secondary)" }}> — {f.note}</span>}
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={fixText} disabled={fixing} style={{ ...btnPurple, opacity: fixing ? 0.6 : 1 }}>
                {fixing ? <Loader2 size={15} className="spin" /> : <Wand2 size={15} />} {t("seoFcFixBtn")} ({badFacts.length})
              </button>
              <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "8px" }}>{t("seoFcFixHint")}</div>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginBottom: "10px", fontSize: "12px" }}>
            <button onClick={() => setAllOpen(true)} style={{ background: "none", border: "none", color: "var(--color-accent-blue)", cursor: "pointer" }}>{t("seoExpandAll")}</button>
            <span style={{ color: "var(--color-border)" }}>·</span>
            <button onClick={() => setAllOpen(false)} style={{ background: "none", border: "none", color: "var(--color-accent-blue)", cursor: "pointer" }}>{t("seoCollapseAll")}</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {(report.sections || []).map((sec: any, i: number) => <FcSection key={i} sec={sec} t={t} forceOpen={allOpen} />)}
          </div>
        </>
      )}
    </div>
  );
}
function Stat({ n, label, color }: { n: number; label: string; color: string }) {
  return <div style={{ padding: "14px", borderRadius: "10px", border: `1px solid ${color}33`, background: `${color}0d` }}><div style={{ fontSize: "24px", fontWeight: 700, color }}>{n}</div><div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{label}</div></div>;
}
function statusColor(st: string) { return st === "confirmed" ? "var(--color-accent-green)" : st === "unconfirmed" ? "var(--color-accent-red)" : "var(--color-accent-orange)"; }
function statusLabel(st: string, t: any) { return st === "confirmed" ? t("seoFcConfirmed") : st === "unconfirmed" ? t("seoFcUnconfirmed") : t("seoFcPartial"); }
function FcSection({ sec, t, forceOpen }: any) {
  const [open, setOpen] = useState(false);
  const isOpen = forceOpen != null ? forceOpen : open;
  const c = statusColor(sec.status);
  const sources = sec.sources || [];
  return (
    <div style={{ border: `1px solid ${c}33`, borderRadius: "10px", overflow: "hidden", background: `${c}08` }}>
      <div onClick={() => setOpen(forceOpen != null ? !forceOpen : !open)} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "12px 14px", cursor: "pointer" }}>
        <AlertTriangle size={16} color={c} style={{ flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)" }}>{sec.heading}</div>
          <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{(sec.facts || []).length} {t("seoFcFacts")} · {sources.length} {t("seoFcSourcesWord")}</div>
        </div>
        <span style={{ fontSize: "11px", fontWeight: 700, padding: "4px 11px", borderRadius: "20px", color: c, background: `${c}1a` }}>{statusLabel(sec.status, t)}</span>
        <ChevronDown size={16} style={{ transform: isOpen ? "rotate(180deg)" : "none", color: "var(--color-text-secondary)", flexShrink: 0 }} />
      </div>
      {isOpen && (
        <div style={{ padding: "0 14px 14px", background: "var(--color-card)" }}>
          {(sec.facts || []).length > 0 && (
            <>
              <div className="tool-section-label" style={{ paddingTop: "12px", marginBottom: "8px" }}>{t("seoFcCheckedFacts")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
                {sec.facts.map((f: any, j: number) => {
                  const fc = statusColor(f.status);
                  return (
                    <div key={j} style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.55, padding: "9px 11px", borderRadius: "8px", background: `${fc}0d`, border: `1px solid ${fc}22` }}>
                      <AlertTriangle size={12} color={fc} style={{ display: "inline", verticalAlign: "middle", marginRight: "5px" }} />
                      <span style={{ color: "var(--color-text-primary)" }}>{f.claim}</span>{f.note ? ` ${f.note}` : ""}
                      {(f.sources || []).map((n: number, k: number) => <a key={k} href={sources[n - 1]?.url} target="_blank" rel="noreferrer" style={{ fontSize: "10px", fontWeight: 700, color: "var(--color-accent-blue)", marginLeft: "3px", textDecoration: "none" }}>[{n}]</a>)}
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {sources.length > 0 && (
            <>
              <div className="tool-section-label" style={{ paddingTop: "14px", marginBottom: "8px" }}>{t("seoFcSourcesTitle")} ({sources.length})</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                {sources.map((src: any, k: number) => (
                  <div key={k} style={{ fontSize: "12px", display: "flex", gap: "7px" }}>
                    <span style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }}>[{k + 1}]</span>
                    <a href={src.url} target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{src.title || src.domain}</a>
                    <span style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }}>{src.domain}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Images tab ───────────────────────────────────────────────────────────────
type GenStatus = { status: "generating" | "done" | "error"; url?: string; error?: string };

function Images({ item, setItem, outline, article, t, autoStart }: any) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  const images = item.meta?.images;

  // Real image rendering (kie.ai) — separate from the prompt-generation step above.
  const [imgModel, setImgModel] = useState<ImageModelId>("gpt-image-2-text-to-image");
  const [imgResolution, setImgResolution] = useState<"1K" | "2K" | "4K">("1K");
  const [imgAspect, setImgAspect] = useState("auto");
  const [genState, setGenState] = useState<Record<string, GenStatus>>({});

  useEffect(() => {
    if (autoStart && getAutoImages() && !images && !loading && getTaskCreds("text").apiKey) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    setErr("");
    const { provider, apiKey, model, baseUrl } = getTaskCreds("text");
    if (!apiKey) { setErr(t("seoErrNoAiKey")); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/seo/images", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outline, article: outline ? undefined : article, keyword: item.keyword, aiProvider: provider, aiApiKey: apiKey, model: model || undefined, aiBaseUrl: baseUrl || undefined }) });
      const data = await res.json();
      if (!res.ok) { setErr(data.error || "error"); setLoading(false); return; }
      patchHistory(item.id, { meta: { images: data.images } });
      setItem((prev: any) => ({ ...prev, meta: { ...prev.meta, images: data.images } }));
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setLoading(false);
  }
  const copy = (txt: string, k: string) => navigator.clipboard.writeText(txt).then(() => { setCopied(k); setTimeout(() => setCopied(""), 1500); });

  // Create a kie.ai render task for one prompt (hero, or section index `s${i}`), poll it to
  // completion, then persist the resulting URL into item.meta.images so it survives a reload.
  // Persist a finished URL into item.meta.images so it survives a reload. Shared by both the
  // synchronous provider and the tail of the polling loop.
  function saveGeneratedUrl(key: string, url: string) {
    setGenState(s => ({ ...s, [key]: { status: "done", url } }));
    const nextImages = { ...images };
    if (key === "hero") {
      nextImages.hero = typeof nextImages.hero === "string" ? { prompt: nextImages.hero, generatedUrl: url } : { ...nextImages.hero, generatedUrl: url };
    } else {
      const idx = Number(key.slice(1));
      nextImages.sections = (nextImages.sections || []).map((sec: any, i: number) => i === idx ? { ...sec, generatedUrl: url } : sec);
    }
    patchHistory(item.id, { meta: { images: nextImages } });
    setItem((prev: any) => ({ ...prev, meta: { ...prev.meta, images: nextImages } }));
  }

  async function generateImage(key: string, prompt: string) {
    // Each model names the key it needs — kie.ai and Z.AI are billed separately, and picking a
    // Z.AI model with only a kie.ai key configured used to fail with kie.ai's error text.
    const def = imageModel(imgModel);
    const apiKey = (typeof window === "undefined" ? "" : localStorage.getItem(def?.keyName || "aiKey_kie") || "");
    if (!apiKey) { setGenState(s => ({ ...s, [key]: { status: "error", error: t("seoImgNoKieKey") } })); return; }
    setGenState(s => ({ ...s, [key]: { status: "generating" } }));
    try {
      const input: Record<string, any> = { prompt, aspect_ratio: imgAspect, resolution: imgResolution };
      if (imgModel === "nano-banana-2") input.output_format = "jpg";
      const createRes = await fetch("/api/seo/image-gen", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: imgModel, input, apiKey,
          baseUrl: def?.provider === "zai" ? (localStorage.getItem("aiBaseUrl_zai") || undefined) : undefined,
        }),
      });
      const createData = await createRes.json();
      if (!createRes.ok) { setGenState(s => ({ ...s, [key]: { status: "error", error: createData.error || "error" } })); return; }

      // Z.AI renders synchronously and hands back the URL in this same response — nothing to poll.
      if (Array.isArray(createData.urls) && createData.urls.length) { saveGeneratedUrl(key, createData.urls[0]); return; }

      if (!createData.taskId) { setGenState(s => ({ ...s, [key]: { status: "error", error: createData.error || "error" } })); return; }
      const taskId = createData.taskId;

      const deadline = Date.now() + 5 * 60 * 1000; // kie.ai docs: stop polling after ~10-15min; 5min is plenty for stills
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        const stRes = await fetch("/api/seo/image-gen/status", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId, apiKey }),
        });
        const st = await stRes.json();
        if (st.state === "success" && st.resultUrls?.length) {
          saveGeneratedUrl(key, st.resultUrls[0]);
          return;
        }
        if (st.state === "fail" || st.error) { setGenState(s => ({ ...s, [key]: { status: "error", error: st.error || "generation_failed" } })); return; }
        // waiting / queuing / generating → keep polling
      }
      setGenState(s => ({ ...s, [key]: { status: "error", error: "timeout" } }));
    } catch (e: any) { setGenState(s => ({ ...s, [key]: { status: "error", error: String(e?.message ?? e) } })); }
  }

  if (!images) return (
    <div style={{ textAlign: "center", padding: "30px 12px" }}>
      {err && <div style={{ color: "var(--color-accent-red)", fontSize: "13px", marginBottom: "10px" }}>{err}</div>}
      <button onClick={run} disabled={loading} style={btnPurple}>{loading ? <Loader2 size={15} className="spin" /> : <Wand2 size={15} />} {loading ? t("seoRunning") : t("seoImgGenerate")}</button>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {/* Real render settings — shared by every "Generate image" button below */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", padding: "10px 12px", borderRadius: "10px", background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
        <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-secondary)" }}>{t("seoImgRenderWith")}</span>
        <select value={imgModel} onChange={e => setImgModel(e.target.value as ImageModelId)} className="tool-input" style={{ width: "auto", padding: "6px 10px", fontSize: "12px" }}>
          {IMAGE_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <select value={imgResolution} onChange={e => setImgResolution(e.target.value as any)} className="tool-input" style={{ width: "auto", padding: "6px 10px", fontSize: "12px" }}>
          <option value="1K">1K</option>
          <option value="2K">2K</option>
          <option value="4K">4K</option>
        </select>
        <select value={imgAspect} onChange={e => setImgAspect(e.target.value)} className="tool-input" style={{ width: "auto", padding: "6px 10px", fontSize: "12px" }}>
          {["auto", "1:1", "16:9", "9:16", "4:3", "3:4"].map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        {/* Warn about the key the SELECTED model needs, not always kie.ai's — the picker now spans
            two providers with separate billing, and the old check called a working setup broken. */}
        {typeof window !== "undefined" && !localStorage.getItem(imageModel(imgModel)?.keyName || "aiKey_kie") && (
          <span style={{ fontSize: "11px", color: "var(--color-accent-orange)" }}>{t("seoImgNoKieKey")}</span>
        )}
      </div>

      {images.hero && (() => {
        const hp = typeof images.hero === "string" ? images.hero : images.hero?.prompt;
        const ha = typeof images.hero === "object" ? images.hero?.alt : "";
        const ht = typeof images.hero === "object" ? images.hero?.title : "";
        const generatedUrl = typeof images.hero === "object" ? images.hero?.generatedUrl : undefined;
        return (
          <div style={{ borderRadius: "12px", overflow: "hidden", border: "1px solid var(--color-border)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "linear-gradient(90deg, var(--color-accent-purple), #ff2d92)" }}>
              <span style={{ fontSize: "14px", fontWeight: 700, color: "#fff", display: "flex", alignItems: "center", gap: "8px" }}><ImageIcon size={15} /> {t("seoImgHero")}</span>
              <button onClick={() => copy(hp, "hero")} style={{ ...btnGhost, background: "rgba(255,255,255,0.2)", border: "none", color: "#fff" }}>{copied === "hero" ? <Check size={13} /> : <Copy size={13} />} {copied === "hero" ? t("seoCopied") : t("seoCopyShort")}</button>
            </div>
            <div style={{ padding: "14px 16px", fontSize: "13px", lineHeight: 1.6, color: "var(--color-text-primary)" }}>{hp}</div>
            {(ha || ht) && <ImgSeoMeta alt={ha} title={ht} />}
            <GeneratedImageBlock genKey="hero" prompt={hp} generatedUrl={generatedUrl} genState={genState["hero"]} onGenerate={generateImage} t={t} />
          </div>
        );
      })()}
      {(images.sections || []).map((s: any, i: number) => (
        <div key={i} style={{ border: "1px solid var(--color-border)", borderRadius: "10px", padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", marginBottom: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
              <span style={{ width: 22, height: 22, borderRadius: "50%", background: "rgba(191,90,242,0.14)", color: "var(--color-accent-purple)", fontSize: "11px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
              <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)" }}>{s.heading}</span>
            </div>
            <button onClick={() => copy(s.prompt, `s${i}`)} style={{ ...btnGhost, ...(copied === `s${i}` ? { borderColor: "var(--color-accent-green)", background: "rgba(52,199,89,0.12)", color: "var(--color-accent-green)" } : {}) }}>{copied === `s${i}` ? <Check size={13} /> : <Copy size={13} />} {copied === `s${i}` ? t("seoCopied") : t("seoImgCopyPrompt")}</button>
          </div>
          <div style={{ fontSize: "13px", lineHeight: 1.6, color: "var(--color-text-secondary)" }}>{s.prompt}</div>
          {(s.alt || s.title) && <ImgSeoMeta alt={s.alt} title={s.title} />}
          <GeneratedImageBlock genKey={`s${i}`} prompt={s.prompt} generatedUrl={s.generatedUrl} genState={genState[`s${i}`]} onGenerate={generateImage} t={t} />
        </div>
      ))}
    </div>
  );
}

// One prompt's render state: idle → "Generate image" button; generating → spinner; done → <img>
// + download link (kie.ai result URLs expire after ~24h, hence the download-now nudge).
function GeneratedImageBlock({ genKey, prompt, generatedUrl, genState, onGenerate, t }: {
  genKey: string; prompt: string; generatedUrl?: string; genState?: GenStatus; onGenerate: (key: string, prompt: string) => void; t: any;
}) {
  const url = genState?.url || generatedUrl;
  const busy = genState?.status === "generating";
  return (
    <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: "1px dashed var(--color-border)" }}>
      {url ? (
        <div>
          <img src={url} alt={prompt} style={{ maxWidth: "100%", borderRadius: "8px", display: "block" }} />
          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
            <a href={url} download target="_blank" rel="noreferrer" style={{ ...btnGhost, textDecoration: "none" }}><Download size={13} /> {t("seoImgDownload")}</a>
            <button onClick={() => onGenerate(genKey, prompt)} disabled={busy} style={btnGhost}>{busy ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />} {t("seoImgRegenerate")}</button>
          </div>
        </div>
      ) : (
        <div>
          <button onClick={() => onGenerate(genKey, prompt)} disabled={busy} style={btnPurple}>
            {busy ? <Loader2 size={14} className="spin" /> : <ImageIcon size={14} />} {busy ? t("seoImgGenerating") : t("seoImgGenerateReal")}
          </button>
          {genState?.status === "error" && <div style={{ fontSize: "12px", color: "var(--color-accent-red)", marginTop: "6px" }}>{genState.error}</div>}
        </div>
      )}
    </div>
  );
}

function ImgSeoMeta({ alt, title }: { alt?: string; title?: string }) {
  return (
    <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: "1px dashed var(--color-border)", display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
      {alt && <div style={{ color: "var(--color-text-secondary)" }}><b style={{ color: "var(--color-text-tertiary)" }}>alt:</b> {alt}</div>}
      {title && <div style={{ color: "var(--color-text-secondary)" }}><b style={{ color: "var(--color-text-tertiary)" }}>title:</b> {title}</div>}
    </div>
  );
}
function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value?: string }) {
  if (!value) return null;
  return <div style={{ display: "flex", gap: "9px" }}><span style={{ color: "var(--color-text-tertiary)", marginTop: "1px", flexShrink: 0 }}>{icon}</span><div><div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{label}</div><div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)" }}>{value}</div></div></div>;
}

const btnGhost: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px", padding: "8px 13px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" };
const btnPurple: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "7px", padding: "10px 20px", borderRadius: "8px", border: "none", background: "var(--color-accent-purple)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" };
const btnDark: React.CSSProperties = { display: "flex", alignItems: "center", gap: "7px", padding: "8px 16px", borderRadius: "8px", border: "none", background: "var(--color-text-primary)", color: "var(--color-bg)", fontSize: "13px", fontWeight: 600, cursor: "pointer" };
