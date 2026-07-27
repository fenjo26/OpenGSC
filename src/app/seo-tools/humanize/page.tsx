"use client";

// AI-Fingerprint Lab. Three tabs, one idea: measure before you change anything.
//
// The premise is that statistical detectors score bag-of-words distributions over ~300-word
// windows, which makes them reproducible locally against your OWN corpus — competitors' pages as
// the human reference, your generation history as the machine reference. The score is the least
// interesting output; the marker vocabulary is the one that changes what you generate next.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Fingerprint, Loader2, AlertTriangle, Play, Database, FlaskConical,
  Download, Trash2, Check, Plus, X, Info, Wand2, Copy,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getTaskCreds, getSerpCreds, getFirecrawlKey, getConfiguredProviders, AI_PROVIDER_NAMES, loadPolicies, savePolicies, getActivePolicyName } from "@/lib/seo/keys";
import { COUNTRIES, LANGUAGES } from "@/lib/seo/regions";
import { loadHistory } from "@/lib/seo/history";
import { trainModel, scoreText, suggestBannedWords, modelStats, type AiDetectReport } from "@/lib/seo/aidetect";
import { loadModels, upsertModel, removeModel, getActiveName, setActiveName, effectiveBannedWords, type StoredModel } from "@/lib/seo/aidetectStore";
import { factDrift, driftSeverity, type FactDrift } from "@/lib/seo/factDrift";
import FactDriftPanel from "@/components/FactDriftPanel";

const ACCENT = "#ff6482";
const card = "panel";
const inputStyle: React.CSSProperties = { width: "100%", padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none", boxSizing: "border-box" };
const btn = (bg: string, disabled?: boolean): React.CSSProperties => ({ display: "inline-flex", alignItems: "center", gap: "8px", padding: "10px 16px", borderRadius: "10px", border: "none", background: bg, color: "#fff", fontSize: "13px", fontWeight: 700, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.55 : 1, width: "fit-content" });
const ghostBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" };
const label: React.CSSProperties = { fontSize: "12px", color: "var(--color-text-secondary)", display: "block" };

// Same bands the research used, so the verdict reads the way operators already expect.
function scoreColor(s: number) { return s < 15 ? "#34c759" : s < 40 ? "#ff9f0a" : "#ff375f"; }

type Tab = "analyze" | "corpus" | "bench";
type BenchRow = { id: string; provider: string; model: string; temp: string };
type BenchResult = BenchRow & { score?: number; words?: number; ms?: number; error?: string; tempIgnored?: boolean; text?: string };

export default function HumanizePage() {
  const { t } = useLanguage();
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<Tab>("analyze");
  const [models, setModels] = useState<StoredModel[]>([]);
  const [activeName, setActive] = useState("");

  useEffect(() => {
    setMounted(true);
    setModels(loadModels());
    setActive(getActiveName());
  }, []);

  const active = useMemo(
    () => models.find(m => m.name === activeName) || models[0] || null,
    [models, activeName],
  );

  const refresh = () => { setModels(loadModels()); setActive(getActiveName()); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <div>
        <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px", display: "flex", alignItems: "center", gap: "9px" }}>
          <Fingerprint size={20} color={ACCENT} /> {t("hmTitle" as any)}
        </h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("hmSub" as any)}</p>
      </div>

      {/* The tool is only honest if this caveat is unavoidable, so it sits above the tabs. */}
      <div className={card} style={{ borderColor: "rgba(255,159,10,0.3)", background: "rgba(255,159,10,0.05)", display: "flex", gap: "10px", alignItems: "flex-start", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        <Info size={16} color="var(--color-accent-orange)" style={{ flexShrink: 0, marginTop: "1px" }} />
        <span>{t("hmProxyWarning" as any)}</span>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: "2px", background: "rgba(255,255,255,0.06)", borderRadius: "8px", padding: "3px", width: "fit-content", flexWrap: "wrap" }}>
        {([["analyze", t("hmTabAnalyze" as any), Fingerprint], ["corpus", t("hmTabCorpus" as any), Database], ["bench", t("hmTabBench" as any), FlaskConical]] as const).map(([k, lbl, Icon]) => (
          <button key={k} onClick={() => setTab(k as Tab)} style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: tab === k ? "var(--color-card)" : "transparent", color: tab === k ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}>
            <Icon size={13} /> {lbl}
          </button>
        ))}
      </div>

      {mounted && tab === "analyze" && <AnalyzeTab active={active} />}
      {mounted && tab === "corpus" && <CorpusTab models={models} activeName={active?.name || ""} onChange={refresh} />}
      {mounted && tab === "bench" && <BenchTab active={active} />}
    </div>
  );
}

// ─── Tab 1: analyze a text ──────────────────────────────────────────────────────
function AnalyzeTab({ active }: { active: StoredModel | null }) {
  const { t } = useLanguage();
  const [text, setText] = useState("");
  const [report, setReport] = useState<AiDetectReport | null>(null);
  const [err, setErr] = useState("");
  const [exported, setExported] = useState(false);
  const [hzBusy, setHzBusy] = useState(false);
  const [hz, setHz] = useState<{ before: number; after: number; text: string; drift: FactDrift } | null>(null);

  const history = useMemo(() => loadHistory().filter(h => h.type === "text" && typeof h.data === "string"), []);

  function run() {
    setErr(""); setReport(null); setExported(false); setHz(null);
    if (!active) { setErr(t("hmErrNeedModel" as any)); return; }
    if (!text.trim()) { setErr(t("hmErrNeedText" as any)); return; }
    setReport(scoreText(text, active.model));
  }

  // Rewrite the text with the fingerprint's marker vocabulary banned, then re-score it.
  //
  // Reuses the rewrite endpoint rather than adding a parallel one: it already takes bannedWords and
  // a temperature. Three variants are generated and the LOWEST-scoring one is kept — rewriting is a
  // sampling process, so picking the best of a few beats trusting a single roll. The before/after
  // pair is always shown, including when the score goes UP, because that happens and hiding it
  // would make the tool a liar.
  async function humanize(source?: string) {
    if (!active) { setErr(t("hmErrNeedModel" as any)); return; }
    const src = (source ?? text).trim();
    if (!src) { setErr(t("hmErrNeedText" as any)); return; }
    setErr(""); setHzBusy(true);
    try {
      const creds = getTaskCreds("text");
      if (!creds.apiKey) { setErr(t("seoErrNoAiKey" as any)); setHzBusy(false); return; }
      const res = await fetch("/api/seo/rewrite", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: src, variants: 3, maskAI: true,
          // Honours the operator's review edits — the same list the generation pages use.
          bannedWords: effectiveBannedWords(active),
          temperature: 0.7,
          aiProvider: creds.provider, aiApiKey: creds.apiKey,
          model: creds.model || undefined, aiBaseUrl: creds.baseUrl || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) { setErr(String(d.error || t("rwErrGen" as any))); setHzBusy(false); return; }
      // Rank by score, but prefer a variant that did not invent facts: a text that reads as human
      // and quotes a number nobody wrote is a worse outcome than a slightly higher score.
      type Scored = { text: string; score: number; drift: FactDrift; invented: boolean };
      const scored: Scored[] = (d.variants || [])
        .map((v: { content: string }): Scored => {
          const drift = factDrift(src, v.content);
          return { text: v.content, score: scoreText(v.content, active.model).avgScore, drift, invented: driftSeverity(drift) === "danger" };
        })
        .sort((a: Scored, b: Scored) => (a.invented === b.invented ? a.score - b.score : a.invented ? 1 : -1));
      if (!scored.length) { setErr(t("rwErrGen" as any)); setHzBusy(false); return; }
      setHz({ before: scoreText(src, active.model).avgScore, after: scored[0].score, text: scored[0].text, drift: scored[0].drift });
    } catch (e: unknown) { setErr(String((e as Error)?.message ?? e)); }
    setHzBusy(false);
  }

  // Push the marker vocabulary into the editorial policy's wordsToAvoid. That field is already
  // rendered into every outline/text prompt, so this is the whole integration — the list starts
  // constraining generation on the next run with no further wiring.
  function exportBanned() {
    if (!active) return;
    const words = suggestBannedWords(active.model, 60);
    const policies = loadPolicies();
    const name = getActivePolicyName();
    const i = Math.max(0, policies.findIndex(p => p.name === name));
    const existing = (policies[i].restrictions.wordsToAvoid || "").split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    const merged = Array.from(new Set([...existing, ...words]));
    policies[i] = { ...policies[i], restrictions: { ...policies[i].restrictions, wordsToAvoid: merged.join(", ") } };
    savePolicies(policies);
    setExported(true);
  }

  return (
    <>
      {!active && (
        <div className={card} style={{ borderColor: "rgba(255,159,10,0.35)", background: "rgba(255,159,10,0.06)", display: "flex", gap: "10px", alignItems: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          <AlertTriangle size={18} color="var(--color-accent-orange)" /> {t("hmNoModelHint" as any)}
        </div>
      )}

      <div className={card} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {history.length > 0 && (
          <label style={label}>{t("hmFromHistory" as any)}
            <select defaultValue="" onChange={e => { const h = history.find(x => x.id === e.target.value); if (h) setText(String(h.data)); }} style={{ ...inputStyle, marginTop: "4px" }}>
              <option value="">—</option>
              {history.slice(0, 40).map(h => <option key={h.id} value={h.id}>{h.keyword}</option>)}
            </select>
          </label>
        )}
        <textarea value={text} onChange={e => setText(e.target.value)} placeholder={t("hmTextPlaceholder" as any)} rows={10} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit", lineHeight: 1.6 }} />
        {err && <div style={{ fontSize: "12px", color: "#f87171", display: "flex", alignItems: "center", gap: "6px" }}><AlertTriangle size={14} /> {err}</div>}
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <button onClick={run} disabled={!active} style={btn(ACCENT, !active)}><Play size={14} /> {t("hmAnalyze" as any)}</button>
          <button onClick={() => humanize()} disabled={!active || hzBusy} style={btn("#8B5CF6", !active || hzBusy)}>
            {hzBusy ? <><Loader2 size={14} className="spin" /> {t("hmHumanizing" as any)}</> : <><Wand2 size={14} /> {t("hmHumanize" as any)}</>}
          </button>
        </div>
      </div>

      {hz && (
        <div className={card} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmHumanizeResult" as any)}</div>
            <span style={{ fontSize: "13px", fontWeight: 700, color: scoreColor(hz.before) }}>{hz.before}%</span>
            <span style={{ color: "var(--color-text-secondary)" }}>→</span>
            <span style={{ fontSize: "18px", fontWeight: 800, color: scoreColor(hz.after) }}>{hz.after}%</span>
            <span style={{ fontSize: "12px", fontWeight: 700, color: hz.after < hz.before ? "#34c759" : "#ff9f0a" }}>
              {hz.after < hz.before ? "−" : "+"}{Math.abs(hz.before - hz.after)}
            </span>
            <span style={{ flex: 1 }} />
            <button onClick={() => { setText(hz.text); setReport(scoreText(hz.text, active!.model)); setHz(null); }} style={ghostBtn}>
              <Check size={13} /> {t("hmHumanizeAccept" as any)}
            </button>
            <button onClick={() => humanize(hz.text)} disabled={hzBusy} style={ghostBtn}>
              <Wand2 size={13} /> {t("hmHumanizeAgain" as any)}
            </button>
            <button onClick={() => navigator.clipboard.writeText(hz.text).catch(() => {})} style={ghostBtn}>
              <Copy size={13} /> {t("rwCopy" as any)}
            </button>
          </div>
          {/* Deterministic value check — this is the guardrail that replaces "please verify facts". */}
          <FactDriftPanel drift={hz.drift} />

          {/* Guidance that has to be EARNED by the result rather than shown as a standing caveat.
              A permanent "this lever is weak" note gets tuned out; a message that appears precisely
              when the rewrite failed to deliver is read, because it explains what just happened. */}
          {hz.after - hz.before > -10 && (
            <div style={{ border: "1px solid rgba(41,151,255,0.35)", background: "rgba(41,151,255,0.07)", borderRadius: "10px", padding: "12px 14px", display: "flex", gap: "10px", alignItems: "flex-start" }}>
              <Info size={16} color="var(--color-accent-blue)" style={{ flexShrink: 0, marginTop: "1px" }} />
              <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
                {t("hmWeakDelta" as any)}{" "}
                <Link href="/seo-tools/text" style={{ color: "var(--color-accent-blue)", fontWeight: 600 }}>{t("hmWeakDeltaCta" as any)}</Link>
              </div>
            </div>
          )}

          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: "13px", lineHeight: 1.7, color: "var(--color-text-primary)", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "14px 16px", maxHeight: "420px", overflow: "auto" }}>{hz.text}</pre>
        </div>
      )}

      {report && (
        <>
          <div className={card} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
              <div style={{ fontSize: "34px", fontWeight: 800, color: scoreColor(report.avgScore), lineHeight: 1 }}>{report.avgScore}%</div>
              <div>
                <div style={{ fontSize: "14px", fontWeight: 700, color: scoreColor(report.avgScore) }}>
                  {t((report.verdict === "human" ? "hmVerdictHuman" : report.verdict === "mixed" ? "hmVerdictMixed" : "hmVerdictAi") as any)}
                </div>
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{report.words} {t("hmWords" as any)} · {report.windows.length} {t("hmWindows" as any)}</div>
              </div>
            </div>

            {/* Per-window heatmap: the average hides a text that is half clean and half obvious. */}
            <div style={{ display: "flex", gap: "3px", flexWrap: "wrap" }}>
              {report.windows.map(w => (
                <div key={w.index} title={`#${w.index + 1} · ${w.score}% · ${w.words} — ${w.preview}…`}
                  style={{ flex: "1 1 30px", minWidth: "30px", height: "38px", borderRadius: "5px", background: scoreColor(w.score), opacity: 0.25 + (w.score / 100) * 0.75, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "10px", fontWeight: 700, color: "#fff" }}>
                  {w.score}
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
            <div className={card} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmMarkers" as any)}</div>
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("hmMarkersHint" as any)}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginTop: "4px" }}>
                {report.markers.map(m => (
                  <span key={m.token} title={`weight ${m.weight.toFixed(2)} × ${m.count}`} style={{ fontSize: "11px", padding: "3px 9px", borderRadius: "20px", background: "rgba(255,55,95,0.12)", color: "#ff375f", fontWeight: 600 }}>
                    {m.token} <span style={{ opacity: 0.65 }}>×{m.count}</span>
                  </span>
                ))}
                {!report.markers.length && <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>—</span>}
              </div>
              <button onClick={exportBanned} style={{ ...ghostBtn, marginTop: "8px" }}>
                {exported ? <><Check size={13} color="#34c759" /> {t("hmExportedBanned" as any)}</> : <><Download size={13} /> {t("hmExportBanned" as any)}</>}
              </button>
            </div>

            <div className={card} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmMissing" as any)}</div>
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("hmMissingHint" as any)}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginTop: "4px" }}>
                {report.missing.map(m => (
                  <span key={m.token} style={{ fontSize: "11px", padding: "3px 9px", borderRadius: "20px", background: "rgba(52,199,89,0.12)", color: "#34c759", fontWeight: 600 }}>{m.token}</span>
                ))}
                {!report.missing.length && <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>—</span>}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ─── Tab 2: build and train the corpus model ────────────────────────────────────
function CorpusTab({ models, activeName, onChange }: { models: StoredModel[]; activeName: string; onChange: () => void }) {
  const { t } = useLanguage();
  const [keyword, setKeyword] = useState("");
  const [urls, setUrls] = useState("");
  const [gl, setGl] = useState("us");
  const [hl, setHl] = useState("en");
  const [count, setCount] = useState(12);
  const [human, setHuman] = useState<{ url: string; title: string; words: number; text: string }[]>([]);
  const [busy, setBusy] = useState<"harvest" | "train" | null>(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");

  const aiDocs = useMemo(
    () => loadHistory().filter(h => h.type === "text" && typeof h.data === "string" && h.data.length > 500),
    [],
  );

  async function harvest() {
    setErr(""); setBusy("harvest");
    try {
      const serp = getSerpCreds();
      const list = urls.split(/[\s,]+/).map(s => s.trim()).filter(s => /^https?:\/\//.test(s));
      const res = await fetch("/api/seo/aidetect/harvest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: keyword.trim() || undefined, urls: list.length ? list : undefined,
          count, gl, hl,
          serpProvider: serp.provider, serpKey: serp.apiKey,
          firecrawlKey: getFirecrawlKey() || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) { setErr(String(d.error || t("hmErrHarvest" as any))); }
      else setHuman(prev => {
        // Accumulate across harvests — one keyword rarely yields enough documents, and the model
        // wants breadth across the niche rather than depth on a single query.
        const seen = new Set(prev.map(p => p.url));
        return [...prev, ...(d.docs || []).filter((x: any) => !seen.has(x.url))];
      });
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setBusy(null);
  }

  function train() {
    setErr(""); setBusy("train");
    const r = trainModel(human.map(h => h.text), aiDocs.map(h => String(h.data)), hl);
    setBusy(null);
    if (!r.ok) {
      setErr(t(({
        need_more_human: "hmNeedHuman", need_more_ai: "hmNeedAi",
        corpus_too_small: "hmCorpusTooSmall", no_separation: "hmNoSeparation",
      } as any)[r.error] || "hmErrTrain" as any));
      return;
    }
    const nm = name.trim() || keyword.trim() || `model-${new Date().toISOString().slice(0, 10)}`;
    upsertModel({ name: nm, model: r.model, note: keyword.trim() || undefined });
    setActiveName(nm);
    onChange();
  }

  return (
    <>
      <div className={card} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmCorpusHuman" as any)}</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "3px", lineHeight: 1.5 }}>{t("hmCorpusHumanHint" as any)}</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
          <label style={label}>{t("hmKeyword" as any)}
            <input value={keyword} onChange={e => setKeyword(e.target.value)} style={{ ...inputStyle, marginTop: "4px" }} />
          </label>
          <label style={label}>{t("seoCountryGl" as any)}
            <select value={gl} onChange={e => setGl(e.target.value)} style={{ ...inputStyle, marginTop: "4px" }}>
              {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </label>
          <label style={label}>{t("seoLanguageHl" as any)}
            <select value={hl} onChange={e => setHl(e.target.value)} style={{ ...inputStyle, marginTop: "4px" }}>
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </label>
          <label style={label}>{t("hmDocs" as any)}
            <select value={count} onChange={e => setCount(parseInt(e.target.value))} style={{ ...inputStyle, marginTop: "4px" }}>
              {[6, 10, 12, 20, 30].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        <label style={label}>{t("hmUrls" as any)}
          <textarea value={urls} onChange={e => setUrls(e.target.value)} placeholder={t("hmUrlsHint" as any)} rows={3} style={{ ...inputStyle, marginTop: "4px", resize: "vertical", fontFamily: "inherit" }} />
        </label>
        {err && <div style={{ fontSize: "12px", color: "#f87171", display: "flex", alignItems: "center", gap: "6px" }}><AlertTriangle size={14} /> {err}</div>}
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={harvest} disabled={busy !== null} style={btn(ACCENT, busy !== null)}>
            {busy === "harvest" ? <><Loader2 size={14} className="spin" /> {t("hmHarvesting" as any)}</> : <><Database size={14} /> {t("hmHarvest" as any)}</>}
          </button>
          {human.length > 0 && (
            <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
              {t("hmHarvested" as any)}: <b style={{ color: "var(--color-text-primary)" }}>{human.length}</b>
              {" · "}{t("hmCorpusAi" as any)}: <b style={{ color: "var(--color-text-primary)" }}>{aiDocs.length}</b>
            </span>
          )}
          {human.length > 0 && <button onClick={() => setHuman([])} style={ghostBtn}><X size={13} /> {t("hmClear" as any)}</button>}
        </div>
        {human.length > 0 && (
          <div style={{ maxHeight: "160px", overflow: "auto", border: "1px solid var(--color-border)", borderRadius: "8px", padding: "8px 10px", background: "var(--color-bg)" }}>
            {human.map(h => (
              <div key={h.url} style={{ fontSize: "11px", color: "var(--color-text-secondary)", padding: "2px 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                <b style={{ color: "var(--color-text-primary)" }}>{h.words}</b> — {h.title || h.url}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={card} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmTrain" as any)}</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "3px", lineHeight: 1.5 }}>{t("hmCorpusAiHint" as any)}</div>
        </div>
        <label style={label}>{t("hmModelName" as any)}
          <input value={name} onChange={e => setName(e.target.value)} placeholder={keyword || "casino-ru"} style={{ ...inputStyle, marginTop: "4px" }} />
        </label>
        <button onClick={train} disabled={busy !== null || human.length < 3 || aiDocs.length < 3} style={btn(ACCENT, busy !== null || human.length < 3 || aiDocs.length < 3)}>
          {busy === "train" ? <><Loader2 size={14} className="spin" /> {t("hmTraining" as any)}</> : <><FlaskConical size={14} /> {t("hmTrain" as any)}</>}
        </button>
      </div>

      {models.length > 0 && (
        <div className={card} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmModelLabel" as any)}</div>
          {models.map(m => {
            const s = modelStats(m.model);
            const qc = s.quality === "good" ? "#34c759" : s.quality === "fair" ? "#ff9f0a" : "#ff375f";
            return (
              <div key={m.name} style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "9px 11px", borderRadius: "9px", border: `1px solid ${m.name === activeName ? ACCENT : "var(--color-border)"}`, background: "var(--color-bg)" }}>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{m.name}</div>
                <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 9px", borderRadius: "20px", color: qc, background: `${qc}1f` }}>
                  {t(("hmQuality" + s.quality.charAt(0).toUpperCase() + s.quality.slice(1)) as any)} · {t("hmSeparation" as any)} {(s.separation * 100).toFixed(0)}%
                </span>
                <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>
                  {s.humanDocs}/{s.aiDocs} {t("hmDocs" as any)} · {s.vocab} {t("hmVocab" as any)}
                </span>
                <span style={{ flex: 1 }} />
                {m.name !== activeName && <button onClick={() => { setActiveName(m.name); onChange(); }} style={ghostBtn}>{t("hmSetActive" as any)}</button>}
                {m.name === activeName && <span style={{ fontSize: "11px", fontWeight: 700, color: ACCENT }}>{t("hmActive" as any)}</span>}
                <button onClick={() => { removeModel(m.name); onChange(); }} style={{ ...ghostBtn, color: "#f87171" }}><Trash2 size={13} /></button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ─── Tab 3: model × temperature bench ───────────────────────────────────────────
function BenchTab({ active }: { active: StoredModel | null }) {
  const { t } = useLanguage();
  const [prompt, setPrompt] = useState("");
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [results, setResults] = useState<BenchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const configured = useMemo(() => (typeof window === "undefined" ? [] : getConfiguredProviders()), []);

  useEffect(() => {
    if (rows.length) return;
    // Seed one row per configured provider at the mid temperature, so the bench is runnable
    // immediately instead of starting from an empty table.
    const seed = configured.slice(0, 4).map((p, i) => ({ id: `r${i}`, provider: p.id, model: "", temp: "0.7" }));
    if (seed.length) setRows(seed);
  }, [configured, rows.length]);

  const addRow = () => setRows(r => [...r, { id: `r${Date.now()}`, provider: configured[0]?.id || "anthropic", model: "", temp: "0.7" }]);
  const setRow = (id: string, patch: Partial<BenchRow>) => setRows(r => r.map(x => (x.id === id ? { ...x, ...patch } : x)));
  const delRow = (id: string) => setRows(r => r.filter(x => x.id !== id));

  async function run() {
    setErr(""); setResults([]);
    if (!active) { setErr(t("hmErrNeedModel" as any)); return; }
    if (!prompt.trim()) { setErr(t("hmErrNeedPrompt" as any)); return; }
    setBusy(true);

    // Sequential on purpose: firing every provider at once makes the slowest row's latency
    // meaningless and invites rate limits that would show up as a fake quality difference.
    const out: BenchResult[] = [];
    for (const row of rows) {
      const creds = getTaskCreds("text");
      const key = localStorage.getItem(`aiKey_${row.provider}`) || creds.apiKey;
      if (!key) { out.push({ ...row, error: "no_ai_key" }); setResults([...out]); continue; }
      try {
        const res = await fetch("/api/seo/aidetect/probe", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: prompt.trim(),
            aiProvider: row.provider, aiApiKey: key,
            model: row.model.trim() || undefined,
            aiBaseUrl: row.provider === "custom" ? localStorage.getItem("aiBaseUrl_custom") || undefined : undefined,
            temperature: row.temp === "" ? undefined : Number(row.temp),
          }),
        });
        const d = await res.json();
        if (!res.ok) { out.push({ ...row, error: String(d.error || "failed") }); }
        else {
          const rep = scoreText(d.text, active.model);
          out.push({ ...row, score: rep.avgScore, words: rep.words, ms: d.ms, tempIgnored: !!d.temperatureIgnored, text: d.text });
        }
      } catch (e: any) { out.push({ ...row, error: String(e?.message ?? e) }); }
      setResults([...out]);
    }
    setBusy(false);
  }

  const sorted = useMemo(() => [...results].sort((a, b) => (a.score ?? 999) - (b.score ?? 999)), [results]);

  return (
    <>
      {!active && (
        <div className={card} style={{ borderColor: "rgba(255,159,10,0.35)", background: "rgba(255,159,10,0.06)", display: "flex", gap: "10px", alignItems: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          <AlertTriangle size={18} color="var(--color-accent-orange)" /> {t("hmNoModelHint" as any)}
        </div>
      )}

      <div className={card} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmBenchPrompt" as any)}</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "3px", lineHeight: 1.5 }}>{t("hmBenchHint" as any)}</div>
        </div>
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={t("hmBenchPromptPlaceholder" as any)} rows={4} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit", lineHeight: 1.6 }} />

        <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
          {rows.map(row => (
            <div key={row.id} style={{ display: "grid", gridTemplateColumns: "minmax(110px,1fr) minmax(140px,2fr) 90px 34px", gap: "7px", alignItems: "center" }}>
              <select value={row.provider} onChange={e => setRow(row.id, { provider: e.target.value })} style={inputStyle}>
                {(configured.length ? configured.map(c => c.id) : ["anthropic"]).map(id => (
                  <option key={id} value={id}>{AI_PROVIDER_NAMES[id] || id}</option>
                ))}
              </select>
              <input value={row.model} onChange={e => setRow(row.id, { model: e.target.value })} placeholder={t("hmBenchModelPlaceholder" as any)} style={inputStyle} />
              <input value={row.temp} onChange={e => setRow(row.id, { temp: e.target.value })} placeholder="0.7" style={inputStyle} />
              <button onClick={() => delRow(row.id)} style={{ ...ghostBtn, justifyContent: "center", padding: "9px 0" }}><X size={13} /></button>
            </div>
          ))}
          <button onClick={addRow} style={{ ...ghostBtn, width: "fit-content" }}><Plus size={13} /> {t("hmBenchAddRow" as any)}</button>
        </div>

        {err && <div style={{ fontSize: "12px", color: "#f87171", display: "flex", alignItems: "center", gap: "6px" }}><AlertTriangle size={14} /> {err}</div>}
        <button onClick={run} disabled={busy || !active || !rows.length} style={btn(ACCENT, busy || !active || !rows.length)}>
          {busy ? <><Loader2 size={14} className="spin" /> {t("hmBenchRunning" as any)}</> : <><Play size={14} /> {t("hmBenchRun" as any)}</>}
        </button>
      </div>

      {sorted.length > 0 && (
        <div className={card} style={{ display: "flex", flexDirection: "column", gap: "8px", overflowX: "auto" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmBenchResult" as any)}</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead>
              <tr style={{ color: "var(--color-text-secondary)", textAlign: "left" }}>
                <th style={{ padding: "6px 8px", fontWeight: 600 }}>{t("hmBenchModelCol" as any)}</th>
                <th style={{ padding: "6px 8px", fontWeight: 600 }}>{t("hmBenchTempCol" as any)}</th>
                <th style={{ padding: "6px 8px", fontWeight: 600 }}>{t("hmBenchScoreCol" as any)}</th>
                <th style={{ padding: "6px 8px", fontWeight: 600 }}>{t("hmWords" as any)}</th>
                <th style={{ padding: "6px 8px", fontWeight: 600 }}>ms</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(r => (
                <tr key={r.id} style={{ borderTop: "1px solid var(--color-border)" }}>
                  <td style={{ padding: "7px 8px", color: "var(--color-text-primary)" }}>
                    {AI_PROVIDER_NAMES[r.provider] || r.provider}{r.model ? ` · ${r.model}` : ""}
                  </td>
                  <td style={{ padding: "7px 8px", color: "var(--color-text-secondary)" }}>
                    {r.tempIgnored ? <span title={t("hmTempIgnoredHint" as any)} style={{ color: "#ff9f0a" }}>{t("hmTempIgnored" as any)}</span> : r.temp || "—"}
                  </td>
                  <td style={{ padding: "7px 8px", fontWeight: 700, color: r.error ? "#f87171" : scoreColor(r.score ?? 0) }}>
                    {r.error ? r.error : `${r.score}%`}
                  </td>
                  <td style={{ padding: "7px 8px", color: "var(--color-text-secondary)" }}>{r.words ?? "—"}</td>
                  <td style={{ padding: "7px 8px", color: "var(--color-text-secondary)" }}>{r.ms ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5, marginTop: "4px" }}>{t("hmBenchNote" as any)}</div>
        </div>
      )}

      {!configured.length && (
        <div className={card} style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
          {t("seoNeedKeysPrefix" as any)} <Link href="/settings?tab=api-keys" style={{ color: "var(--color-accent-blue)" }}>{t("seoSettingsShort" as any)}</Link>
        </div>
      )}
    </>
  );
}
