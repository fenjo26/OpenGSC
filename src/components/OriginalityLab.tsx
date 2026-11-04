"use client";

// Originality tab of the AI-Fingerprint Lab.
//
// The fingerprint tabs answer "does this read like a machine". This one answers the question that
// decides whether a template page gets indexed at all: "does it say anything its siblings do not".
// Same philosophy as the rest of the lab — measured locally and deterministically against a corpus
// the operator picks, then a rewrite that is judged by the same measurement instead of trusted.
//
// The rewrite is the humanizer pointed at a different target. It uses the same /api/seo/rewrite
// endpoint, but ranks variants by originality against the siblings (invented facts always last),
// and its instruction comes from originalityBrief(), which allows new substance only from the
// facts the operator typed. A model asked to "add unique facts" with nothing to draw on invents
// them, and an invented price on a geo page is worse than a duplicate.

import { useMemo, useState } from "react";
import { Loader2, AlertTriangle, Play, Download, Wand2, Check, Copy, Info, Layers, Table2, Heading, Link2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getTaskCreds, getFirecrawlKey } from "@/lib/seo/keys";
import { effectiveBannedWords, type StoredModel } from "@/lib/seo/aidetectStore";
import { scoreText } from "@/lib/seo/aidetect";
import { originalityReport, originalityBrief, type OriginalityReport, type OriginalityBand } from "@/lib/seo/originality";
import { factDrift, driftSeverity, type FactDrift } from "@/lib/seo/factDrift";
import FactDriftPanel from "@/components/FactDriftPanel";

const ACCENT = "#ff6482";
const inputStyle: React.CSSProperties = { width: "100%", padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none", boxSizing: "border-box" };
const btn = (bg: string, disabled?: boolean): React.CSSProperties => ({ display: "inline-flex", alignItems: "center", gap: "8px", padding: "10px 16px", borderRadius: "10px", border: "none", background: bg, color: "#fff", fontSize: "13px", fontWeight: 700, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.55 : 1, width: "fit-content" });
const ghostBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" };
const label: React.CSSProperties = { fontSize: "12px", color: "var(--color-text-secondary)", display: "block" };

const BAND_COLOR: Record<OriginalityBand, string> = { template: "#ff375f", borderline: "#ff9f0a", original: "#34c759" };
const BAND_KEY = { template: "hmOrBandTemplate", borderline: "hmOrBandBorderline", original: "hmOrBandOriginal" } as const;

/** Pasted siblings are separated by a line holding only --- (the Markdown rule a paste rarely contains on its own). */
function splitPasted(s: string): string[] {
  return s.split(/^\s*-{3,}\s*$/m).map(x => x.trim()).filter(Boolean);
}

function Meter({ value, color }: { value: number; color: string }) {
  return (
    <div style={{ height: "6px", borderRadius: "4px", background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
      <div style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`, height: "100%", background: color }} />
    </div>
  );
}

export default function OriginalityLab({ active }: { active: StoredModel | null }) {
  const { t } = useLanguage();
  const [text, setText] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [pasted, setPasted] = useState("");
  const [sibUrls, setSibUrls] = useState("");
  const [fetched, setFetched] = useState<{ url: string; title: string; text: string }[]>([]);
  const [facts, setFacts] = useState("");
  const [busy, setBusy] = useState<"page" | "sibs" | "rewrite" | null>(null);
  const [err, setErr] = useState("");
  const [report, setReport] = useState<OriginalityReport | null>(null);
  const [rw, setRw] = useState<{ before: OriginalityReport; after: OriginalityReport; text: string; drift: FactDrift; aiAfter?: number } | null>(null);

  const siblings = useMemo(() => [...splitPasted(pasted), ...fetched.map(f => f.text)], [pasted, fetched]);
  const sibLabels = useMemo(() => [...splitPasted(pasted).map((_, i) => `#${i + 1}`), ...fetched.map(f => f.title || f.url)], [pasted, fetched]);

  // One endpoint for both fetches: the harvest route already does scraping with the Firecrawl
  // fallback, and `raw` makes it return Markdown so tables and headings survive.
  async function fetchPages(urls: string[]) {
    const res = await fetch("/api/seo/aidetect/harvest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, count: urls.length, raw: true, firecrawlKey: getFirecrawlKey() || undefined }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(String(d.error || t("hmErrHarvest")));
    return (d.docs || []) as { url: string; title: string; text: string; raw?: string }[];
  }

  async function loadPage() {
    const u = pageUrl.trim();
    if (!/^https?:\/\//.test(u)) return;
    setErr(""); setBusy("page");
    try {
      const [doc] = await fetchPages([u]);
      if (!doc) setErr(t("hmErrHarvest")); else setText(doc.raw || doc.text);
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    setBusy(null);
  }

  async function fetchSiblings() {
    const list = sibUrls.split(/[\s,]+/).map(s => s.trim()).filter(s => /^https?:\/\//.test(s)).slice(0, 30);
    if (!list.length) return;
    setErr(""); setBusy("sibs");
    try {
      const docs = await fetchPages(list);
      setFetched(prev => {
        const seen = new Set(prev.map(p => p.url));
        return [...prev, ...docs.filter(d => !seen.has(d.url)).map(d => ({ url: d.url, title: d.title, text: d.raw || d.text }))];
      });
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    setBusy(null);
  }

  function measure() {
    setErr(""); setRw(null);
    if (!text.trim()) { setErr(t("hmErrNeedText")); return; }
    if (!siblings.length) { setErr(t("hmOrErrNeedSiblings")); return; }
    setReport(originalityReport(text, siblings));
  }

  async function rewrite(source?: string) {
    const src = (source ?? text).trim();
    if (!src) { setErr(t("hmErrNeedText")); return; }
    if (!siblings.length) { setErr(t("hmOrErrNeedSiblings")); return; }
    const creds = getTaskCreds("text");
    if (!creds.apiKey) { setErr(t("seoErrNoAiKey")); return; }
    setErr(""); setBusy("rewrite");
    try {
      const before = originalityReport(src, siblings);
      const res = await fetch("/api/seo/rewrite", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: src, variants: 3, maskAI: true, temperature: 0.7,
          custom: originalityBrief(before, facts),
          // When a fingerprint model is active, the rewrite also avoids its marker vocabulary —
          // the two axes are independent, so fixing one should not cost the other.
          bannedWords: active ? effectiveBannedWords(active) : undefined,
          aiProvider: creds.provider, aiApiKey: creds.apiKey,
          model: creds.model || undefined, aiBaseUrl: creds.baseUrl || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) { setErr(String(d.error || t("rwErrGen"))); setBusy(null); return; }
      // Facts the operator supplied are allowed to appear, so drift is measured against
      // source + facts: anything else that shows up is invented and ranks last.
      const allowed = `${src}\n\n${facts}`;
      type Scored = { text: string; rep: OriginalityReport; drift: FactDrift; invented: boolean };
      const scored: Scored[] = (d.variants || [])
        .map((v: { content: string }): Scored => {
          const drift = factDrift(allowed, v.content);
          return { text: v.content, rep: originalityReport(v.content, siblings), drift, invented: driftSeverity(drift) === "danger" };
        })
        .sort((a: Scored, b: Scored) => (a.invented === b.invented ? b.rep.score - a.rep.score : a.invented ? 1 : -1));
      if (!scored.length) { setErr(t("rwErrGen")); setBusy(null); return; }
      const best = scored[0];
      setRw({ before, after: best.rep, text: best.text, drift: best.drift, aiAfter: active ? scoreText(best.text, active.model).avgScore : undefined });
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    setBusy(null);
  }

  return (
    <>
      <div className="panel" style={{ display: "flex", gap: "10px", alignItems: "flex-start", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        <Info size={16} color="var(--color-accent-blue)" style={{ flexShrink: 0, marginTop: "1px" }} />
        <span>{t("hmOrIntro")}</span>
      </div>

      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmOrPage")}</div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <input value={pageUrl} onChange={e => setPageUrl(e.target.value)} placeholder={t("hmOrPageUrl")} style={{ ...inputStyle, flex: "1 1 240px", width: "auto" }} />
          <button onClick={loadPage} disabled={busy !== null || !pageUrl.trim()} style={ghostBtn}>
            {busy === "page" ? <Loader2 size={13} className="spin" /> : <Download size={13} />} {t("hmOrLoad")}
          </button>
        </div>
        <textarea value={text} onChange={e => setText(e.target.value)} placeholder={t("hmTextPlaceholder")} rows={9} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit", lineHeight: 1.6 }} />
      </div>

      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmOrSiblings")}</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "3px", lineHeight: 1.5 }}>{t("hmOrSiblingsHint")}</div>
        </div>
        <label style={label}>{t("hmOrSiblingUrls")}
          <textarea value={sibUrls} onChange={e => setSibUrls(e.target.value)} placeholder="https://example.com/roofing-leeds/" rows={3} style={{ ...inputStyle, marginTop: "4px", resize: "vertical", fontFamily: "inherit" }} />
        </label>
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={fetchSiblings} disabled={busy !== null || !sibUrls.trim()} style={ghostBtn}>
            {busy === "sibs" ? <><Loader2 size={13} className="spin" /> {t("hmOrFetching")}</> : <><Download size={13} /> {t("hmOrFetch")}</>}
          </button>
          <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("hmOrSiblingsCount").replace("{n}", String(siblings.length))}</span>
          {fetched.length > 0 && <button onClick={() => setFetched([])} style={ghostBtn}>{t("hmClear")}</button>}
        </div>
        <label style={label}>{t("hmOrSiblingsPaste")}
          <textarea value={pasted} onChange={e => setPasted(e.target.value)} placeholder={"…\n---\n…"} rows={5} style={{ ...inputStyle, marginTop: "4px", resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} />
        </label>
        {err && <div style={{ fontSize: "12px", color: "#f87171", display: "flex", alignItems: "center", gap: "6px" }}><AlertTriangle size={14} /> {err}</div>}
        <button onClick={measure} disabled={busy !== null} style={btn(ACCENT, busy !== null)}><Play size={14} /> {t("hmOrMeasure")}</button>
      </div>

      {report && <ReportCard r={report} sibLabels={sibLabels} />}

      {report && (
        <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmOrFacts")}</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "3px", lineHeight: 1.5 }}>{t("hmOrFactsHint")}</div>
          </div>
          <textarea value={facts} onChange={e => setFacts(e.target.value)} rows={4} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} />
          {!facts.trim() && (
            <div style={{ fontSize: "12px", color: "var(--color-accent-orange)", display: "flex", gap: "6px", alignItems: "flex-start", lineHeight: 1.5 }}>
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: "2px" }} /> {t("hmOrNoFactsWarn")}
            </div>
          )}
          <button onClick={() => rewrite()} disabled={busy !== null} style={btn("#8B5CF6", busy !== null)}>
            {busy === "rewrite" ? <><Loader2 size={14} className="spin" /> {t("hmOrRewriting")}</> : <><Wand2 size={14} /> {t("hmOrRewrite")}</>}
          </button>
        </div>
      )}

      {rw && (
        <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmOrResult")}</div>
            <span style={{ fontSize: "13px", fontWeight: 700, color: BAND_COLOR[rw.before.band] }}>{rw.before.score}</span>
            <span style={{ color: "var(--color-text-secondary)" }}>→</span>
            <span style={{ fontSize: "18px", fontWeight: 800, color: BAND_COLOR[rw.after.band] }}>{rw.after.score}</span>
            <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
              {t("hmOrSubstance")}: {rw.before.substance.unique.length} → {rw.after.substance.unique.length}
              {rw.aiAfter !== undefined && <> · AI {rw.aiAfter}%</>}
            </span>
            <span style={{ flex: 1 }} />
            <button onClick={() => { setText(rw.text); setReport(rw.after); setRw(null); }} style={ghostBtn}><Check size={13} /> {t("hmHumanizeAccept")}</button>
            <button onClick={() => rewrite(rw.text)} disabled={busy !== null} style={ghostBtn}><Wand2 size={13} /> {t("hmHumanizeAgain")}</button>
            <button onClick={() => navigator.clipboard.writeText(rw.text).catch(() => {})} style={ghostBtn}><Copy size={13} /> {t("rwCopy")}</button>
          </div>
          <FactDriftPanel drift={rw.drift} />
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: "13px", lineHeight: 1.7, color: "var(--color-text-primary)", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "14px 16px", maxHeight: "420px", overflow: "auto" }}>{rw.text}</pre>
        </div>
      )}
    </>
  );
}

function ReportCard({ r, sibLabels }: { r: OriginalityReport; sibLabels: string[] }) {
  const { t } = useLanguage();
  const color = BAND_COLOR[r.band];
  const flag = (ok: boolean, Icon: typeof Table2, text: string, n?: number) => (
    <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12px", color: ok ? "#34c759" : "var(--color-text-secondary)" }}>
      <Icon size={13} /> {text}{n !== undefined ? `: ${n}` : ""}
    </div>
  );
  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
        <div style={{ fontSize: "34px", fontWeight: 800, color, lineHeight: 1 }}>{r.score}</div>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, color }}>{t(BAND_KEY[r.band])}</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
            {r.words} {t("hmWords")} · {t("hmOrSiblingsCount").replace("{n}", r.skipped ? `${r.siblings}/${r.siblings + r.skipped}` : String(r.siblings))}
            {r.shingles.closest >= 0 && <> · {t("hmOrClosest").replace("{p}", String(Math.round(r.shingles.maxSimilarity * 100)))} ({sibLabels[r.shingles.closest] ?? `#${r.shingles.closest + 1}`})</>}
          </div>
        </div>
      </div>

      {r.short && (
        <div style={{ fontSize: "12px", color: "var(--color-accent-orange)", display: "flex", gap: "6px", alignItems: "flex-start", lineHeight: 1.5 }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: "2px" }} /> {t("hmOrShort").replace("{n}", String(r.words))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "6px" }}><Layers size={13} /> {t("hmOrShingles")} · {Math.round(r.shingles.gain * 100)}%</div>
          <Meter value={r.shingles.gain} color={ACCENT} />
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("hmOrShinglesHint")}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmOrSubstance")} · {r.substance.unique.length} ({r.substance.per1k}/1000)</div>
          <Meter value={r.substance.gain} color="#8B5CF6" />
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("hmOrSubstanceHint")}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmOrStructure")}</div>
          {flag(r.structure.hasTable, Table2, t("hmOrTable"))}
          {flag(r.structure.uniqueHeadings.length >= 2, Heading, t("hmOrUniqueHeadings"), r.structure.uniqueHeadings.length)}
          {flag(r.structure.uniqueAnchors.length > 0, Link2, t("hmOrUniqueAnchors"), r.structure.uniqueAnchors.length)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("hmOrUniqueFacts")}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
          {r.substance.unique.map(f => (
            <span key={f} style={{ fontSize: "11px", padding: "3px 9px", borderRadius: "20px", background: "rgba(52,199,89,0.12)", color: "#34c759", fontWeight: 600 }}>{f}</span>
          ))}
          {!r.substance.unique.length && <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>—</span>}
        </div>
      </div>

      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("hmOrCaveat")}</div>
    </div>
  );
}
