"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Code2, ExternalLink, FileCode2, Loader2, Play, ShieldAlert, XCircle } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

type Repository = { id: string; name: string; owner: string; repo: string; baseBranch: string };
type Finding = {
  ruleId: string; severity: "error" | "warning" | "info"; category: string;
  path: string | null; line: number | null; evidence: string; confidence: "high" | "medium";
};
type Run = {
  id: string; repositoryId: string; ref: string; commitSha: string | null; framework: string;
  status: string; stage: string; progress: number; filesScanned: number; totalFiles: number;
  truncated: boolean; score: number | null; summary: any; findings: Finding[]; error: string | null;
  startedAt: string; finishedAt: string | null; repository: Repository | null;
};

const RULE_KEYS: Record<string, [string, string]> = {
  "source.next.metadata_missing": ["sourceAuditRuleMetadata", "sourceAuditFixMetadata"],
  "source.next.sitemap_missing": ["sourceAuditRuleSitemap", "sourceAuditFixSitemap"],
  "source.next.robots_missing": ["sourceAuditRuleRobots", "sourceAuditFixRobots"],
  "source.next.raw_img": ["sourceAuditRuleRawImg", "sourceAuditFixRawImg"],
  "source.next.image_alt_missing": ["sourceAuditRuleAlt", "sourceAuditFixAlt"],
  "source.next.external_font": ["sourceAuditRuleFont", "sourceAuditFixFont"],
  "source.security.public_secret_name": ["sourceAuditRulePublicSecret", "sourceAuditFixPublicSecret"],
  "source.next.server_env_in_client": ["sourceAuditRuleClientEnv", "sourceAuditFixClientEnv"],
  "source.next.jsonld_not_escaped": ["sourceAuditRuleJsonLd", "sourceAuditFixJsonLd"],
  "source.security.unsafe_html_review": ["sourceAuditRuleUnsafeHtml", "sourceAuditFixUnsafeHtml"],
  "source.security.user_url_raw_fetch": ["sourceAuditRuleRawFetch", "sourceAuditFixRawFetch"],
  "source.next.remote_image_wildcard": ["sourceAuditRuleRemoteImage", "sourceAuditFixRemoteImage"],
  "source.next.page_route_conflict": ["sourceAuditRuleRouteConflict", "sourceAuditFixRouteConflict"],
  "source.architecture.large_client_component": ["sourceAuditRuleLargeClient", "sourceAuditFixLargeClient"],
};
const STAGE_KEYS: Record<string, string> = {
  tree: "sourceAuditStageTree", fetch: "sourceAuditStageFetch", analyze: "sourceAuditStageAnalyze",
  completed: "sourceAuditStatusCompleted", error: "sourceAuditStatusError", interrupted: "sourceAuditStatusInterrupted",
};

function errorText(value: any): string { return String(value?.message || value?.error || "request_failed"); }

export default function SourceAuditPanel({ repositories }: { repositories: Repository[] }) {
  const { t } = useLanguage();
  const [repositoryId, setRepositoryId] = useState(repositories[0]?.id || "");
  const [ref, setRef] = useState(repositories[0]?.baseBranch || "main");
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [severity, setSeverity] = useState("all");

  const selectedRepo = repositories.find(item => item.id === repositoryId) ?? null;
  const load = useCallback(async () => {
    if (!repositoryId) { setRuns([]); return; }
    setLoading(true);
    // A refresh that succeeds must not leave the previous failure on screen.
    setError("");
    try {
      const response = await fetch(`/api/content-ops/source-audits?repositoryId=${encodeURIComponent(repositoryId)}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(errorText(body));
      if (body.notMigrated) { setError("source_audit_not_migrated"); setRuns([]); return; }
      const next = Array.isArray(body.runs) ? body.runs : [];
      setRuns(next);
      setSelectedId(current => next.some((run: Run) => run.id === current) ? current : next[0]?.id || "");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "request_failed"); }
    finally { setLoading(false); }
  }, [repositoryId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!runs.some(run => run.status === "running")) return;
    const timer = window.setTimeout(() => void load(), 1800);
    return () => window.clearTimeout(timer);
  }, [runs, load]);

  async function start() {
    if (!repositoryId || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/content-ops/source-audits", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId, ref }),
      });
      const body = await response.json();
      if (!response.ok && response.status !== 409) throw new Error(errorText(body));
      if (body.run) {
        setRuns(current => [body.run, ...current.filter(item => item.id !== body.run.id)]);
        setSelectedId(body.run.id);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "request_failed"); }
    finally { setBusy(false); }
  }

  const selected = runs.find(run => run.id === selectedId) ?? null;
  const findings = useMemo(() => (selected?.findings ?? []).filter(item => severity === "all" || item.severity === severity), [selected, severity]);
  const fileUrl = (finding: Finding) => {
    if (!selected?.repository || !finding.path) return null;
    const revision = selected.commitSha || selected.ref;
    const path = finding.path.split("/").map(encodeURIComponent).join("/");
    return `https://github.com/${encodeURIComponent(selected.repository.owner)}/${encodeURIComponent(selected.repository.repo)}/blob/${encodeURIComponent(revision)}/${path}${finding.line ? `#L${finding.line}` : ""}`;
  };

  if (!repositories.length) return <div className="panel" style={{ padding: 28, textAlign: "center", color: "var(--color-text-secondary)" }}>
    <Code2 size={26} style={{ marginBottom: 8 }} /><div style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>{t("sourceAuditNoRepositories" as any)}</div>
    <p style={{ margin: "6px auto 0", maxWidth: 560, fontSize: 12, lineHeight: 1.55 }}>{t("sourceAuditNoRepositoriesHint" as any)}</p>
  </div>;

  return <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    <div className="panel" style={{ padding: "14px 16px" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{t("sourceAuditTitle" as any)}</h3>
      <p style={{ ...hintStyle, marginTop: 5 }}>{t("sourceAuditSubtitle" as any)}</p>
      <div style={{ marginTop: 9, padding: "8px 10px", borderRadius: 8, background: "rgba(100,210,255,.07)", color: "var(--color-text-secondary)", fontSize: 11, lineHeight: 1.5 }}>{t("sourceAuditBoundary" as any)}</div>
    </div>
    <div className="panel" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
      <label style={labelStyle}><span>{t("sourceAuditRepository" as any)}</span><select className="tool-input" value={repositoryId} onChange={event => {
        const id = event.target.value; const repo = repositories.find(item => item.id === id); setRepositoryId(id); setRef(repo?.baseBranch || "main"); setSelectedId("");
      }}>{repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name} · {repo.owner}/{repo.repo}</option>)}</select></label>
      <label style={labelStyle}><span>{t("sourceAuditRef" as any)}</span><input className="tool-input" value={ref} onChange={event => setRef(event.target.value)} placeholder={selectedRepo?.baseBranch || "main"} /></label>
      <button onClick={start} disabled={busy || runs.some(run => run.status === "running")} style={primaryButton}>
        {busy || runs.some(run => run.status === "running") ? <Loader2 className="spin" size={14} /> : <Play size={14} />} {t("sourceAuditRun" as any)}
      </button>
      <span style={{ flex: 1, minWidth: 220, fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("sourceAuditReadOnly" as any)}</span>
    </div>
    {error && <div style={{ padding: "10px 12px", borderRadius: 9, border: "1px solid rgba(255,69,58,.35)", color: "#ff6b62", fontSize: 12 }}>{t("sourceAuditError" as any)}: {error}</div>}

    <div className="source-audit-grid">
      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "13px 15px", borderBottom: "1px solid var(--color-border)", fontWeight: 700, fontSize: 13 }}>{t("sourceAuditHistory" as any)} · {runs.length}</div>
        {loading && !runs.length && <div style={{ padding: 30, textAlign: "center" }}><Loader2 className="spin" size={19} /></div>}
        {!loading && !runs.length && <div style={{ padding: 28, textAlign: "center", fontSize: 12, color: "var(--color-text-secondary)" }}>{t("sourceAuditNoRuns" as any)}</div>}
        {runs.map(run => <button key={run.id} onClick={() => setSelectedId(run.id)} style={{ width: "100%", border: 0, borderBottom: "1px solid var(--color-border)", background: run.id === selectedId ? "rgba(41,151,255,.07)" : "transparent", color: "var(--color-text-primary)", padding: "12px 14px", cursor: "pointer", textAlign: "left" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}><RunIcon status={run.status} /><b style={{ flex: 1, fontSize: 12 }}>{run.ref}</b>{run.score != null && <span style={{ color: scoreColor(run.score), fontWeight: 800 }}>{run.score}</span>}</div>
          <small style={{ display: "block", marginTop: 5, color: "var(--color-text-tertiary)" }}>{t((STAGE_KEYS[run.stage] || "sourceAuditRunning") as any)} · {new Date(run.startedAt).toLocaleString()}</small>
          {run.status === "running" && <div style={{ height: 3, borderRadius: 3, background: "var(--color-border)", marginTop: 7, overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${run.progress}%`, background: "var(--color-accent-blue)" }} /></div>}
        </button>)}
      </div>

      <div className="panel" style={{ minWidth: 0 }}>
        {!selected ? <div style={{ padding: 30, textAlign: "center", color: "var(--color-text-secondary)" }}>{t("sourceAuditSelect" as any)}</div> : selected.status === "running" ? <div style={{ padding: 34, textAlign: "center" }}>
          <Loader2 className="spin" size={24} color="var(--color-accent-blue)" /><h3 style={{ margin: "10px 0 5px" }}>{t("sourceAuditRunning" as any)}</h3><p style={hintStyle}>{t((STAGE_KEYS[selected.stage] || "sourceAuditStageTree") as any)} · {selected.filesScanned}/{selected.totalFiles || "?"}</p>
        </div> : selected.status !== "completed" ? <div style={{ padding: 28, textAlign: "center", color: "#ff6b62" }}><XCircle size={24} /><p>{t((STAGE_KEYS[selected.status] || "sourceAuditStatusError") as any)}{selected.error ? ` · ${selected.error}` : ""}</p></div> : <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <div style={{ width: 66, height: 66, borderRadius: "50%", display: "grid", placeItems: "center", border: `4px solid ${scoreColor(selected.score ?? 0)}`, color: scoreColor(selected.score ?? 0), fontSize: 20, fontWeight: 850 }}>{selected.score ?? 0}</div>
            <div style={{ flex: 1 }}><h3 style={{ margin: 0, fontSize: 16 }}>{t("sourceAuditResult" as any)}</h3><p style={{ ...hintStyle, margin: "4px 0 0" }}>{selected.framework} · {selected.filesScanned}/{selected.totalFiles} {t("sourceAuditFiles" as any)} · {selected.commitSha?.slice(0, 8)}</p></div>
            <select className="tool-input" value={severity} onChange={event => setSeverity(event.target.value)} style={{ width: "auto" }}><option value="all">{t("sourceAuditAllSeverities" as any)}</option><option value="error">{t("sourceAuditSeverityError" as any)}</option><option value="warning">{t("sourceAuditSeverityWarning" as any)}</option><option value="info">{t("sourceAuditSeverityInfo" as any)}</option></select>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <Metric value={selected.summary?.errors ?? 0} label={t("sourceAuditSeverityError" as any)} color="#ff453a" />
            <Metric value={selected.summary?.warnings ?? 0} label={t("sourceAuditSeverityWarning" as any)} color="#ff9f0a" />
            <Metric value={selected.summary?.info ?? 0} label={t("sourceAuditSeverityInfo" as any)} color="#64d2ff" />
          </div>
          {selected.truncated && <div style={{ padding: "9px 11px", marginBottom: 12, borderRadius: 8, background: "rgba(255,159,10,.08)", color: "#ffb340", fontSize: 11 }}><AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />{t("sourceAuditTruncated" as any)}</div>}
          {!findings.length ? <div style={{ padding: 30, textAlign: "center", color: "#34c759" }}><CheckCircle2 size={27} /><p>{t("sourceAuditNoFindings" as any)}</p></div> : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {findings.map((item, index) => {
              const keys = RULE_KEYS[item.ruleId] || ["sourceAuditUnknownRule", "sourceAuditManualReview"];
              const url = fileUrl(item);
              const color = item.severity === "error" ? "#ff453a" : item.severity === "warning" ? "#ff9f0a" : "#64d2ff";
              return <div key={`${item.ruleId}-${item.path}-${item.line}-${index}`} style={{ padding: "11px 12px", borderRadius: 9, border: `1px solid ${color}35`, background: `${color}08` }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}><ShieldAlert size={15} color={color} style={{ marginTop: 1, flexShrink: 0 }} /><span style={{ flex: 1, minWidth: 0 }}><b style={{ display: "block", fontSize: 12 }}>{t(keys[0] as any)}</b><small style={{ display: "block", color: "var(--color-text-secondary)", marginTop: 3 }}>{item.evidence}</small></span><span style={{ color, fontSize: 9, fontWeight: 800, textTransform: "uppercase" }}>{t(`sourceAuditSeverity${item.severity[0].toUpperCase()}${item.severity.slice(1)}` as any)}</span></div>
                <div style={{ marginTop: 7, paddingTop: 7, borderTop: "1px solid var(--color-border)", fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.45 }}>{t(keys[1] as any)}</div>
                {(item.path || url) && <div style={{ marginTop: 6, fontSize: 10, color: "var(--color-text-tertiary)", overflowWrap: "anywhere" }}><FileCode2 size={11} style={{ verticalAlign: -2, marginRight: 4 }} />{item.path}{item.line ? `:${item.line}` : ""}{url && <a href={url} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 7, color: "var(--color-accent-blue)" }}>{t("sourceAuditOpenFile" as any)} <ExternalLink size={10} /></a>}</div>}
              </div>;
            })}
          </div>}
        </>}
      </div>
    </div>

  </div>;
}

function RunIcon({ status }: { status: string }) {
  if (status === "running") return <Loader2 className="spin" size={14} color="#2997ff" />;
  if (status === "completed") return <CheckCircle2 size={14} color="#34c759" />;
  return <XCircle size={14} color="#ff453a" />;
}
function scoreColor(score: number) { return score >= 85 ? "#34c759" : score >= 65 ? "#ff9f0a" : "#ff453a"; }
function Metric({ value, label, color }: { value: number; label: string; color: string }) { return <span style={{ padding: "5px 9px", borderRadius: 8, color, background: `${color}14`, fontSize: 11, fontWeight: 750 }}>{value} {label}</span>; }
const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5, minWidth: 210, flex: "1 1 220px", fontSize: 11, fontWeight: 650, color: "var(--color-text-secondary)" };
const hintStyle: React.CSSProperties = { fontSize: 12, lineHeight: 1.5, color: "var(--color-text-secondary)", margin: 0 };
const primaryButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "8px 13px", borderRadius: 8, border: 0, background: "var(--color-accent-blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" };
