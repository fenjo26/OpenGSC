"use client";

// /serp-monitor/[id] — one project: header with the run controls, then the three tabs
// (Market / Storms / Domains). The run flow lives here: POST run, 409 cooldown → explicit
// confirm → retry with force, already_running → just show progress; while a run is running the
// page polls GET runs?limit=1 every 3 s, repaints the progress line, and on completion
// reloads the header and bumps `version` so the active tab refetches. The interval is cleared
// on unmount, so leaving the page stops the polling.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle, ArrowLeft, Ban, CheckCircle2, Download, Loader2, Pencil, PauseCircle, Play, Trash2,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePersistedState } from "@/lib/usePersistedState";
import { COUNTRIES } from "@/lib/seo/regions";
import type { ProjectDetail, RunSummary } from "@/lib/serpmon/types";
import DomainsTab from "@/components/serpmon/DomainsTab";
import KeywordDrawer from "@/components/serpmon/KeywordDrawer";
import MarketTab from "@/components/serpmon/MarketTab";
import ProjectDialog from "@/components/serpmon/ProjectDialog";
import StormsTab from "@/components/serpmon/StormsTab";
import {
  btnGhost, btnPrimary, ErrorLine, fmtDate, getJson, relTime, sendJson, trOf,
} from "@/components/serpmon/shared";

const TABS = ["market", "storms", "domains"] as const;
type Tab = (typeof TABS)[number];
const isTab = (v: unknown): boolean => typeof v === "string" && (TABS as readonly string[]).includes(v);
const isStr = (v: unknown): boolean => typeof v === "string";

const countryLabel = (code: string) => COUNTRIES.find(c => c.code === code)?.label ?? code;

export default function SerpProjectPage() {
  const { t } = useLanguage();
  const tr = trOf(t);
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [notMigrated, setNotMigrated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [cooldown, setCooldown] = useState(false);

  // Tab and the market domain filter are URL-addressable (shareable view); the rest of the
  // filter state belongs to MarketTab itself.
  const [tab, setTab] = usePersistedState<Tab>("serpmonTab", "market", isTab, "tab");
  const [host, setHost] = usePersistedState<string>(null, "", isStr, "host");
  const [keyword, setKeyword] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  // Bumped when a run completes — the mounted tab reloads its data.
  const [version, setVersion] = useState(0);

  // Header data + the runs list, on mount. The fetch bodies live inline (no useCallback):
  // every write lands after an awaited fetch, several ticks later, so no second render can
  // cascade before paint.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { status, body } = await getJson(`/api/serp-monitor/projects/${projectId}`);
        if (!alive) return;
        if (body.notMigrated) { setNotMigrated(true); setLoading(false); return; }
        if (status >= 400) { setError(String(body.error ?? status)); setLoading(false); return; }
        setProject(body.project as ProjectDetail);
        setError("");
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    void (async () => {
      try {
        const { body } = await getJson(`/api/serp-monitor/projects/${projectId}/runs?limit=60`);
        if (alive && Array.isArray(body.runs)) setRuns(body.runs as RunSummary[]);
      } catch { /* the header still renders; the poll picks it up next tick */ }
    })();
    return () => { alive = false; };
  }, [projectId]);

  // Progress poll: every 3 s while the latest run is `running`, only in a visible tab.
  // On completion it refetches the header and the full runs list and bumps `version`, so the
  // mounted tab reloads its data. The interval is cleared on unmount or when nothing runs.
  const running = runs.find(r => r.status === "running") ?? null;
  const runningId = running?.id ?? null;
  const runningDone = useRef<string | null>(null);
  useEffect(() => {
    if (!runningId) {
      runningDone.current = null;
      return;
    }
    const id = runningId;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void (async () => {
        try {
          const { body } = await getJson(`/api/serp-monitor/projects/${projectId}/runs?limit=1`);
          const r = (Array.isArray(body.runs) ? body.runs[0] : null) as RunSummary | undefined;
          if (!r) return;
          if (r.status !== "running") {
            // Completed (or aborted): repaint the header, refetch the runs, make tabs reload.
            if (runningDone.current === id) return; // this completion already handled
            runningDone.current = id;
            const [pj, rr] = await Promise.all([
              getJson(`/api/serp-monitor/projects/${projectId}`),
              getJson(`/api/serp-monitor/projects/${projectId}/runs?limit=60`),
            ]);
            if (pj.body.notMigrated) setNotMigrated(true);
            else if (pj.status < 400) setProject(pj.body.project as ProjectDetail);
            if (Array.isArray(rr.body.runs)) setRuns(rr.body.runs as RunSummary[]);
            setVersion(v => v + 1);
          } else {
            setRuns(prev => {
              const next = prev.length ? [...prev] : [r];
              next[0] = r;
              return next;
            });
          }
        } catch { /* a lost poll is retried in 3 s */ }
      })();
    }, 3000);
    return () => clearInterval(timer);
  }, [runningId, projectId]);

  /** Plain function (no memoization contract): refresh the runs list after a user action. */
  async function reloadRuns() {
    try {
      const { body } = await getJson(`/api/serp-monitor/projects/${projectId}/runs?limit=60`);
      if (Array.isArray(body.runs)) setRuns(body.runs as RunSummary[]);
    } catch { /* the poll or the next click picks it up */ }
  }

  async function startRun(force = false) {
    setError(""); setNote(""); setCooldown(false);
    try {
      const { status, body } = await sendJson(`/api/serp-monitor/projects/${projectId}/run`, "POST", force ? { force: true } : {});
      if (status === 409) {
        if (body.error === "cooldown") { setCooldown(true); return; }
        // already_running — the poll below picks the progress back up; say why the click
        // appeared to do nothing.
        setNote(tr("serpmonAlreadyRunning"));
        void reloadRuns();
        return;
      }
      if (status >= 400) {
        if (body.error === "no_creds") setError(tr("serpmonProblem_no_creds"));
        else if (body.error === "no_keywords") setError(tr("serpmonNoKeywords"));
        else setError(String(body.error ?? status));
        return;
      }
      void reloadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function togglePause() {
    if (!project) return;
    setError("");
    try {
      const { status, body } = await sendJson(`/api/serp-monitor/projects/${projectId}`, "PATCH", { paused: !project.paused });
      if (status >= 400) { setError(String(body.error ?? status)); return; }
      setProject(body.project as ProjectDetail);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeProject() {
    if (!project) return;
    if (!window.confirm(tr("serpmonDeleteConfirm").replace("{name}", project.name))) return;
    try {
      const { status, body } = await sendJson(`/api/serp-monitor/projects/${projectId}`, "DELETE");
      if (status >= 400) { setError(String(body.error ?? status)); return; }
      router.push("/serp-monitor");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading) {
    return (
      <div className="main-content" style={{ paddingTop: 20, display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-text-secondary)" }}>
        <Loader2 size={14} className="spin" /> …
      </div>
    );
  }

  const done = running ? running.ok + running.partial + running.failed : 0;
  const planned = running ? running.planned : 0;
  const progressPct = planned > 0 ? Math.min(100, Math.round((done / planned) * 100)) : 0;

  return (
    <div className="main-content" style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 20, paddingBottom: 40 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <Link href="/serp-monitor" title={tr("serpmonPrev")}
          style={{ color: "var(--color-text-secondary)", marginTop: 3, flexShrink: 0 }}>
          <ArrowLeft size={17} />
        </Link>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 20, margin: 0, color: "var(--color-text-primary)", flexWrap: "wrap" }}>
            {project?.name ?? tr("serpmonTitle")}
            {project?.paused && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11.5, color: "var(--color-accent-orange)" }}>
                <PauseCircle size={13} /> {tr("serpmonPaused")}
              </span>
            )}
            {project?.lastRun?.storm && (
              <span style={{
                fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 6,
                background: "rgba(255,69,58,0.12)", color: "var(--color-danger)",
              }}>
                {tr("serpmonStormBadge")}
              </span>
            )}
          </h1>
          <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginTop: 4 }}>
            {project ? `${project.engine} · ${project.device} · ${countryLabel(project.country)} · ${project.lang} · ${tr("serpmonFieldDepth")} ${project.depth}` : ""}
            {" · "}{project ? `${project.keywords.toLocaleString()} ${tr("serpmonColKeyword").toLowerCase()}` : ""}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--color-text-tertiary)", marginTop: 2 }}>
            {tr("serpmonCostNote")}
            {project && (
              <> · {tr("serpmonLastRun")}: {project.lastRunAt ? `${relTime(project.lastRunAt)} (${fmtDate(project.lastRunAt)})` : tr("serpmonNever")}</>
            )}
            {project?.nextRunAt && (
              <> · {tr("serpmonNextRun")}: {relTime(project.nextRunAt)} ({fmtDate(project.nextRunAt)})</>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => setEditOpen(true)} style={btnGhost}><Pencil size={13} /> {tr("serpmonEdit")}</button>
          <a href={`/api/serp-monitor/projects/${projectId}/export?kind=keywords`}
            style={{ ...btnGhost, textDecoration: "none" }}><Download size={13} /> {tr("serpmonExportKeywords")}</a>
          <button onClick={() => void togglePause()} style={btnGhost}>
            {project?.paused ? <><Play size={13} /> {tr("serpmonResume")}</> : <><Ban size={13} /> {tr("serpmonPause")}</>}
          </button>
          <button onClick={() => void removeProject()} style={{ ...btnGhost, color: "var(--color-danger)" }}>
            <Trash2 size={13} /> {tr("serpmonDelete")}
          </button>
          <button onClick={() => void startRun()} style={btnPrimary}>
            <CheckCircle2 size={14} /> {tr("serpmonRunNow")}
          </button>
        </div>
      </div>

      {notMigrated && (
        <div className="panel" style={{ color: "var(--color-accent-orange)", fontSize: 13 }}>
          <AlertTriangle size={15} style={{ verticalAlign: -2, marginRight: 6 }} />{tr("serpmonNotMigrated")}
        </div>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
      {note && (
        <div className="panel" style={{ fontSize: 12.5, color: "var(--color-accent-blue)" }}>{note}</div>
      )}
      {cooldown && (
        <div className="panel" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ color: "var(--color-text-primary)" }}>{tr("serpmonCooldown")}</span>
          <button onClick={() => setCooldown(false)} style={btnGhost}>{tr("serpmonCancel")}</button>
          <button onClick={() => void startRun(true)} style={btnPrimary}>{tr("serpmonRunNow")}</button>
        </div>
      )}

      {/* Run progress */}
      {running && (
        <div className="panel" style={{ fontSize: 12.5, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-text-secondary)" }}>
            <Loader2 size={13} className="spin" />
            {tr("serpmonRunning").replace("{done}", String(done)).replace("{planned}", String(planned))}
          </div>
          <div style={{ height: 6, borderRadius: 3, background: "var(--color-border-soft)", overflow: "hidden" }}>
            <div style={{ width: `${progressPct}%`, height: "100%", background: "var(--color-accent-blue)", borderRadius: 3 }} />
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", borderBottom: "1px solid var(--color-border)" }}>
        {([
          { v: "market", key: "serpmonTabMarket" },
          { v: "storms", key: "serpmonTabStorms" },
          { v: "domains", key: "serpmonTabDomains" },
        ] as const).map(tb => (
          <button key={tb.v} onClick={() => setTab(tb.v)}
            style={{
              padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer",
              background: "transparent", border: "none",
              borderBottom: `2px solid ${tab === tb.v ? "var(--color-accent-blue)" : "transparent"}`,
              color: tab === tb.v ? "var(--color-text-primary)" : "var(--color-text-secondary)",
              marginBottom: -1,
            }}>
            {tr(tb.key)}
          </button>
        ))}
      </div>

      {/* Tab body */}
      {project && tab === "market" && (
        <MarketTab
          projectId={projectId}
          groups={project.groups}
          host={host}
          setHost={setHost}
          version={version}
          onOpenKeyword={setKeyword}
        />
      )}
      {project && tab === "storms" && (
        <StormsTab projectId={projectId} runs={runs} version={version} />
      )}
      {project && tab === "domains" && (
        <DomainsTab
          projectId={projectId}
          version={version}
          onOpenDomain={h => { setHost(h); setTab("market"); }}
        />
      )}

      {keyword && (
        <KeywordDrawer key={keyword} keywordId={keyword} onClose={() => setKeyword(null)} />
      )}

      {editOpen && project && (
        <ProjectDialog
          project={project}
          onClose={() => setEditOpen(false)}
          onSaved={p => { setProject(p); setEditOpen(false); }}
        />
      )}
    </div>
  );
}
