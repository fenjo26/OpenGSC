"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCw, Loader2, AlertTriangle, Copy, Check, Download, Sparkles, Link2, FileText, Fingerprint } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getTaskCreds, getFirecrawlKey } from "@/lib/seo/keys";
import { LANGUAGES } from "@/lib/seo/regions";
import { TONES } from "@/lib/seo/tones";
import { scoreText } from "@/lib/seo/aidetect";
import { getActiveModel, effectiveBannedWords, type StoredModel } from "@/lib/seo/aidetectStore";
import { factDrift, type FactDrift } from "@/lib/seo/factDrift";
import FactDriftPanel from "@/components/FactDriftPanel";

type Variant = { content: string; uniqueness: number; words: number; aiScore?: number; drift?: FactDrift };

const card = "panel";
const inputStyle: React.CSSProperties = { width: "100%", padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none", boxSizing: "border-box" };

function uColor(u: number) { return u >= 80 ? "#34c759" : u >= 60 ? "#ff9f0a" : "#ff375f"; }
function aColor(s: number) { return s < 15 ? "#34c759" : s < 40 ? "#ff9f0a" : "#ff375f"; }

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
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [results, setResults] = useState<Variant[] | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  const ai = mounted ? getTaskCreds("text") : { provider: "", apiKey: "", model: "", baseUrl: "" };

  async function run() {
    setErr(""); setResults(null);
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
          aiProvider: creds.provider, aiApiKey: creds.apiKey, model: creds.model || undefined, aiBaseUrl: creds.baseUrl || undefined,
          firecrawlKey: getFirecrawlKey() || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setErr(d.error === "no_content" ? t("rwErrNoContent") : d.error === "no_ai_key" ? t("seoErrNoAiKey") : d.error === "generation_failed" ? t("rwErrGen") : String(d.error || t("rwErrGen")));
      } else {
        // Fact drift is computed server-side (it has the source in both paste and URL mode); the
        // fingerprint score is computed here, since the model never leaves the browser.
        const vs: Variant[] = d.variants || [];
        setResults(vs.map(v => ({ ...v, aiScore: fp ? scoreText(v.content, fp.model).avgScore : undefined })));
      }
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setLoading(false);
  }

  const copy = (i: number, s: string) => { navigator.clipboard.writeText(s).then(() => { setCopied(i); setTimeout(() => setCopied(null), 1500); }).catch(() => {}); };
  const download = (i: number, s: string) => {
    const blob = new Blob([s], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `rewrite-${i + 1}.txt`; a.click(); URL.revokeObjectURL(a.href);
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
        </div>

        {err && <div style={{ fontSize: "12px", color: "#f87171", display: "flex", alignItems: "center", gap: "6px" }}><AlertTriangle size={14} /> {err}</div>}

        <button onClick={run} disabled={loading} style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "11px 18px", borderRadius: "10px", border: "none", background: "#34c759", color: "#fff", fontSize: "14px", fontWeight: 700, cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1, width: "fit-content" }}>
          {loading ? <><Loader2 size={15} className="spin" /> {t("rwWorking")}</> : <><RefreshCw size={15} /> {t("rwRun")}</>}
        </button>
      </div>

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
            <span style={{ flex: 1 }} />
            <button onClick={() => copy(i, v.content)} style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "5px 11px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
              {copied === i ? <><Check size={13} color="#34c759" /> {t("rwCopied")}</> : <><Copy size={13} /> {t("rwCopy")}</>}
            </button>
            <button onClick={() => download(i, v.content)} title={t("exportCsv")} style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "5px 11px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
              <Download size={13} /> .txt
            </button>
          </div>
          {v.drift && <FactDriftPanel drift={v.drift} />}
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: "13px", lineHeight: 1.7, color: "var(--color-text-primary)", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "14px 16px", maxHeight: "460px", overflow: "auto" }}>{v.content}</pre>
        </div>
      ))}
    </div>
  );
}
