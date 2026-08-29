"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Code2, Copy, Download, ChevronDown, Pencil, Wand2, Check, X,
  FileText, ListTree, Target, Hash, HelpCircle, ArrowUp, Loader2,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { readUrlParam, writeUrlParam } from "@/lib/urlParam";
import { OutlineStructure, OutlineEntities } from "@/components/SeoRenderers";
import SeoContentAnalysis from "@/components/SeoContentAnalysis";
import SeoTextDetail from "@/components/SeoTextDetail";
import SeoLandingDetail from "@/components/SeoLandingDetail";
import SeoClusterDetail from "@/components/SeoClusterDetail";
import { getHistoryItem, resolveHistoryItem, updateHistory, addHistory, HistoryItem } from "@/lib/seo/history";
import { outlineToMarkdown, outlineToHtml, htmlDocument, outlineHeadings, outlineSummary } from "@/lib/seo/outlineFormat";
import { getSeoGenCreds, getSerpCreds, getFirecrawlKey, getFactSourceCount, getHardRedact, loadPolicies, getActivePolicyName } from "@/lib/seo/keys";
import { TONES, toneToPrompt } from "@/lib/seo/tones";
import { LANGUAGES } from "@/lib/seo/regions";

export default function TaskDetailPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const params = useParams();
  const id = String(params?.id || "");

  const [item, setItem] = useState<HistoryItem | null | undefined>(undefined);
  const [tab, setTab] = useState<"structure" | "entities">("structure");
  // Deep link (?tab=entities): restore on mount, mirror on change. Validated against the union,
  // so a stale param falls back to the default.
  useEffect(() => {
    const p = readUrlParam("tab");
    if (p === "structure" || p === "entities") setTab(p);
  }, []);
  useEffect(() => { writeUrlParam("tab", tab); }, [tab]);
  const [showHtml, setShowHtml] = useState(false);
  const [dlOpen, setDlOpen] = useState(false);
  const [edit, setEdit] = useState(false);
  const [editText, setEditText] = useState("");
  const [copied, setCopied] = useState("");
  const [genOpen, setGenOpen] = useState(false);
  const topRef = useRef<HTMLDivElement>(null);

  // Cache-first: the local copy paints instantly; a record evicted from the cache (older than
  // the newest 150) is fetched from the server, which keeps every record forever.
  useEffect(() => {
    let alive = true;
    const local = getHistoryItem(id);
    if (local) { setItem(local); return; }
    setItem(undefined);
    resolveHistoryItem(id).then(rec => { if (alive) setItem(rec); });
    return () => { alive = false; };
  }, [id]);

  useEffect(() => {
    if (item && item.type === "googlebot") {
      router.push(`/seo-tools/googlebot?historyId=${item.id}`);
    }
  }, [item, router]);

  const isOutline = item?.type === "outline";
  const isText = item?.type === "text";
  const isAnalysis = item?.type === "analysis";

  const headings = useMemo(() => isOutline && item ? outlineHeadings(item.data) : [], [item, isOutline]);
  const summary = useMemo(() => isOutline && item ? outlineSummary(item.data) : null, [item, isOutline]);

  function flash(k: string) { setCopied(k); setTimeout(() => setCopied(""), 1500); }
  function plainText(): string {
    if (!item) return "";
    if (isText) return typeof item.data === "string" ? item.data : "";
    if (isOutline) return outlineToMarkdown(item.data);
    return JSON.stringify(item.data, null, 2);
  }
  function copyAll() { navigator.clipboard.writeText(plainText()).then(() => flash("all")); }

  function copyForDocs() {
    const html = isOutline ? outlineToHtml(item!.data) : `<pre>${plainText()}</pre>`;
    try {
      const blob = new Blob([html], { type: "text/html" });
      const txt = new Blob([plainText()], { type: "text/plain" });
      (navigator.clipboard as any).write([new (window as any).ClipboardItem({ "text/html": blob, "text/plain": txt })]).then(() => flash("docs"));
    } catch { navigator.clipboard.writeText(plainText()).then(() => flash("docs")); }
  }

  function copyHeadings() { navigator.clipboard.writeText(headings.map(h => `${h.level}: ${h.text}`).join("\n")).then(() => flash("headings")); }

  function download(kind: "md" | "txt" | "docx") {
    if (!item) return;
    const kw = (item.keyword || "task").replace(/\s+/g, "-").slice(0, 40);
    let content = plainText(); let mime = "text/markdown"; let ext = "md";
    if (kind === "txt") { mime = "text/plain"; ext = "txt"; }
    if (kind === "docx") {
      const body = isOutline ? outlineToHtml(item.data) : `<pre>${plainText()}</pre>`;
      content = htmlDocument(item.keyword, body); mime = "application/msword"; ext = "doc";
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = `${kw}.${ext}`; a.click();
    setDlOpen(false);
  }

  function startEdit() { setEditText(isText ? plainText() : JSON.stringify(item!.data, null, 2)); setEdit(true); }
  function saveEdit() {
    if (!item) return;
    let data: any = editText;
    if (!isText) { try { data = JSON.parse(editText); } catch { return; } }
    updateHistory(item.id, data); setItem({ ...item, data }); setEdit(false);
  }

  if (item === undefined) return <div style={{ padding: "40px", textAlign: "center", color: "var(--color-text-secondary)" }}><Loader2 size={20} className="spin" /></div>;
  if (item === null) return (
    <div className="panel" style={{ textAlign: "center" }}>
      <p style={{ color: "var(--color-text-secondary)" }}>{t("seoNotFound")}</p>
      <button onClick={() => router.push("/seo-tools/history")} style={btnGhost}><ArrowLeft size={14} /> {t("seoBackToHistory")}</button>
    </div>
  );

  if (item.type === "googlebot") return <div style={{ padding: "40px", textAlign: "center", color: "var(--color-text-secondary)" }}><Loader2 size={20} className="spin" /></div>;
  if (item.type === "text") return <SeoTextDetail item={item} />;
  if (item.type === "landing") return <SeoLandingDetail item={item} />;
  if (item.type === "cluster") return <SeoClusterDetail item={item} />;

  return (
    <div ref={topRef} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Toolbar */}
      <div className="panel" style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <button onClick={() => router.push("/seo-tools/history")} style={btnGhost}><ArrowLeft size={15} /> {t("seoBackToHistory")}</button>
        <div style={{ flex: 1 }} />
        {isOutline && <button onClick={() => setShowHtml(true)} style={btnGhost}><Code2 size={15} /> {t("seoViewHtml")}</button>}
        <button onClick={copyAll} style={btnGhost}>{copied === "all" ? <Check size={15} /> : <Copy size={15} />} {t("seoCopyAll")}</button>
        <div style={{ position: "relative" }}>
          <button onClick={() => setDlOpen(o => !o)} style={btnGhost}><Download size={15} /> {t("seoDownload")} <ChevronDown size={13} /></button>
          {dlOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setDlOpen(false)} />
              <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 41, background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "8px", overflow: "hidden", minWidth: "150px", boxShadow: "0 8px 24px rgba(0,0,0,0.3)" }}>
                {(["docx", "txt", "md"] as const).map(k => (
                  <button key={k} onClick={() => download(k)} style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 14px", fontSize: "13px", color: "var(--color-text-primary)", background: "transparent", border: "none", cursor: "pointer" }}>{k === "docx" ? ".docx (Word)" : k === "txt" ? ".txt" : ".md"}</button>
                ))}
              </div>
            </>
          )}
        </div>
        {!edit ? <button onClick={startEdit} style={btnGhost}><Pencil size={15} /> {t("seoEditBtn")}</button>
          : <><button onClick={() => setEdit(false)} style={btnGhost}><X size={14} /> {t("seoCancelEdit")}</button><button onClick={saveEdit} style={btnPurple}><Check size={14} /> {t("seoSaveEdit")}</button></>}
        {isOutline && <button onClick={() => setGenOpen(true)} style={btnDark}><Wand2 size={15} /> {t("seoGenText")}</button>}
      </div>

      {/* Header */}
      <div className="panel">
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
          <div>
            <h2 style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{item.keyword}</h2>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px" }}>
              {t("seoCreatedAt")}: {new Date(item.createdAt).toLocaleString()} · ID: {item.id.slice(0, 8)}…
            </div>
          </div>
          <span style={{ fontSize: "11px", fontWeight: 700, padding: "4px 12px", borderRadius: "20px", background: "var(--color-text-primary)", color: "var(--color-bg)" }}>{t("seoDone")}</span>
        </div>
      </div>

      {/* Body */}
      <div className="panel">
        <h3 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 14px" }}>{t("seoContentTab")}</h3>

        {edit ? (
          <textarea className="tool-input" style={{ minHeight: "420px", resize: "vertical", fontFamily: "monospace", fontSize: "12px" }} value={editText} onChange={e => setEditText(e.target.value)} />
        ) : isAnalysis ? (
          <SeoContentAnalysis report={item.data} />
        ) : isText ? (
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "13px", lineHeight: 1.6, color: "var(--color-text-primary)", margin: 0, fontFamily: "inherit" }}>{plainText()}</pre>
        ) : (
          <>
            {/* tabs — segmented control for clear visibility */}
            <div style={{ display: "inline-flex", gap: "4px", marginBottom: "16px", padding: "4px", borderRadius: "10px", background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
              {([["structure", t("seoTabContentStructure")], ["entities", t("seoTabEntityAnalysis")]] as const).map(([k, label]) => {
                const on = tab === k;
                return (
                  <button key={k} onClick={() => setTab(k as any)} style={{ padding: "8px 16px", borderRadius: "8px", fontSize: "13px", fontWeight: on ? 700 : 500, cursor: "pointer", border: "none", background: on ? "var(--color-accent-purple)" : "transparent", color: on ? "#fff" : "var(--color-text-secondary)", boxShadow: on ? "0 1px 3px rgba(0,0,0,0.2)" : "none", transition: "all 0.15s" }}>{label}</button>
                );
              })}
            </div>

            <div style={{ display: "flex", gap: "20px", alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "10px" }}>
                  <button onClick={copyForDocs} style={btnGhost}>{copied === "docs" ? <Check size={14} /> : <FileText size={14} />} {t("seoCopyForDocs")}</button>
                </div>
                {tab === "structure" ? <OutlineStructure outline={item.data} /> : <OutlineEntities outline={item.data} />}
              </div>

              {/* sidebar */}
              <div style={{ width: "300px", flexShrink: 0, display: "flex", flexDirection: "column", gap: "14px" }}>
                <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
                  <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "7px", marginBottom: "12px" }}><FileText size={15} /> {t("seoContentOutlineCard")}</div>
                  <SidebarRow icon={<Target size={14} />} label={t("seoMainKeyword")} value={summary?.keyword} />
                  {summary?.targetWords ? <SidebarRow icon={<Hash size={14} />} label={t("seoTargetWordsLbl")} value={`${summary.targetWords} ${t("seoWordsUnit")} (±15%)`} /> : null}
                  {summary?.available ? <SidebarRow icon={<FileText size={14} />} label={t("seoAvailableLbl")} value={`${summary.available} ${t("seoWordsUnit")}`} /> : null}
                  {summary?.faqCount ? <SidebarRow icon={<HelpCircle size={14} />} label={t("seoFaqReserved")} value={`${summary.faqReserved} ${t("seoWordsUnit")} (${summary.faqCount} ${t("seoQuestions")})`} /> : null}
                </div>

                <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "10px" }}>
                    <ListTree size={15} color="var(--color-text-secondary)" />
                    <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("seoHeadingsLbl")}</span>
                    <span style={{ marginLeft: "auto", fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "10px", background: "var(--color-bg)", color: "var(--color-text-secondary)" }}>{headings.length}</span>
                  </div>
                  <button onClick={copyHeadings} style={{ ...btnGhost, width: "100%", justifyContent: "center", marginBottom: "10px" }}>{copied === "headings" ? <Check size={13} /> : <Copy size={13} />} {t("seoCopyAllHeadings")}</button>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--color-border)", paddingTop: "10px" }}>
                    {headings.map((h, i) => (
                      <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start", paddingLeft: h.level === "H3" ? "16px" : h.level === "H4" ? "28px" : 0 }}>
                        <span style={{ fontSize: "9px", fontWeight: 700, padding: "2px 5px", borderRadius: "4px", flexShrink: 0,
                          background: h.level === "H1" ? "var(--color-bg)" : h.level === "H2" ? "rgba(41,151,255,0.12)" : "rgba(52,199,89,0.14)",
                          color: h.level === "H1" ? "var(--color-text-secondary)" : h.level === "H2" ? "var(--color-accent-blue)" : "var(--color-accent-green)" }}>{h.level}</span>
                        <span style={{ fontSize: "12px", color: h.level === "H3" || h.level === "H4" ? "var(--color-text-secondary)" : "var(--color-text-primary)", lineHeight: 1.4, fontWeight: h.level === "H1" ? 700 : h.level === "H2" ? 600 : 400 }}>{h.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Scroll to top */}
      <div style={{ display: "flex", justifyContent: "center" }}>
        <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} style={{ ...btnGhost, padding: "12px 28px" }}><ArrowUp size={15} /> {t("seoToTop")}</button>
      </div>

      {showHtml && <HtmlModal title={item.keyword} html={outlineToHtml(item.data)} t={t} onClose={() => setShowHtml(false)} />}
      {genOpen && <GenTextModal item={item} t={t} onClose={() => setGenOpen(false)} onDone={(rec) => { setGenOpen(false); router.push(`/seo-tools/history/${rec.id}`); }} />}
    </div>
  );
}

function SidebarRow({ icon, label, value }: { icon: React.ReactNode; label: string; value?: string }) {
  if (!value) return null;
  return (
    <div style={{ display: "flex", gap: "9px", marginBottom: "12px" }}>
      <span style={{ color: "var(--color-text-tertiary)", marginTop: "1px", flexShrink: 0 }}>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{label}</div>
        <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", wordBreak: "break-word" }}>{value}</div>
      </div>
    </div>
  );
}

function HtmlModal({ title, html, t, onClose }: { title: string; html: string; t: any; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const full = htmlDocument(title, html);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", padding: "24px" }} onClick={onClose}>
      <div className="panel" style={{ width: "760px", maxWidth: "95vw", maxHeight: "85vh", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}><Code2 size={16} /> HTML</div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={() => navigator.clipboard.writeText(full).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })} style={btnGhost}>{copied ? <Check size={14} /> : <Copy size={14} />} {t("seoCopyAll")}</button>
            <button onClick={onClose} style={{ ...btnGhost, padding: "8px" }}><X size={14} /></button>
          </div>
        </div>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: "12px", lineHeight: 1.5, color: "var(--color-text-primary)", margin: 0, fontFamily: "monospace", overflow: "auto" }}>{full}</pre>
      </div>
    </div>
  );
}

function GenTextModal({ item, t, onClose, onDone }: { item: HistoryItem; t: any; onClose: () => void; onDone: (rec: HistoryItem) => void }) {
  const policies = loadPolicies();
  const [policyName, setPolicyName] = useState(getActivePolicyName());
  const [tone, setTone] = useState("");
  const [language, setLanguage] = useState("en");
  const [sourceMode, setSourceMode] = useState<"off" | "facts" | "cited">("off");
  const [promptType, setPromptType] = useState<"service" | "custom">("service");
  const [custom, setCustom] = useState("");
  const [includeToc, setIncludeToc] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  async function run() {
    setErr("");
    const { provider, apiKey, model } = getSeoGenCreds();
    if (!apiKey) { setErr(t("seoErrNoAiKey")); return; }
    setLoading(true);
    try {
      const policy = policies.find(p => p.name === policyName) || policies[0];
      const resolvedTone = tone ? toneToPrompt(tone) : toneToPrompt(policy?.voice?.toneOfVoice || "");
      const serp = getSerpCreds();
      const res = await fetch("/api/seo/text", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outline: item.data, keyword: item.keyword, policy, language, tone: resolvedTone || undefined, sourceMode, includeToc, promptType, custom: promptType === "custom" ? (custom.trim() || undefined) : undefined, serpProvider: serp.provider, serpKey: serp.apiKey || undefined, serpBaseUrl: serp.baseUrl, firecrawlKey: getFirecrawlKey() || undefined, scrapeCount: getFactSourceCount(), hardRedact: getHardRedact(), aiProvider: provider, aiApiKey: apiKey, model: model || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error || t("seoErrText")); setLoading(false); return; }
      const rec = addHistory({ type: "text", keyword: item.keyword, data: data.text, meta: { outlineId: item.id, tone: tone || policy?.voice?.toneOfVoice || "" } });
      onDone(rec);
    } catch (e: any) { setErr(String(e?.message ?? e)); setLoading(false); }
  }

  const label: React.CSSProperties = { fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", display: "block", marginBottom: "6px", marginTop: "14px" };
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", padding: "24px" }} onClick={onClose}>
      <div className="panel" style={{ width: "480px", maxWidth: "95vw" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
          <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}><Wand2 size={17} color="var(--color-accent-purple)" /> {t("seoGenTextModalTitle")}</div>
          <button onClick={onClose} style={{ ...btnGhost, padding: "6px" }}><X size={14} /></button>
        </div>
        <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("seoGenTextModalSub")}</div>

        <div style={{ marginTop: "14px", padding: "12px 14px", borderRadius: "8px", background: "var(--color-bg)" }}>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("seoGenTextKeyword")}:</div>
          <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)" }}>{item.keyword}</div>
        </div>

        <label style={label}>{t("seoGenTextPolicy")}</label>
        <select className="tool-input" value={policyName} onChange={e => setPolicyName(e.target.value)}>
          {policies.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>

        <label style={label}>{t("seoGenTextTone")}</label>
        <select className="tool-input" value={tone} onChange={e => setTone(e.target.value)}>
          <option value="">{t("seoTonePolicyDefault")}</option>
          {TONES.map(tn => <option key={tn.value} value={tn.value}>{t(tn.labelKey as any)}</option>)}
        </select>

        <label style={label}>{t("seoGenTextLang")}</label>
        <select className="tool-input" value={language} onChange={e => setLanguage(e.target.value)}>
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>

        <label style={label}>{t("seoSourcesMode")}</label>
        <select className="tool-input" value={sourceMode} onChange={e => setSourceMode(e.target.value as any)}>
          <option value="off">{t("seoSourcesOff")}</option>
          <option value="facts">{t("seoSourcesFacts")}</option>
          <option value="cited">{t("seoSourcesCited")}</option>
        </select>
        <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "6px" }}>{t("seoSourcesModeHint")}</div>

        <label style={label}>{t("seoPromptType")}</label>
        <div style={{ display: "flex", gap: "14px" }}>
          {([["service", t("seoPromptService")], ["custom", t("seoPromptCustom")]] as const).map(([v, l]) => (
            <label key={v} style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "13px", color: "var(--color-text-primary)", cursor: "pointer" }}>
              <input type="radio" checked={promptType === v} onChange={() => {
                setPromptType(v as any);
                if (v === "custom" && !custom.trim()) setCustom(t("seoCustomPromptSkeleton"));
              }} /> {l}
            </label>
          ))}
        </div>
        {promptType === "custom" && (
          <div style={{ marginTop: "8px" }}>
            <textarea className="tool-input" style={{ minHeight: "150px", resize: "vertical", fontSize: "12px" }} value={custom} onChange={e => setCustom(e.target.value)} />
            <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "4px" }}>{t("seoCustomPromptHint")}</div>
          </div>
        )}

        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--color-text-primary)", cursor: "pointer", marginTop: "14px" }}>
          <input type="checkbox" checked={includeToc} onChange={e => setIncludeToc(e.target.checked)} /> {t("seoIncludeToc")}
        </label>

        {err && <div style={{ fontSize: "12px", color: "var(--color-accent-red)", marginTop: "10px" }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
          <button onClick={onClose} style={btnGhost}>{t("seoCancelEdit")}</button>
          <button onClick={run} disabled={loading} style={btnPurple}>{loading ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />} {t("seoGenerate")}</button>
        </div>
      </div>
    </div>
  );
}

const btnGhost: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px", padding: "8px 13px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" };
const btnPurple: React.CSSProperties = { display: "flex", alignItems: "center", gap: "7px", padding: "8px 16px", borderRadius: "8px", border: "none", background: "var(--color-accent-purple)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" };
const btnDark: React.CSSProperties = { display: "flex", alignItems: "center", gap: "7px", padding: "8px 16px", borderRadius: "8px", border: "none", background: "var(--color-text-primary)", color: "var(--color-bg)", fontSize: "13px", fontWeight: 600, cursor: "pointer" };
