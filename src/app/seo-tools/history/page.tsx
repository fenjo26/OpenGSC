"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Eye, Trash2, FileText, ScrollText, BarChart3, LayoutTemplate, Loader2, AlertTriangle, X, Boxes, Bot, Fingerprint, Wand2, ChevronLeft, ChevronRight } from "lucide-react";
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

const PAGE = 50;

function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString()}, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

// Compact page list: first, last, and a window around the current page, with ellipses.
function pageWindow(cur: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const out: (number | "…")[] = [0];
  const from = Math.max(1, cur - 1);
  const to = Math.min(total - 2, cur + 1);
  if (from > 1) out.push("…");
  for (let p = from; p <= to; p++) out.push(p);
  if (to < total - 2) out.push("…");
  out.push(total - 1);
  return out;
}

export default function HistoryPage() {
  const { t } = useLanguage();
  const router = useRouter();
  // The display list: a THIN row for every server record (no article bodies — search, filters
  // and counts run over the whole history without shipping megabytes), with the local cache
  // merged on top (fresh records that exist nowhere else yet, plus full bodies for scoring).
  const [rows, setRows] = useState<HistoryItem[]>([]);
  const [jobs, setJobs] = useState<SeoJobRec[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [fp, setFp] = useState<StoredModel | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const scoreAskedRef = useRef<Set<string>>(new Set());
  useEffect(() => { setFp(getActiveModel()); }, []);

  // Merge records into the display list. Later sources win per id (the cache is fresher than
  // the thin index; the index fills ids the cache has evicted).
  function mergeIntoRows(recs: HistoryItem[]) {
    if (!recs.length) return;
    setRows(prev => {
      const byId = new Map(prev.map(h => [h.id, h]));
      for (const r of recs) if (r?.id) byId.set(r.id, r);
      return [...byId.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || (a.id < b.id ? 1 : -1));
    });
  }

  // Thin index of EVERY server record — the backbone for search/filter/counts over the full
  // history. Light enough to refetch on the slow poll tick, so records created elsewhere
  // (MCP runs, another browser) appear without a reload.
  async function refreshIndex() {
    try {
      const res = await fetch("/api/seo/history?index=1", { cache: "no-store" });
      if (!res.ok) return;
      const d = await res.json();
      const thin: HistoryItem[] = Array.isArray(d?.rows)
        ? d.rows.map((r: any) => ({ id: r.id, type: r.type, keyword: r.keyword, status: r.status, createdAt: r.createdAt, data: undefined }))
        : [];
      mergeIntoRows(thin);
    } catch { /* offline — the local cache still shows */ }
  }

  // Pull server-side background jobs: import finished ones into the History store, keep showing
  // the ones still processing/errored, and poll while anything is in progress.
  useEffect(() => {
    setRows(loadHistory());
    void refreshIndex();
    let alive = true;
    let timer: any;
    async function sync() {
      const list = await listJobs();
      if (!alive) return;
      const completed = list.filter(j => j.status === "completed");
      for (const j of completed) await importJob(j);
      if (completed.length) mergeIntoRows(loadHistory());
      const rest = list.filter(j => j.status === "processing" || j.status === "error");
      setJobs(rest);
      const slow = !rest.some(j => j.status === "processing");
      if (slow) void refreshIndex();
      if (alive) timer = setTimeout(sync, slow ? 20000 : 3000);
    }
    sync();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  async function dismissJob(id: string) { await deleteJob(id); setJobs(j => j.filter(x => x.id !== id)); }
  async function clearFailed() { await clearFailedJobs(); setJobs(j => j.filter(x => x.status !== "error")); }
  const failedCount = useMemo(() => jobs.filter(j => j.status === "error").length, [jobs]);

  const counts = useMemo(() => ({
    all: rows.length + jobs.length,
    done: rows.filter(i => i.status === "completed").length,
    progress: jobs.filter(j => j.status === "processing").length,
    outline: rows.filter(i => i.type === "outline").length,
    text: rows.filter(i => i.type === "text").length,
    analysis: rows.filter(i => i.type === "analysis").length,
    landing: rows.filter(i => i.type === "landing").length,
    googlebot: rows.filter(i => i.type === "googlebot").length,
  }), [rows, jobs]);

  const visibleJobs = useMemo(() => jobs.filter(j => {
    if (filter === "done") return false;
    if (filter === "progress") return j.status === "processing";
    if (filter === "outline" || filter === "text" || filter === "analysis" || filter === "landing" || filter === "cluster" || filter === "googlebot") return j.type === filter;
    if (q.trim()) return j.keyword.toLowerCase().includes(q.toLowerCase());
    return true;
  }), [jobs, filter, q]);

  const filtered = useMemo(() => {
    let list = rows;
    if (filter === "outline" || filter === "text" || filter === "analysis" || filter === "landing" || filter === "cluster" || filter === "googlebot") list = list.filter(i => i.type === filter);
    if (filter === "done") list = list.filter(i => i.status === "completed");
    if (filter === "progress") list = list.filter(i => i.status === "processing");
    if (q.trim()) list = list.filter(i => i.keyword.toLowerCase().includes(q.toLowerCase()));
    return list;
  }, [rows, filter, q]);

  // A new filter/search starts from the first page.
  useEffect(() => { setPage(0); }, [filter, q]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const safePage = Math.min(page, pages - 1);
  const visible = useMemo(() => filtered.slice(safePage * PAGE, safePage * PAGE + PAGE), [filtered, safePage]);

  // Fingerprint scores for the visible page. Items whose body is already local (cache) score
  // immediately; the rest fetch exactly those ids from the server — one light request per page,
  // never the whole history. Badges are decoration: failures are skipped, not retried.
  useEffect(() => {
    if (!fp) return;
    const next: Record<string, number> = {};
    const missing: string[] = [];
    for (const it of visible) {
      if (it.type !== "text") continue;
      if (typeof it.data === "string" && it.data.length > 200) {
        try { next[it.id] = scoreText(it.data, fp.model).avgScore; } catch { /* skip unscoreable */ }
      } else if (!scoreAskedRef.current.has(it.id)) {
        missing.push(it.id);
      }
    }
    if (Object.keys(next).length) setScores(s => ({ ...s, ...next }));
    if (!missing.length) return;
    for (const id of missing) scoreAskedRef.current.add(id);
    void (async () => {
      try {
        const res = await fetch(`/api/seo/history?ids=${missing.map(encodeURIComponent).join(",")}`, { cache: "no-store" });
        if (!res.ok) return;
        const d = await res.json();
        const recs: HistoryItem[] = Array.isArray(d?.records) ? d.records : [];
        const got: Record<string, number> = {};
        for (const r of recs) {
          if (typeof r.data === "string" && r.data.length > 200) {
            try { got[r.id] = scoreText(r.data, fp.model).avgScore; } catch { /* skip unscoreable */ }
          }
        }
        if (Object.keys(got).length) setScores(s => ({ ...s, ...got }));
      } catch { /* offline — badges simply don't render */ }
    })();
  }, [visible, fp]);

  const sColor = (s: number) => (s < 15 ? "#34c759" : s < 40 ? "#ff9f0a" : "#ff375f");

  function view(item: HistoryItem) {
    router.push(`/seo-tools/history/${item.id}`);
  }
  function remove(id: string) {
    removeHistory(id); // drops the local copy and the server row
    setRows(list => list.filter(i => i.id !== id));
    scoreAskedRef.current.delete(id);
    setScores(({ [id]: _drop, ...rest }) => rest);
    void refreshIndex(); // keep counts in step with the server
  }

  const FILTERS: { key: Filter; labelKey: string; count: number }[] = [
    { key: "all", labelKey: "seoHistFilterAll", count: counts.all },
    { key: "done", labelKey: "seoHistFilterDone", count: counts.done },
    { key: "progress", labelKey: "seoHistFilterProgress", count: counts.progress },
    { key: "outline", labelKey: "seoHistFilterOutlines", count: counts.outline },
    { key: "text", labelKey: "seoHistFilterTexts", count: counts.text },
    { key: "analysis", labelKey: "seoHistFilterAnalyses", count: counts.analysis },
    { key: "landing", labelKey: "seoHistFilterLanding", count: counts.landing },
    { key: "googlebot", labelKey: "seoHistFilterGooglebot", count: counts.googlebot },
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
                {t(f.labelKey as any)} ({f.count})
              </button>
            );
          })}
        </div>

        <div style={{ borderTop: "1px solid var(--color-border)" }}>
          {filtered.length === 0 && visibleJobs.length === 0 && (
            <div style={{ padding: "32px 12px", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>
              {q.trim() || filter !== "all" ? t("seoHistNoMatch") : t("seoHistEmpty")}
            </div>
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
          {visible.map(item => {
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
                <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)", flexShrink: 0, whiteSpace: "nowrap" }}>{fmtDateTime(item.createdAt)}</span>
                <button onClick={() => view(item)} title={t("seoEdit")} style={iconBtn}><Eye size={15} /></button>
                <button onClick={() => remove(item.id)} title={t("seoDelete")} style={{ ...iconBtn, color: "var(--color-accent-red)" }}><Trash2 size={14} /></button>
              </div>
            );
          })}
        </div>

        {/* pagination */}
        {pages > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", marginTop: "12px", flexWrap: "wrap" }}>
            <button disabled={safePage === 0} onClick={() => setPage(p => Math.max(0, p - 1))} style={pageBtn(safePage === 0)}><ChevronLeft size={14} /></button>
            {pageWindow(safePage, pages).map((p, i) => p === "…" ? (
              <span key={`e${i}`} style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>…</span>
            ) : (
              <button key={p} onClick={() => setPage(Number(p))} style={pageBtn(false, p === safePage)}>{p + 1}</button>
            ))}
            <button disabled={safePage >= pages - 1} onClick={() => setPage(p => Math.min(pages - 1, p + 1))} style={pageBtn(safePage >= pages - 1)}><ChevronRight size={14} /></button>
            <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)", marginLeft: "6px", whiteSpace: "nowrap" }}>
              {safePage * PAGE + 1}–{Math.min(filtered.length, (safePage + 1) * PAGE)} / {filtered.length}
            </span>
          </div>
        )}

        {rows.length > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "12px" }}>
            <button onClick={() => { clearHistory(); setRows([]); setScores({}); scoreAskedRef.current.clear(); setPage(0); }} style={{ fontSize: "12px", color: "var(--color-accent-red)", background: "none", border: "none", cursor: "pointer" }}>{t("seoHistClear")}</button>
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

function pageBtn(disabled: boolean, active?: boolean): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: "30px", height: "30px", padding: "0 8px",
    borderRadius: "8px", fontSize: "12px", fontWeight: active ? 700 : 500, cursor: disabled ? "default" : "pointer",
    border: `1px solid ${active ? "var(--color-accent-blue)" : "var(--color-border)"}`,
    background: active ? "var(--color-accent-blue)" : "var(--color-bg)",
    color: active ? "#fff" : disabled ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
    opacity: disabled ? 0.5 : 1,
  };
}
