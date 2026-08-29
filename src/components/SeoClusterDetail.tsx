"use client";

// Detail view for a "cluster" history item — Phase 2: the cluster list doubles as a PAGE
// PLAN. Every cluster is auto-classified into a page type (mapped to a structure template),
// the type is editable, clusters can be merged, and selected pages can be batch-generated:
// a sequential queue of fully-automated outline jobs (SERP → scrape → outline, server-side).

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Boxes, Copy, Check, Wand2, Download, Loader2, Square, CheckSquare } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { HistoryItem, updateHistory } from "@/lib/seo/history";
import { startJob, getJob, importJob } from "@/lib/seo/jobs";
import { getSerpCreds, getFirecrawlKey, getTaskCreds, loadPolicies, getActivePolicyName } from "@/lib/seo/keys";
import { OUTLINE_TEMPLATES } from "@/lib/seo/templates";

const INTENT_COLOR: Record<string, string> = { buy: "#10A37F", review: "#2997ff", listicle: "#ff9f0a", use_case: "#8e8e93", info: "#8e8e93" };
const btnGhost: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 13px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" };
const btnPurple: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "7px", padding: "10px 16px", borderRadius: "9px", border: "none", background: "var(--color-accent-purple)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" };

// Suggest a page type (→ structure template) from the cluster's keywords. Patterns follow
// the iGaming monobrand grid, but fall back cleanly for any niche.
const PAGE_TYPES: { id: string; tpl: string | null; re: RegExp }[] = [
  { id: "app",          tpl: "brand_app",          re: /\bapp\b|application|apk|mobile|мобильн|додаток/i },
  { id: "bonus",        tpl: "brand_bonuses",      re: /bonus|бонус/i },
  { id: "promo",        tpl: "brand_promo",        re: /promo|code|код|промокод/i },
  { id: "payments",     tpl: "brand_payments",     re: /retrait|d[ée]p[oô]t|deposit|withdraw|paiement|payment|вывод|депозит|плат[её]ж|виведення/i },
  { id: "registration", tpl: "brand_registration", re: /inscri|register|sign ?up|регистрац|реєстрац|connexion|login|se connecter/i },
  { id: "casino",       tpl: "brand_casino",       re: /casino|казино|slots?|слот|machine [àa] sous/i },
  { id: "sport",        tpl: "brand_sportsbook",   re: /paris? sportif|sport|ставк|bet\b|pari\b/i },
  { id: "review",       tpl: "casino_review",      re: /avis|review|обзор|огляд|fiable|l[ée]gal|arnaque|честн/i },
];
export function suggestPageType(name: string, kws: string[]): string {
  const hay = [name, ...kws.slice(0, 10)].join(" ");
  for (const p of PAGE_TYPES) if (p.re.test(hay)) return p.id;
  return name.trim().split(/\s+/).length === 1 ? "main" : "generic";
}
const TYPE_TPL: Record<string, string | null> = { main: "brand_main", generic: null, ...Object.fromEntries(PAGE_TYPES.map(p => [p.id, p.tpl])) };
const TYPE_IDS = ["main", ...PAGE_TYPES.map(p => p.id), "generic"];

export default function SeoClusterDetail({ item }: { item: HistoryItem }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [copied, setCopied] = useState<string>("");
  const data = item.data || {};
  const clusters: any[] = Array.isArray(data.clusters) ? data.clusters : [];
  const p = data.params || {};

  // Plan state: selection + editable page types (persisted into the history item).
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [types, setTypes] = useState<Record<number, string>>(() =>
    Object.fromEntries(clusters.map((c, i) => [i, c.page_type || suggestPageType(c.name, c.keywords.map((k: any) => k.keyword))])));
  const [batch, setBatch] = useState<{ done: number; total: number; current: string } | null>(null);
  const [err, setErr] = useState("");

  function persistData(next: any) { updateHistory(item.id, next); }

  function setType(i: number, v: string) {
    setTypes(prev => ({ ...prev, [i]: v }));
    clusters[i].page_type = v;
    persistData({ ...data, clusters });
  }

  function mergeInto(from: number, to: number) {
    if (from === to) return;
    const src = clusters[from], dst = clusters[to];
    dst.keywords = [...dst.keywords, ...src.keywords];
    dst.volume = (dst.volume || 0) + (src.volume || 0);
    clusters.splice(from, 1);
    persistData({ ...data, clusters });
    setSel(new Set()); setTypes(Object.fromEntries(clusters.map((c, i) => [i, c.page_type || suggestPageType(c.name, c.keywords.map((k: any) => k.keyword))])));
  }

  function toOutline(c: any) {
    sessionStorage.setItem("seoClusterSeed", JSON.stringify({
      keyword: c.name, additional: c.keywords.slice(1).map((k: any) => k.keyword).join(", "), gl: p.gl, hl: p.hl,
    }));
    router.push("/seo-tools/outline");
  }

  // Sequential batch: one outline_auto job at a time (parallel jobs would trip provider
  // rate limits — each runs the full multi-pass pipeline). Tab must stay open to advance
  // the queue; already-started jobs finish server-side regardless.
  async function runBatch() {
    setErr("");
    const serp = getSerpCreds();
    const ai = getTaskCreds("outline");
    if (!serp.apiKey) { setErr(t("seoErrNoSerpKey")); return; }
    if (!ai.apiKey) { setErr(t("seoErrNoAiKey")); return; }
    const policy = loadPolicies().find(x => x.name === getActivePolicyName()) || loadPolicies()[0];
    const picked = [...sel].sort((a, b) => a - b);
    setBatch({ done: 0, total: picked.length, current: "" });
    for (let n = 0; n < picked.length; n++) {
      const c = clusters[picked[n]];
      if (!c) continue;
      setBatch({ done: n, total: picked.length, current: c.name });
      const tplId = TYPE_TPL[types[picked[n]] || "generic"];
      const tpl = tplId ? OUTLINE_TEMPLATES.find(x => x.id === tplId) : null;
      try {
        const { jobId, error } = await startJob("outline_auto", {
          keyword: c.name,
          gl: p.gl, hl: p.hl, country: p.gl, language: p.hl,
          serpProvider: serp.provider, serpKey: serp.apiKey, serpBaseUrl: serp.baseUrl, firecrawlKey: getFirecrawlKey() || undefined,
          aiProvider: ai.provider, aiApiKey: ai.apiKey, model: ai.model || undefined, aiBaseUrl: ai.baseUrl || undefined,
          policy,
          additionalKeywords: c.keywords.slice(1).map((k: any) => k.keyword).join(", "),
          keywordsData: c.keywords.map((k: any) => ({ keyword: k.keyword, volume: k.volume || 0 })),
          customTemplate: tpl ? tpl.body.replace(/\{year\}/gi, String(new Date().getFullYear())) : undefined,
          pageGoal: "commercial",
          useRag: true,
        }, { fromClusterId: item.id });
        if (error || !jobId) { setErr(`${c.name}: ${error || "job_failed"}`); continue; }
        // Poll until the job finishes, then import so it shows up in History immediately.
        for (;;) {
          await new Promise(r => setTimeout(r, 5000));
          const job = await getJob(jobId);
          if (!job) break;
          if (job.status === "completed") { await importJob(job); break; }
          if (job.status === "error") { setErr(`${c.name}: ${job.error || "error"}`); break; }
        }
        c.outline_done = true;
        persistData({ ...data, clusters });
      } catch (e: any) { setErr(`${c.name}: ${String(e?.message ?? e)}`); }
    }
    setBatch({ done: picked.length, total: picked.length, current: "" });
    setTimeout(() => setBatch(null), 3000);
  }

  function copyCluster(c: any) {
    navigator.clipboard.writeText(c.keywords.map((k: any) => k.keyword).join("\n"));
    setCopied(c.name); setTimeout(() => setCopied(""), 1200);
  }

  function exportCsv() {
    const rows = [["cluster", "page_type", "intent", "keyword", "volume", "overlap"]];
    for (let i = 0; i < clusters.length; i++) for (const k of clusters[i].keywords)
      rows.push([clusters[i].name, types[i] || "", clusters[i].intent, k.keyword, String(k.volume ?? 0), String(k.overlap ?? "")]);
    const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
    a.download = `clusters-${item.keyword || "keywords"}.csv`;
    a.click();
  }

  const allSelected = sel.size === clusters.length && clusters.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div className="panel" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <button onClick={() => router.push("/seo-tools/history")} style={btnGhost}><ArrowLeft size={15} /> {t("seoBackToHistory")}</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0, display: "flex", alignItems: "center", gap: "8px" }}>
            <Boxes size={17} color="var(--color-accent-purple)" /> {t("seoClusterResult")}: {item.keyword}
          </h2>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
            {clusters.length} {t("seoClustersWord")} · {p.clustered ?? "?"}/{p.total_keywords ?? "?"} {t("seoClusterKwProcessed")} · {t("seoClusterThreshold")}: {p.threshold}
          </div>
        </div>
        <button onClick={exportCsv} style={btnGhost}><Download size={13} /> CSV</button>
      </div>

      {/* Page-plan toolbar */}
      <div className="panel" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <button onClick={() => setSel(allSelected ? new Set() : new Set(clusters.map((_, i) => i)))} style={btnGhost}>
          {allSelected ? <CheckSquare size={13} /> : <Square size={13} />} {t("seoSelectAll")}
        </button>
        <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("seoPlanSelected")}: {sel.size}</span>
        <button onClick={runBatch} disabled={!sel.size || !!batch} style={{ ...btnPurple, marginLeft: "auto", opacity: !sel.size || batch ? 0.6 : 1 }}>
          {batch ? <Loader2 size={15} className="spin" /> : <Wand2 size={15} />} {t("seoPlanGenerate")} ({sel.size})
        </button>
      </div>
      {batch && (
        <div className="panel" style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
          ⏳ {t("seoPlanProgress")}: {batch.done}/{batch.total}{batch.current ? ` — ${batch.current}` : ""} <span style={{ color: "var(--color-text-tertiary)" }}>· {t("seoPlanKeepOpen")}</span>
        </div>
      )}
      {err && <div className="panel" style={{ borderColor: "rgba(255,69,58,0.35)", background: "rgba(255,69,58,0.06)", color: "var(--color-accent-red)", fontSize: "12px" }}>{err}</div>}

      {clusters.map((c, i) => (
        <div key={i} className="panel" style={{ borderColor: sel.has(i) ? "rgba(191,90,242,0.5)" : undefined }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "8px" }}>
            <span onClick={() => setSel(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; })} style={{ cursor: "pointer", display: "flex" }}>
              {sel.has(i) ? <CheckSquare size={17} color="var(--color-accent-purple)" /> : <Square size={17} color="var(--color-text-tertiary)" />}
            </span>
            <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{c.name}</span>
            {c.outline_done && <span title={t("seoPlanDone")} style={{ fontSize: "11px", color: "var(--color-accent-green)" }}>✓ ТЗ</span>}
            <span style={{ fontSize: "10px", fontWeight: 700, padding: "3px 9px", borderRadius: "20px", color: INTENT_COLOR[c.intent] || "var(--color-text-secondary)", background: `${INTENT_COLOR[c.intent] || "#888"}1a` }}>{c.intent}</span>
            <select value={types[i] || "generic"} onChange={e => setType(i, e.target.value)}
              style={{ fontSize: "11px", fontWeight: 600, padding: "3px 8px", borderRadius: "7px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)" }}>
              {TYPE_IDS.map(id => <option key={id} value={id}>{t(`seoPt_${id}` as any)}</option>)}
            </select>
            <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{c.keywords.length} {t("seoClusterKws")} · {Number(c.volume).toLocaleString()}</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: "6px", alignItems: "center" }}>
              <select value="" onChange={e => { if (e.target.value !== "") mergeInto(i, Number(e.target.value)); }}
                title={t("seoPlanMergeHint")}
                style={{ fontSize: "11px", padding: "3px 6px", borderRadius: "7px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", maxWidth: "140px" }}>
                <option value="">{t("seoPlanMerge")}…</option>
                {clusters.map((o, j) => j !== i ? <option key={j} value={j}>→ {o.name.slice(0, 30)}</option> : null)}
              </select>
              <button onClick={() => copyCluster(c)} style={btnGhost}>{copied === c.name ? <Check size={12} /> : <Copy size={12} />}</button>
              <button onClick={() => toOutline(c)} style={{ ...btnGhost, color: "var(--color-accent-purple)", borderColor: "rgba(191,90,242,0.4)" }}><Wand2 size={12} /> {t("seoClusterToOutline")}</button>
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {c.keywords.map((k: any, j: number) => (
              <span key={j} title={`overlap: ${k.overlap}`} style={{ fontSize: "12px", padding: "3px 10px", borderRadius: "16px", border: "1px solid var(--color-border)", color: "var(--color-text-primary)", background: j === 0 ? "rgba(191,90,242,0.08)" : "transparent" }}>
                {k.keyword}{k.volume ? <span style={{ color: "var(--color-text-tertiary)" }}> · {Number(k.volume).toLocaleString()}</span> : null}
              </span>
            ))}
          </div>
          {Array.isArray(c.top_domains) && c.top_domains.length > 0 && (
            <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "8px" }}>SERP: {c.top_domains.join(" · ")}</div>
          )}
        </div>
      ))}

      {Array.isArray(p.failed) && p.failed.length > 0 && (
        <div className="panel" style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
          ⚠️ {t("seoClusterFailedKws")}: {p.failed.slice(0, 20).join(", ")}{p.failed.length > 20 ? "…" : ""}
        </div>
      )}
    </div>
  );
}
