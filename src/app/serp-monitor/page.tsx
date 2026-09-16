"use client";

// /serp-monitor — the project list. A project is a market (engine · country · language ·
// device) plus a keyword set; every card answers "is this market calm or shaking right now"
// with the last-30-runs volatility sparkline, the storm badge and the pause badge before the
// user even opens it.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, CalendarClock, History, Loader2, PauseCircle, Plus, Waves } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { aparserConfiguredLocally, isAparserConfigured } from "@/lib/seo/aparserConfigured";
import { COUNTRIES } from "@/lib/seo/regions";
import type { ProjectSummary } from "@/lib/serpmon/types";
import ProjectDialog, { type ImportInfo } from "@/components/serpmon/ProjectDialog";
import {
  btnPrimary, ErrorLine, getJson, relTime, fmtDate, trOf, VolSparkline,
} from "@/components/serpmon/shared";

const countryLabel = (code: string) => COUNTRIES.find(c => c.code === code)?.label ?? code;

export default function SerpMonitorPage() {
  const { t } = useLanguage();
  const tr = trOf(t);
  const router = useRouter();

  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [notMigrated, setNotMigrated] = useState(false);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [savedNote, setSavedNote] = useState("");
  // This browser's answer first (no request, no flash); the server is only asked when the
  // local answer is "no" — same two-source check as the nav item and /aparser.
  const [aparser, setAparser] = useState<boolean | null>(aparserConfiguredLocally());

  const load = useCallback(async () => {
    setError("");
    try {
      const { status, body } = await getJson("/api/serp-monitor/projects");
      if (body.notMigrated) { setNotMigrated(true); setProjects([]); return; }
      if (status >= 400) { setError(String(body.error ?? status)); setProjects([]); return; }
      setProjects(Array.isArray(body.projects) ? (body.projects as ProjectSummary[]) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProjects([]);
    }
  }, []);

  // Every state write inside load() happens after an awaited fetch, several ticks later —
  // no second render can cascade before paint. The linter cannot see across the await.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (aparser) return;
    let alive = true;
    void isAparserConfigured().then(ok => {
      if (alive && ok) setAparser(true);
    });
    return () => { alive = false; };
  }, [aparser]);

  const onSaved = (p: ProjectSummary, imp: ImportInfo | null) => {
    setDialogOpen(false);
    if (imp) {
      setSavedNote(tr("serpmonImportResult")
        .replace("{added}", String(imp.added ?? 0))
        .replace("{duplicates}", String(imp.duplicates ?? 0))
        .replace("{skipped}", String(imp.skipped ?? 0)));
    }
    // Straight into the fresh project — the natural next step is adding keywords or running.
    void load();
    if (!imp || imp.added === 0) router.push(`/serp-monitor/${p.id}`);
  };

  return (
    <div className="main-content" style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 20, paddingBottom: 40 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1 style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 22, margin: 0, color: "var(--color-text-primary)" }}>
            <Waves size={20} /> {tr("serpmonTitle")}
          </h1>
          <p style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 6, maxWidth: 820 }}>
            {tr("serpmonSubtitle")}{" "}
            <span style={{ color: "var(--color-text-tertiary)" }}>· {tr("serpmonCostNote")}</span>
          </p>
        </div>
        <button onClick={() => setDialogOpen(true)} style={btnPrimary}>
          <Plus size={14} /> {tr("serpmonNewProject")}
        </button>
      </div>

      {notMigrated && (
        <div className="panel" style={{ color: "var(--color-accent-orange)", fontSize: 13 }}>
          <AlertTriangle size={15} style={{ verticalAlign: -2, marginRight: 6 }} />{tr("serpmonNotMigrated")}
        </div>
      )}

      {aparser === false && (
        <div className="panel" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <AlertTriangle size={15} color="var(--color-accent-orange)" />
          <span style={{ color: "var(--color-text-secondary)" }}>{tr("serpmonNoAparser")}</span>
          <Link href="/settings?tab=api-keys" style={{ color: "var(--color-accent-blue)", textDecoration: "none" }}>
            {tr("serpmonOpenSettings")} →
          </Link>
        </div>
      )}

      {error && <ErrorLine>{error}</ErrorLine>}
      {savedNote && (
        <div className="panel" style={{ fontSize: 12.5, color: "var(--color-success)" }}>{savedNote}</div>
      )}

      {projects === null ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-text-secondary)" }}>
          <Loader2 size={14} className="spin" /> …
        </div>
      ) : projects.length === 0 && !notMigrated ? (
        <div className="panel" style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{tr("serpmonEmpty")}</div>
      ) : (
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gap: 12,
        }}>
          {projects.map(p => (
            <div key={p.id} onClick={() => router.push(`/serp-monitor/${p.id}`)} className="panel"
              style={{
                padding: 14, cursor: "pointer", display: "flex", flexDirection: "column", gap: 8,
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--color-accent-blue)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--color-border)"; }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <b style={{ fontSize: 13.5, color: "var(--color-text-primary)", overflowWrap: "anywhere" }}>{p.name}</b>
                {p.paused && (
                  <span title={tr("serpmonPaused")} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: "var(--color-accent-orange)" }}>
                    <PauseCircle size={12} /> {tr("serpmonPaused")}
                  </span>
                )}
                {p.lastRun?.storm && (
                  <span style={{
                    fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 6,
                    background: "rgba(255,69,58,0.12)", color: "var(--color-danger)",
                  }}>
                    {tr("serpmonStormBadge")}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                {p.engine} · {p.device} · {countryLabel(p.country)} · {p.lang} · {tr("serpmonFieldDepth")} {p.depth}
              </div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                {p.keywords.toLocaleString()} {tr("serpmonColKeyword").toLowerCase()}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--color-text-tertiary)", display: "flex", flexDirection: "column", gap: 2 }}>
                <span title={p.lastRunAt ? new Date(p.lastRunAt).toLocaleString() : undefined}
                  style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <History size={11} /> {tr("serpmonLastRun")}: {p.lastRunAt ? `${relTime(p.lastRunAt)} (${fmtDate(p.lastRunAt)})` : tr("serpmonNever")}
                </span>
                <span title={p.nextRunAt ? new Date(p.nextRunAt).toLocaleString() : undefined}
                  style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <CalendarClock size={11} /> {tr("serpmonNextRun")}: {p.nextRunAt ? `${relTime(p.nextRunAt)} (${fmtDate(p.nextRunAt)})` : "—"}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                <VolSparkline series={p.volatilitySeries} />
                <span style={{ fontSize: 10.5, color: "var(--color-text-tertiary)" }}>{tr("serpmonColVolatility")}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {dialogOpen && (
        <ProjectDialog project={null} onClose={() => setDialogOpen(false)} onSaved={onSaved} />
      )}
    </div>
  );
}
