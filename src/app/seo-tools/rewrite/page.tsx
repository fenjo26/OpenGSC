"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCw, Loader2, AlertTriangle, Copy, Check, Download, Sparkles, Link2, FileText, Fingerprint, Search, Wrench, Pencil } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getTaskCreds, getFirecrawlKey } from "@/lib/seo/keys";
import { LANGUAGES } from "@/lib/seo/regions";
import { TONES } from "@/lib/seo/tones";
import { scoreText } from "@/lib/seo/aidetect";
import { getActiveModel, effectiveBannedWords, type StoredModel } from "@/lib/seo/aidetectStore";
import { factDrift, type FactDrift } from "@/lib/seo/factDrift";
import FactDriftPanel from "@/components/FactDriftPanel";
import { slugFromSource, renderAs, downloadFile, extensionFor, EXPORT_FORMATS, type ExportFormat } from "@/lib/seo/exportFormats";
import { uniquenessPct, wordCount, type KeywordCoverage } from "@/lib/seo/textMetrics";

type StructureCheck = { expected: number[]; got: number[]; ok: boolean };
type Variant = { content: string; uniqueness: number; words: number; aiScore?: number; drift?: FactDrift; structure?: StructureCheck; repaired?: boolean; coverage?: KeywordCoverage };
type Snippet = { sourceTitle: string; sourceDescription: string; title: string; description: string };

// Google truncates around these lengths; the counter turns red past them.
const TITLE_MAX = 60;
const DESC_MAX = 160;
// Under-length is not an error, but it is wasted space — a 98-character description leaves a third
// of the snippet unused. A green counter there reads as "fine" when it is actually a missed
// opportunity, so short values get their own amber state rather than sharing the good one.
const TITLE_MIN = 35;
const DESC_MIN = 120;

function lenColor(n: number, min: number, max: number) {
  return n > max ? "#ff375f" : n < min ? "#ff9f0a" : "#34c759";
}

const card = "panel";
const inputStyle: React.CSSProperties = { width: "100%", padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none", boxSizing: "border-box" };

const ghostSmall: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "5px", padding: "4px 9px", borderRadius: "7px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer", flexShrink: 0 };

function uColor(u: number) { return u >= 80 ? "#34c759" : u >= 60 ? "#ff9f0a" : "#ff375f"; }
function aColor(s: number) { return s < 15 ? "#34c759" : s < 40 ? "#ff9f0a" : "#ff375f"; }

// Which target queries the rewrite kept vs dropped — the same class of invisible risk `factDrift`
// catches for numbers. A ranking phrase is silent: nothing flags that "купить решетки на окна"
// disappeared from a 2000-word text, and the rewrite reads fine without it.
function KeywordCoveragePanel({ coverage }: { coverage: KeywordCoverage }) {
  const { t } = useLanguage();
  const { rows, covered, lost, total } = coverage;
  const color = lost > 0 ? "#ff9f0a" : "#34c759";
  const lostRows = rows.filter(r => r.lost);
  const keptRows = rows.filter(r => !r.lost && r.after > 0);
  const chip: React.CSSProperties = { fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "20px" };
  return (
    <div style={{ border: `1px solid ${color}55`, background: `${color}0d`, borderRadius: "10px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 700, color }}>
        <Search size={15} /> {t("rwCoverage")}
        <span style={{ fontWeight: 500, color: "var(--color-text-secondary)", fontSize: "12px" }}>
          · {t("rwCoverageKept")}: {covered}/{total}
          {lost > 0 && <> · {t("rwCoverageLost")}: {lost}</>}
        </span>
      </div>
      {lostRows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "#ff9f0a" }}>{t("rwCoverageLost")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
            {lostRows.map((r, i) => (
              <span key={i} style={{ ...chip, color: "#ff9f0a", background: "rgba(255,159,10,0.14)" }}>
                {r.keyword} <span style={{ opacity: 0.7 }}>{r.before}→0</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {keptRows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "#34c759" }}>{t("rwCoverageKept")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
            {keptRows.slice(0, 20).map((r, i) => (
              <span key={i} style={{ ...chip, color: "#34c759", background: "rgba(52,199,89,0.12)" }}>
                {r.keyword} <span style={{ opacity: 0.7 }}>{r.before}→{r.after}</span>
              </span>
            ))}
            {keptRows.length > 20 && <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>+{keptRows.length - 20}</span>}
          </div>
        </div>
      )}
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("rwCoverageHint")}</div>
    </div>
  );
}

export default function RewritePage() {
  const { t } = useLanguage();
  const [mounted, setMounted] = useState(false);
  const [fp, setFp] = useState<StoredModel | null>(null);
  useEffect(() => {
    setMounted(true);
    setFp(getActiveModel());
    // Prefill from ?url= (e.g. "Rewrite" launched from Content Decay).
    try {
      const u = new URLSearchParams(window.location.search).get("url");
      if (u) { setMode("url"); setUrl(u); }
    } catch {}
  }, []);

  const [mode, setMode] = useState<"text" | "url">("text");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [variants, setVariants] = useState(2);
  const [language, setLanguage] = useState("");   // "" = keep source
  const [tone, setTone] = useState("");
  const [maskAI, setMaskAI] = useState(true);
  // Off by default: both options change the request in ways an existing user did not ask for.
  const [useBanned, setUseBanned] = useState(false);
  const [temp, setTemp] = useState("");
  // One query per line — a comma-separated blob would split on commas inside phrases ("buy shoes,
  // red, size 42"). The rewriter treats these as strings it must keep; their volume is decorative.
  const [targetKeywords, setTargetKeywords] = useState("");
  const [gscBusy, setGscBusy] = useState(false);
  const [gscNote, setGscNote] = useState("");

  /**
   * Fill the target list from Search Console.
   *
   * Deliberately the first thing offered rather than an external keyword tool: a provider sells
   * market volume, while GSC knows what THIS page is already shown for. Losing a phrase the page
   * currently earns from is a worse failure than missing one it never had, and this source is
   * both free and exact. Appends rather than replaces, so a hand-written target is never wiped.
   */
  async function pullFromGsc() {
    if (gscBusy || !url.trim()) return;
    setGscBusy(true); setGscNote("");
    try {
      const res = await fetch(`/api/gsc/page-queries?url=${encodeURIComponent(url.trim())}&limit=30`);
      const d = await res.json().catch(() => ({}));
      const found: string[] = (d.queries ?? []).map((q: any) => String(q.keyword)).filter(Boolean);
      if (!res.ok || !found.length) {
        setGscNote(d.error === "not_your_site" ? t("rwGscNotYours") : t("rwGscEmpty"));
      } else {
        setTargetKeywords(prev => {
          const have = new Set(prev.split("\n").map(x => x.trim().toLowerCase()).filter(Boolean));
          const merged = prev.split("\n").map(x => x.trim()).filter(Boolean);
          for (const k of found) if (!have.has(k.toLowerCase())) { merged.push(k); have.add(k.toLowerCase()); }
          return merged.join("\n");
        });
        setGscNote(t("rwGscAdded").replace("{n}", String(found.length)));
      }
    } catch { setGscNote(t("rwGscEmpty")); }
    setGscBusy(false);
  }
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [results, setResults] = useState<Variant[] | null>(null);
  const [snippet, setSnippet] = useState<Snippet | null>(null);
  const [wantSnippet, setWantSnippet] = useState(true);
  const [copied, setCopied] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [source, setSource] = useState("");

  // Rescore an edited variant against the source the server used. Every metric on screen keeps
  // describing the text that is actually on screen — the point of letting people edit here is to
  // fix what the audit flagged, and that is only useful if the audit follows the edit.
  const editVariant = (i: number, content: string) => {
    setResults(prev => {
      if (!prev) return prev;
      const next = [...prev];
      next[i] = {
        ...next[i],
        content,
        words: wordCount(content),
        uniqueness: source ? uniquenessPct(source, content) : next[i].uniqueness,
        drift: source ? factDrift(source, content) : next[i].drift,
        aiScore: fp ? scoreText(content, fp.model).avgScore : undefined,
        repaired: next[i].repaired,
      };
      return next;
    });
  };

  const ai = mounted ? getTaskCreds("text") : { provider: "", apiKey: "", model: "", baseUrl: "" };

  async function run() {
    setErr(""); setResults(null); setSnippet(null);
    const creds = getTaskCreds("text");
    if (!creds.apiKey) { setErr(t("seoErrNoAiKey")); return; }
    if (mode === "text" && !text.trim()) { setErr(t("rwNeedText")); return; }
    if (mode === "url" && !url.trim()) { setErr(t("rwNeedUrl")); return; }
    const toneObj = TONES.find(x => x.value === tone);
    const langObj = LANGUAGES.find(l => l.code === language);

    setLoading(true);
    try {
      const res = await fetch("/api/seo/rewrite", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: mode === "text" ? text : undefined,
          url: mode === "url" ? url.trim() : undefined,
          variants, maskAI,
          language: langObj?.label || "",
          tone: toneObj?.prompt || "",
          // Concrete vocabulary from the fingerprint model — a constraint the model can act on,
          // unlike a vague "write more naturally" directive.
          bannedWords: useBanned && fp ? effectiveBannedWords(fp) : undefined,
          temperature: temp.trim() === "" ? undefined : Number(temp),
          targetKeywords: targetKeywords.trim()
            ? targetKeywords.split("\n").map(s => s.trim()).filter(Boolean).map(k => ({ keyword: k }))
            : undefined,
          snippet: wantSnippet && mode === "url",
          aiProvider: creds.provider, aiApiKey: creds.apiKey, model: creds.model || undefined, aiBaseUrl: creds.baseUrl || undefined,
          firecrawlKey: getFirecrawlKey() || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setErr(
          d.error === "no_content" ? t("rwErrNoContent")
            : d.error === "boilerplate_only" ? t("rwErrBoilerplate" as never)
            : d.error === "no_ai_key" ? t("seoErrNoAiKey")
            : d.error === "generation_failed" ? t("rwErrGen")
            : String(d.error || t("rwErrGen")));
      } else {
        // Fact drift is computed server-side (it has the source in both paste and URL mode); the
        // fingerprint score is computed here, since the model never leaves the browser.
        const vs: Variant[] = d.variants || [];
        setResults(vs.map(v => ({ ...v, aiScore: fp ? scoreText(v.content, fp.model).avgScore : undefined })));
        setSnippet(d.snippet || null);
        setSource(d.source || "");
        setEditing(null);
      }
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setLoading(false);
  }

  const copy = (i: number, s: string) => { navigator.clipboard.writeText(s).then(() => { setCopied(i); setTimeout(() => setCopied(null), 1500); }).catch(() => {}); };
  // Name the file after the page's own slug — "rewrite-1.txt" is unidentifiable once several
  // downloads sit in the same folder. Variants past the first get a numeric suffix.
  const download = (i: number, s: string, format: ExportFormat) => {
    const stem = slugFromSource({ url: mode === "url" ? url.trim() : undefined, content: s });
    // The snippet travels with the file: front matter in .md, head tags in .html, a labelled
    // header in .txt — so what gets handed to a developer is the whole change, not just the body.
    const { content, mime } = renderAs(format, s, stem, snippet ? { title: snippet.title, description: snippet.description } : undefined);
    downloadFile(content, `${stem}${(results?.length ?? 0) > 1 ? `-${i + 1}` : ""}.${extensionFor(format)}`, mime);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <div>
        <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px", display: "flex", alignItems: "center", gap: "9px" }}><RefreshCw size={20} color="#34c759" /> {t("rwTitle")}</h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("rwSub")}</p>
      </div>

      {mounted && !ai.apiKey && (
        <div className={card} style={{ borderColor: "rgba(255,159,10,0.35)", background: "rgba(255,159,10,0.06)", display: "flex", gap: "10px", alignItems: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          <AlertTriangle size={18} color="var(--color-accent-orange)" /> {t("seoNeedKeysPrefix")} <b>{t("seoAiProviderLabel")}</b>. <Link href="/settings?tab=api-keys" style={{ color: "var(--color-accent-blue)" }}>{t("seoSettingsShort")}</Link>
        </div>
      )}

      <div className={card} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        {/* Source mode */}
        <div style={{ display: "flex", gap: "2px", background: "rgba(255,255,255,0.06)", borderRadius: "8px", padding: "3px", width: "fit-content" }}>
          {([["text", t("rwModeText"), FileText], ["url", t("rwModeUrl"), Link2]] as const).map(([m, label, Icon]) => (
            <button key={m} onClick={() => setMode(m)} style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "6px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: mode === m ? "var(--color-card)" : "transparent", color: mode === m ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}>
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>

        {mode === "text"
          ? <textarea value={text} onChange={e => setText(e.target.value)} placeholder={t("rwTextPlaceholder")} rows={10} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit", lineHeight: 1.6 }} />
          : <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/article" style={inputStyle} />}

        {/* Options */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px" }}>
          <label style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("rwVariants")}
            <select value={variants} onChange={e => setVariants(parseInt(e.target.value))} style={{ ...inputStyle, marginTop: "4px" }}>
              {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("rwLanguage")}
            <select value={language} onChange={e => setLanguage(e.target.value)} style={{ ...inputStyle, marginTop: "4px" }}>
              <option value="">{t("rwKeepLanguage")}</option>
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </label>
          <label style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("rwTone")}
            <select value={tone} onChange={e => setTone(e.target.value)} style={{ ...inputStyle, marginTop: "4px" }}>
              <option value="">{t("rwToneAuto")}</option>
              {TONES.map(x => <option key={x.value} value={x.value}>{t(x.labelKey as any)}</option>)}
            </select>
          </label>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "center" }}>
          <label title={t("rwMaskHint")} style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "13px", color: maskAI ? "#8B5CF6" : "var(--color-text-secondary)", cursor: "pointer" }}>
            <input type="checkbox" checked={maskAI} onChange={e => setMaskAI(e.target.checked)} style={{ accentColor: "#8B5CF6" }} />
            <Sparkles size={14} /> {t("rwMask")}
          </label>

          <label title={fp ? t("rwBannedHint" as any) : t("hmNoModelHint" as any)}
            style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: fp ? "pointer" : "default", opacity: fp ? 1 : 0.5, color: useBanned && fp ? "#ff6482" : "var(--color-text-secondary)" }}>
            <input type="checkbox" disabled={!fp} checked={useBanned && !!fp} onChange={e => setUseBanned(e.target.checked)} style={{ accentColor: "#ff6482" }} />
            <Fingerprint size={14} /> {t("rwBanned" as any)}{fp ? ` · ${fp.name}` : ""}
          </label>

          <label title={t("rwTempHint" as any)} style={{ display: "inline-flex", alignItems: "center", gap: "7px", fontSize: "13px", color: "var(--color-text-secondary)" }}>
            {t("rwTemp" as any)}
            <input value={temp} onChange={e => setTemp(e.target.value)} placeholder={t("rwTempAuto" as any)}
              style={{ ...inputStyle, width: "92px", padding: "6px 9px" }} />
          </label>

          {/* Only offered for URL mode — pasted text carries no title or meta description to refresh. */}
          <label title={t("rwSnippetHint" as never)}
            style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: mode === "url" ? "pointer" : "default", opacity: mode === "url" ? 1 : 0.5, color: wantSnippet && mode === "url" ? "#2997ff" : "var(--color-text-secondary)" }}>
            <input type="checkbox" disabled={mode !== "url"} checked={wantSnippet && mode === "url"}
              onChange={e => setWantSnippet(e.target.checked)} style={{ accentColor: "#2997ff" }} />
            <Search size={14} /> {t("rwSnippet" as never)}
          </label>
        </div>

        {/* Target keywords — the phrases the page already ranks for, that the rewrite must keep.
            One per line; "how to" and "купить" split on whitespace into different intents, so the
            delimiter is the newline, not a space or comma. */}
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <label style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-secondary)" }}>
              {t("rwTargetKeywords")}
            </label>
            {/* Only in URL mode: without an address there is no page to look up. */}
            {mode === "url" && (
              <button type="button" onClick={pullFromGsc} disabled={gscBusy || !url.trim()}
                title={t("rwGscHint")}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px",
                  fontWeight: 600, padding: "3px 9px", borderRadius: "6px", cursor: url.trim() ? "pointer" : "not-allowed",
                  border: "1px solid var(--color-border)", background: "transparent",
                  color: url.trim() ? "var(--color-accent-blue)" : "var(--color-text-tertiary)",
                }}>
                {gscBusy ? <Loader2 size={11} className="spin" /> : <Search size={11} />} {t("rwGscPull")}
              </button>
            )}
            {gscNote && <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{gscNote}</span>}
          </div>
          <textarea
            value={targetKeywords}
            onChange={e => setTargetKeywords(e.target.value)}
            placeholder={t("rwTargetKeywordsPh")}
            rows={3}
            style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
          />
        </div>

        {err && <div style={{ fontSize: "12px", color: "#f87171", display: "flex", alignItems: "center", gap: "6px" }}><AlertTriangle size={14} /> {err}</div>}

        <button onClick={run} disabled={loading} style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "11px 18px", borderRadius: "10px", border: "none", background: "#34c759", color: "#fff", fontSize: "14px", fontWeight: 700, cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1, width: "fit-content" }}>
          {loading ? <><Loader2 size={15} className="spin" /> {t("rwWorking")}</> : <><RefreshCw size={15} /> {t("rwRun")}</>}
        </button>
      </div>

      {/* Snippet refresh — shown above the body, since it is what changes in the SERP. */}
      {snippet && (
        <div className={card} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
            <Search size={16} color="#2997ff" /> {t("rwSnippetTitle" as never)}
          </div>
          {/* Editable, because a snippet is almost never right on the first pass and the counter
              only helps if you can act on it without leaving the page. */}
          {([
            ["title", t("rwSnippetTitleLabel" as never), snippet.sourceTitle, snippet.title, TITLE_MIN, TITLE_MAX, 1],
            ["description", t("rwSnippetDescLabel" as never), snippet.sourceDescription, snippet.description, DESC_MIN, DESC_MAX, 3],
          ] as const).map(([key, label, before, after, min, max, rows]) => (
            <div key={key} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-secondary)" }}>{label}</div>
              {before && (
                <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", lineHeight: 1.5, textDecoration: "line-through", opacity: 0.75 }}>{before}</div>
              )}
              <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                <textarea
                  value={after}
                  rows={rows}
                  onChange={e => setSnippet(s => (s ? { ...s, [key]: e.target.value } : s))}
                  style={{ ...inputStyle, flex: 1, resize: "vertical", fontFamily: "inherit", lineHeight: 1.55, padding: "8px 10px" }}
                />
                <span title={after.length < min ? t("rwSnippetShort" as never) : undefined}
                  style={{ fontSize: "11px", fontWeight: 700, flexShrink: 0, paddingTop: "9px", color: lenColor(after.length, min, max) }}>
                  {after.length}/{max}
                </span>
                <button onClick={() => navigator.clipboard.writeText(after).catch(() => {})} style={{ ...ghostSmall, marginTop: "4px" }}>
                  <Copy size={12} />
                </button>
              </div>
            </div>
          ))}
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("rwSnippetInFile" as never)}</div>
        </div>
      )}

      {/* Results */}
      {results && results.map((v, i) => (
        <div key={i} className={card} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("rwVariant")} {i + 1}</div>
            <span title={t("rwUniqueHint")} style={{ fontSize: "11px", fontWeight: 700, padding: "2px 9px", borderRadius: "20px", color: uColor(v.uniqueness), background: `${uColor(v.uniqueness)}1f` }}>{v.uniqueness}% {t("rwUnique")}</span>
            {v.aiScore !== undefined && (
              <span title={t("hmProxyWarning" as any)} style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: 700, padding: "2px 9px", borderRadius: "20px", color: aColor(v.aiScore), background: `${aColor(v.aiScore)}1f` }}>
                <Fingerprint size={11} /> {v.aiScore}% {t("hmBenchScoreCol" as any)}
              </span>
            )}
            <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{v.words} {t("rwWords")}</span>
            {v.structure && !v.structure.ok && (
              <span title={t("rwStructureHint" as never)} style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: 700, padding: "2px 9px", borderRadius: "20px", color: "#ff9f0a", background: "rgba(255,159,10,0.14)" }}>
                <AlertTriangle size={11} /> {t("rwStructureOff" as never)}{" "}
                {v.structure.expected.map((n, li) => (n === v.structure!.got[li] ? null : `H${li + 1} ${v.structure!.got[li]}/${n}`)).filter(Boolean).join(", ")}
              </span>
            )}
            {v.repaired && (
              <span title={t("rwRepairedHint" as never)} style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: 700, padding: "2px 9px", borderRadius: "20px", color: "#2997ff", background: "rgba(41,151,255,0.12)" }}>
                <Wrench size={11} /> {t("rwRepaired" as never)}
              </span>
            )}
            <span style={{ flex: 1 }} />
            <button onClick={() => setEditing(editing === i ? null : i)}
              style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "5px 11px", borderRadius: "8px", border: `1px solid ${editing === i ? "var(--color-accent-blue)" : "var(--color-border)"}`, background: "var(--color-card)", color: editing === i ? "var(--color-accent-blue)" : "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
              {editing === i ? <><Check size={13} /> {t("rwEditDone" as never)}</> : <><Pencil size={13} /> {t("rwEdit" as never)}</>}
            </button>
            <button onClick={() => copy(i, v.content)} style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "5px 11px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
              {copied === i ? <><Check size={13} color="#34c759" /> {t("rwCopied")}</> : <><Copy size={13} /> {t("rwCopy")}</>}
            </button>
            {/* One download control per format. The rewrite keeps its heading tree, so .md and
                .html carry structure a .txt would flatten. */}
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "3px 6px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)" }}>
              <Download size={13} color="var(--color-text-secondary)" />
              {EXPORT_FORMATS.map(f => (
                <button key={f.id} onClick={() => download(i, v.content, f.id)}
                  title={f.id === "htmltxt" ? t("rwDownloadHtmlTxt" as never) : t("rwDownloadAs" as never)}
                  style={{ padding: "3px 8px", borderRadius: "6px", border: "none", background: "transparent", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "var(--color-bg)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                  {f.label}
                </button>
              ))}
            </span>
          </div>
          {v.drift && <FactDriftPanel drift={v.drift} />}
          {v.coverage && v.coverage.total > 0 && (
            <KeywordCoveragePanel coverage={v.coverage} />
          )}
          {editing === i ? (
            // Same box, same typography as the read view — the text must not reflow when the mode
            // changes, or the user loses their place mid-edit.
            <textarea
              value={v.content}
              onChange={e => editVariant(i, e.target.value)}
              spellCheck
              style={{ margin: 0, width: "100%", boxSizing: "border-box", resize: "vertical", whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: "13px", lineHeight: 1.7, color: "var(--color-text-primary)", background: "var(--color-bg)", border: "1px solid var(--color-accent-blue)", borderRadius: "10px", padding: "14px 16px", minHeight: "460px", outline: "none" }}
            />
          ) : (
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: "13px", lineHeight: 1.7, color: "var(--color-text-primary)", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "14px 16px", maxHeight: "460px", overflow: "auto" }}>{v.content}</pre>
          )}
        </div>
      ))}
    </div>
  );
}
