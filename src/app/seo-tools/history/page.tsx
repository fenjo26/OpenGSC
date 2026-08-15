"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Eye, Trash2, FileText, ScrollText, BarChart3, LayoutTemplate, Loader2, AlertTriangle, X, Boxes, Bot, Fingerprint, Wand2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { loadHistory, removeHistory, clearHistory, HistoryItem } from "@/lib/seo/history";
import { listJobs, importJob, deleteJob, clearFailedJobs, SeoJobRec } from "@/lib/seo/jobs";
import { scoreText } from "@/lib/seo/aidetect";
import { getActiveModel, type StoredModel } from "@/lib/seo/aidetectStore";

// Job rows come from the server, and the server accepts types this local table doesn't know
// (outline_auto over the jobs API, rewrite inserted directly by MCP) — plus whatever a future
// release adds. The lookup must stay total or one unknown row takes the whole page down.
const TYPE_META: Record<string, { labelKey: string; color: string; icon: any }> = {
  outline: { labelKey: "seoBadgeOutline", color: "#2997ff", icon: FileText },
  // batch SERP→scrape→outline; completes into History as a regular outline
  outline_auto: { labelKey: "seoBadgeOutline", color: "#2997ff", icon: FileText },
  text: { labelKey: "seoBadgeText", color: "#bf5af2", icon: ScrollText },
  analysis: { labelKey: "seoBadgeAnalysis", color: "#ff9f0a", icon: BarChart3 },
  landing: { labelKey: "seoBadgeLanding", color: "#bf5af2", icon: LayoutTemplate },
  cluster: { labelKey: "seoBadgeCluster", color: "#34c759", icon: Boxes },
  googlebot: { labelKey: "seoBadgeGooglebot", color: "#4285F4", icon: Bot },
  // MCP batch rewrites are not imported into History, but they surface here while running
  rewrite: { labelKey: "seoBadgeRewrite", color: "#ff9f0a", icon: Wand2 },
};
const FALLBACK_META = { labelKey: "", color: "#8e8e93", icon: FileText };
const metaFor = (type: string) => TYPE_META[type] ?? FALLBACK_META;

type Filter = "all" | "done" | "progress" | "outline" | "text" | "analysis" | "landing" | "cluster" | "googlebot";

export default function HistoryPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [jobs, setJobs] = useState<SeoJobRec[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [fp, setFp] = useState<StoredModel | null>(null);
  useEffect(() => { setFp(getActiveModel()); }, []);

  // Score every stored article against the active fingerprint model. Scoring is local arithmetic
  // over a token map, so doing it for the whole list is cheap — but it's memoised on the model and
  // the item list anyway, since History can hold 40 full articles.
  const scores = useMemo(() => {
    if (!fp) return {} as Record<string, number>;
    const out: Record<string, number> = {};
    for (const it of items) {
      if (it.type === "text" && typeof it.data === "string" && it.data.length > 200) {
        try { out[it.id] = scoreText(it.data, fp.model).avgScore; } catch { /* skip unscoreable */ }
      }
    }
    return out;
  }, [fp, items]);
  const sColor = (s: number) => (s < 15 ? "#34c759" : s < 40 ? "#ff9f0a" : "#ff375f");

  // Pull server-side background jobs: import finished ones into local History, keep showing
  // the ones still processing/errored, and poll while anything is in progress.
  useEffect(() => {
    setItems(loadHistory());
    let alive = true;
    let timer: any;
    async function sync() {
      const list = await listJobs();
      if (!alive) return;
      const completed = list.filter(j => j.status === "completed");
      for (const j of completed) await importJob(j);
      if (completed.length) setItems(loadHistory());
      const rest = list.filter(j => j.status === "processing" || j.status === "error");
      setJobs(rest);
      if (alive) timer = setTimeout(sync, rest.some(j => j.status === "processing") ? 3000 : 20000);
    }
    sync();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  async function dismissJob(id: string) { await deleteJob(id); setJobs(j => j.filter(x => x.id !== id)); }
  async function clearFailed() { await clearFailedJobs(); setJobs(j => j.filter(x => x.status !== "error")); }
  const failedCount = useMemo(() => jobs.filter(j => j.status === "error").length, [jobs]);

  const counts = useMemo(() => ({
    all: items.length + jobs.length,
    done: items.filter(i => i.status === "completed").length,
    progress: jobs.filter(j => j.status === "processing").length,
  }), [items, jobs]);

  const visibleJobs = useMemo(() => jobs.filter(j => {
    if (filter === "done") return false;
    if (filter === "progress") return j.status === "processing";
    if (filter === "outline" || filter === "text" || filter === "analysis" || filter === "landing" || filter === "cluster" || filter === "googlebot") return j.type === filter;
    if (q.trim()) return j.keyword.toLowerCase().includes(q.toLowerCase());
    return true;
  }), [jobs, filter, q]);

  const filtered = useMemo(() => {
    let list = items;
    if (filter === "outline" || filter === "text" || filter === "analysis" || filter === "landing" || filter === "cluster" || filter === "googlebot") list = list.filter(i => i.type === filter);
    if (filter === "done") list = list.filter(i => i.status === "completed");
    if (filter === "progress") list = list.filter(i => i.status === "processing");
    if (q.trim()) list = list.filter(i => i.keyword.toLowerCase().includes(q.toLowerCase()));
    return list;
  }, [items, filter, q]);

  function view(item: HistoryItem) {
    router.push(`/seo-tools/history/${item.id}`);
  }
  function remove(id: string) { removeHistory(id); setItems(loadHistory()); }

  const FILTERS: { key: Filter; label: string; count?: number }[] = [
    { key: "all", label: t("seoHistFilterAll"), count: counts.all },
    { key: "done", label: t("seoHistFilterDone"), count: counts.done },
    { key: "progress", label: t("seoHistFilterProgress"), count: counts.progress },
    { key: "outline", label: t("seoHistFilterOutlines") },
    { key: "text", label: t("seoHistFilterTexts") },
    { key: "analysis", label: t("seoHistFilterAnalyses") },
    { key: "landing", label: t("seoHistFilterLanding") },
    { key: "googlebot", label: t("seoHistFilterGooglebot") },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <div>
        <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px" }}>{t("seoHistoryTitle")}</h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("seoHistorySub")}</p>
      </div>

      <div className="panel">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "14px", flexWrap: "wrap" }}>
          <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("seoHistoryAll")}</h3>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1, justifyContent: "flex-end", flexWrap: "wrap" }}>
            {failedCount > 0 && (
              <button onClick={clearFailed} style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 12px", borderRadius: "8px", border: "1px solid rgba(255,69,58,0.3)", background: "rgba(255,69,58,0.06)", color: "var(--color-accent-red)", fontSize: "12px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                <Trash2 size={13} /> {t("seoHistClearFailed")} ({failedCount})
              </button>
            )}
            <div style={{ position: "relative", maxWidth: "320px", minWidth: "180px", flex: 1 }}>
              <Search size={14} style={{ position: "absolute", left: "11px", top: "50%", transform: "translateY(-50%)", color: "var(--color-text-tertiary)" }} />
              <input className="tool-input" style={{ paddingLeft: "32px" }} value={q} onChange={e => setQ(e.target.value)} placeholder={t("seoHistorySearch")} />
            </div>
          </div>
        </div>

        {/* filters */}
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "14px" }}>
          {FILTERS.map(f => {
            const on = filter === f.key;
            return (
              <button key={f.key} onClick={() => setFilter(f.key)} style={{
                padding: "6px 12px", borderRadius: "8px", fontSize: "12px", fontWeight: on ? 700 : 500, cursor: "pointer",
                border: "none", background: on ? "var(--color-accent-blue)" : "transparent",
                color: on ? "#fff" : "var(--color-text-secondary)",
              }}>
                {f.label}{f.count != null ? ` (${f.count})` : ""}
              </button>
            );
          })}
        </div>

        <div style={{ borderTop: "1px solid var(--color-border)" }}>
          {filtered.length === 0 && visibleJobs.length === 0 && (
            <div style={{ padding: "32px 12px", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("seoHistEmpty")}</div>
          )}
          {visibleJobs.map(job => {
            const m = metaFor(job.type); const Icon = m.icon; const isErr = job.status === "error";
            return (
              <div key={job.id} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "13px 4px", borderBottom: "1px solid var(--color-border)", background: isErr ? "rgba(255,69,58,0.04)" : "rgba(41,151,255,0.04)" }}>
                {isErr ? <AlertTriangle size={16} color="var(--color-accent-red)" style={{ flexShrink: 0 }} /> : <Loader2 size={16} className="spin" color="var(--color-accent-blue)" style={{ flexShrink: 0 }} />}
                <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", fontWeight: 700, padding: "3px 9px", borderRadius: "6px", color: m.color, background: `${m.color}1a`, flexShrink: 0 }}><Icon size={12} /> {m.labelKey ? t(m.labelKey as any) : job.type}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: "14px", color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.keyword || "—"}</span>
                <span style={{ fontSize: "12px", color: isErr ? "var(--color-accent-red)" : "var(--color-accent-blue)", flexShrink: 0, maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{isErr ? (job.error || t("seoStatusError")) : t("seoStatusGenerating")}</span>
                {isErr && <button onClick={() => dismissJob(job.id)} title={t("seoDelete")} style={{ ...iconBtn, color: "var(--color-accent-red)" }}><X size={14} /></button>}
              </div>
            );
          })}
          {filtered.map(item => {
            const m = metaFor(item.type); const Icon = m.icon;
            return (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "13px 4px", borderBottom: "1px solid var(--color-border)" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: item.status === "processing" ? "var(--color-accent-blue)" : item.status === "error" ? "var(--color-accent-red)" : "var(--color-accent-green)" }} />
                <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", fontWeight: 700, padding: "3px 9px", borderRadius: "6px", color: m.color, background: `${m.color}1a`, flexShrink: 0 }}>
                  <Icon size={12} /> {m.labelKey ? t(m.labelKey as any) : item.type}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: "14px", color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.keyword}</span>
                {scores[item.id] !== undefined && (
                  <span title={t("hmProxyWarning" as any)} style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "20px", flexShrink: 0, color: sColor(scores[item.id]), background: `${sColor(scores[item.id])}1f` }}>
                    <Fingerprint size={11} /> {scores[item.id]}%
                  </span>
                )}
                <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)", flexShrink: 0 }}>{new Date(item.createdAt).toLocaleDateString()}</span>
                <button onClick={() => view(item)} title={t("seoEdit")} style={iconBtn}><Eye size={15} /></button>
                <button onClick={() => remove(item.id)} title={t("seoDelete")} style={{ ...iconBtn, color: "var(--color-accent-red)" }}><Trash2 size={14} /></button>
              </div>
            );
          })}
        </div>

        {items.length > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "12px" }}>
            <button onClick={() => { clearHistory(); setItems([]); }} style={{ fontSize: "12px", color: "var(--color-accent-red)", background: "none", border: "none", cursor: "pointer" }}>{t("seoHistClear")}</button>
          </div>
        )}
      </div>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center", padding: "6px", borderRadius: "7px",
  border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", cursor: "pointer", flexShrink: 0,
};
