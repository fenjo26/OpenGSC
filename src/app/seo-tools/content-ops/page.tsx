"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Check, CheckCircle2, ChevronRight, Circle, ExternalLink, FileDiff,
  FileText, GitBranch, GitPullRequest, History, Loader2, Plus, RefreshCw, Save, Settings2,
  ShieldCheck, Trash2, XCircle, Code2,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import SourceAuditPanel from "@/components/SourceAuditPanel";

type Repo = { id: string; name: string; owner: string; repo: string; baseBranch: string; contentRoot: string };
type Gate = { id: string; severity: "pass" | "warning" | "error"; message: string; detail?: string };
type Preflight = { checkedAt: string; words: number; blockers: number; warnings: number; uniquenessPercent: number | null; factDrift: string | null; gates: Gate[] };
type Event = { id: string; fromStatus: string | null; toStatus: string; note: string; createdAt: string };
type OutcomeWindow = { clicks: number; impressions: number; position: number | null };
type Checkpoint = OutcomeWindow & { day: number; capturedAt: string; from: string; to: string; rank: number | null };
type Outcome = { baseline: (OutcomeWindow & { from: string; to: string }) | null; checkpoints: Checkpoint[] };
type Operation = {
  id: string; title: string; keyword: string; operationType: "new" | "update"; sourceType: string; sourceRef: string | null;
  targetUrl: string | null; filePath: string | null; content: string; status: string; gates: Preflight | null;
  prNumber: number | null; prUrl: string | null; branchName: string | null; error: string | null;
  siteId?: string | null; trackedKeywordId?: string | null; indexingLinkedAt?: string | null;
  measurementStartedAt?: string | null; lastMeasuredAt?: string | null; outcome?: Outcome | null;
  liveAt?: string | null; createdAt: string; updatedAt: string; repository: Repo | null; events: Event[];
};
type HistoryItem = { id: string; type: string; keyword: string; createdAt: string; words: number };
type Preview = { file: { exists: boolean; path: string; content: string }; diff: { beforeLines: number; afterLines: number; removed: string[]; added: string[]; truncated: boolean }; preflight: Preflight };

const STATUS_KEYS: Record<string, string> = {
  idea: "contentOpsStatusIdea", approved: "contentOpsStatusApproved", review: "contentOpsStatusReview",
  pr_open: "contentOpsStatusPrOpen", pr_merged: "contentOpsStatusPrMerged", live: "contentOpsStatusLive",
  measuring: "contentOpsStatusMeasuring", completed: "contentOpsStatusCompleted", failed: "contentOpsStatusFailed",
};
const STATUS_COLORS: Record<string, string> = {
  idea: "#8e8e93", approved: "#2997ff", review: "#ff9f0a", pr_open: "#bf5af2",
  pr_merged: "#5e5ce6", live: "#34c759", measuring: "#64d2ff", completed: "#30d158", failed: "#ff453a",
};
const GATE_KEYS: Record<string, string> = {
  "content:pass": "contentOpsGateLengthOk", "content:error": "contentOpsGateTooShort",
  "heading:pass": "contentOpsGateOneH1", "heading:warning": "contentOpsGateNoH1", "heading:error": "contentOpsGateManyH1",
  "title:pass": "contentOpsGateTitleOk", "title:warning": "contentOpsGateTitleMissing",
  "description:pass": "contentOpsGateDescriptionOk", "description:warning": "contentOpsGateDescriptionMissing",
  "placeholders:pass": "contentOpsGatePlaceholdersOk", "placeholders:error": "contentOpsGatePlaceholderFound",
  "links:pass": "contentOpsGateLinksOk", "links:error": "contentOpsGateUnsafeLink",
  "fact_drift:pass": "contentOpsGateFactsOk", "fact_drift:warning": "contentOpsGateFactsDropped", "fact_drift:error": "contentOpsGateFactsAdded",
};
const EVENT_KEYS: Record<string, string> = {
  "system:created": "contentOpsEventCreated",
  "system:ready_review": "contentOpsEventReadyReview",
  "system:pr_created": "contentOpsEventPrCreated",
  "system:pr_merged": "contentOpsEventPrMerged",
};

function apiError(value: unknown) {
  const d = value as any;
  return String(d?.message || d?.error || "request_failed");
}

export default function ContentOperationsPage() {
  const { t } = useLanguage();
  const [operations, setOperations] = useState<Operation[]>([]);
  const [repositories, setRepositories] = useState<Repo[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [tab, setTab] = useState<"queue" | "repositories" | "source-audit">("queue");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notMigrated, setNotMigrated] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmPr, setConfirmPr] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/content-ops", { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) throw new Error(apiError(d));
      setOperations(Array.isArray(d.operations) ? d.operations : []);
      setRepositories(Array.isArray(d.repositories) ? d.repositories : []);
      setHistory(Array.isArray(d.history) ? d.history : []);
      setNotMigrated(!!d.notMigrated);
      setSelectedId(id => id || d.operations?.[0]?.id || "");
    } catch (e) { setError(e instanceof Error ? e.message : "request_failed"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => operations.find(o => o.id === selectedId) ?? null, [operations, selectedId]);
  function replaceOperation(operation: Operation) {
    setOperations(list => [operation, ...list.filter(x => x.id !== operation.id)]);
    setSelectedId(operation.id);
  }

  async function patchOperation(patch: Record<string, unknown>, action = "save") {
    if (!selected) return;
    setBusy(action); setError("");
    try {
      const res = await fetch(`/api/content-ops/${encodeURIComponent(selected.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const d = await res.json();
      if (!res.ok) throw new Error(apiError(d));
      replaceOperation(d.operation); setPreview(null); setConfirmPr(false);
    } catch (e) { setError(e instanceof Error ? e.message : "request_failed"); }
    finally { setBusy(""); }
  }

  async function removeOperation() {
    if (!selected || !window.confirm(t("contentOpsDeleteConfirm" as any))) return;
    setBusy("delete"); setError("");
    try {
      const res = await fetch(`/api/content-ops/${encodeURIComponent(selected.id)}`, { method: "DELETE" });
      const d = await res.json(); if (!res.ok) throw new Error(apiError(d));
      const next = operations.filter(o => o.id !== selected.id); setOperations(next); setSelectedId(next[0]?.id || "");
    } catch (e) { setError(e instanceof Error ? e.message : "request_failed"); }
    finally { setBusy(""); }
  }

  async function runPreview() {
    if (!selected) return;
    setBusy("preview"); setError(""); setConfirmPr(false);
    try {
      const res = await fetch(`/api/content-ops/${encodeURIComponent(selected.id)}/preview`, { method: "POST" });
      const d = await res.json(); if (!res.ok) throw new Error(apiError(d));
      setPreview(d);
      setOperations(list => list.map(o => o.id === selected.id ? { ...o, gates: d.preflight } : o));
    } catch (e) { setError(e instanceof Error ? e.message : "request_failed"); }
    finally { setBusy(""); }
  }

  async function createPr() {
    if (!selected || !confirmPr || preview?.preflight.blockers) return;
    setBusy("pr"); setError("");
    try {
      const res = await fetch(`/api/content-ops/${encodeURIComponent(selected.id)}/pull-request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      const d = await res.json(); if (!res.ok) throw new Error(apiError(d));
      replaceOperation(d.operation); setPreview(null); setConfirmPr(false);
    } catch (e) { setError(e instanceof Error ? e.message : "request_failed"); }
    finally { setBusy(""); }
  }

  async function verifyLive(options: { trackKeyword?: boolean } = {}) {
    if (!selected) return;
    setBusy(options.trackKeyword ? "track" : "live"); setError("");
    try {
      const res = await fetch(`/api/content-ops/${encodeURIComponent(selected.id)}/outcome`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(options),
      });
      const d = await res.json();
      // 409 with a check payload is the normal "the deploy has not landed yet" answer, not a bug.
      if (!res.ok) throw new Error(d?.check?.error ? `${apiError(d)}: ${d.check.error}` : apiError(d));
      replaceOperation(d.operation);
    } catch (e) { setError(e instanceof Error ? e.message : "request_failed"); }
    finally { setBusy(""); }
  }

  async function refreshPr() {
    if (!selected) return;
    setBusy("refresh"); setError("");
    try {
      const res = await fetch(`/api/content-ops/${encodeURIComponent(selected.id)}/refresh`, { method: "POST" });
      const d = await res.json(); if (!res.ok) throw new Error(apiError(d));
      replaceOperation(d.operation);
    } catch (e) { setError(e instanceof Error ? e.message : "request_failed"); }
    finally { setBusy(""); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
        <div>
          <h2 style={titleStyle}>{t("contentOpsTitle" as any)}</h2>
          <p style={subStyle}>{t("contentOpsSubtitle" as any)}</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={tabButton(tab === "queue")} onClick={() => setTab("queue")}><FileText size={14} /> {t("contentOpsQueue" as any)}</button>
          <button style={tabButton(tab === "repositories")} onClick={() => setTab("repositories")}><GitPullRequest size={14} /> {t("contentOpsRepositories" as any)}</button>
          <button style={tabButton(tab === "source-audit")} onClick={() => setTab("source-audit")}><Code2 size={14} /> {t("sourceAuditTitle" as any)}</button>
        </div>
      </div>

      <div style={{ padding: "12px 14px", borderRadius: 10, border: "1px solid rgba(41,151,255,.25)", background: "rgba(41,151,255,.07)", color: "var(--color-text-secondary)", fontSize: 12, lineHeight: 1.55, display: "flex", gap: 9 }}>
        <ShieldCheck size={17} color="var(--color-accent-blue)" style={{ flexShrink: 0 }} />
        <span>{t("contentOpsBoundary" as any)}</span>
      </div>
      {notMigrated && <Notice tone="warning">{t("contentOpsNeedsMigration" as any)} <code>npx prisma db push</code></Notice>}
      {error && <Notice tone="error">{t("contentOpsError" as any)}: {error}</Notice>}

      {tab === "repositories" ? (
        <RepositoryPanel repositories={repositories} setRepositories={setRepositories} t={t as any} />
      ) : tab === "source-audit" ? (
        <SourceAuditPanel repositories={repositories} />
      ) : loading ? (
        <div className="panel" style={{ padding: 42, textAlign: "center" }}><Loader2 className="spin" size={22} /></div>
      ) : (
        <div className="content-ops-grid">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <CreateIdea history={history} onCreated={replaceOperation} t={t as any} />
            <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "13px 15px", borderBottom: "1px solid var(--color-border)", fontSize: 13, fontWeight: 700 }}>{t("contentOpsQueue" as any)} · {operations.length}</div>
              {!operations.length && <div style={{ padding: 26, textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>{t("contentOpsEmpty" as any)}</div>}
              {operations.map(op => <OperationRow key={op.id} operation={op} active={op.id === selectedId} onClick={() => { setSelectedId(op.id); setPreview(null); setConfirmPr(false); }} t={t as any} />)}
            </div>
          </div>

          {selected ? (
            <OperationDetail
              operation={selected} repositories={repositories} busy={busy} preview={preview} confirmPr={confirmPr}
              setConfirmPr={setConfirmPr} onSave={patchOperation} onDelete={removeOperation} onPreview={runPreview}
              onCreatePr={createPr} onRefreshPr={refreshPr} onVerifyLive={verifyLive} t={t as any}
            />
          ) : <div className="panel" style={{ padding: 36, color: "var(--color-text-secondary)", textAlign: "center" }}>{t("contentOpsSelect" as any)}</div>}
        </div>
      )}

    </div>
  );
}

function CreateIdea({ history, onCreated, t }: { history: HistoryItem[]; onCreated: (o: Operation) => void; t: (k: string) => string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [keyword, setKeyword] = useState("");
  const [operationType, setOperationType] = useState<"new" | "update">("new");
  const [historyId, setHistoryId] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (!title.trim()) return;
    setBusy(true); setError("");
    try {
      const body = { title, keyword, operationType, sourceType: historyId ? "history" : "manual", sourceRef: historyId || undefined, content: historyId ? undefined : content };
      const res = await fetch("/api/content-ops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json(); if (!res.ok) throw new Error(apiError(d));
      onCreated(d.operation); setTitle(""); setKeyword(""); setContent(""); setHistoryId(""); setOpen(false);
    } catch (e) { setError(e instanceof Error ? e.message : "request_failed"); }
    finally { setBusy(false); }
  }
  return <div className="panel">
    {!open ? <button style={primaryButton} onClick={() => setOpen(true)}><Plus size={15} /> {t("contentOpsNew")}</button> : <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><b style={{ fontSize: 14 }}>{t("contentOpsNew")}</b><button style={iconButton} onClick={() => setOpen(false)}><XCircle size={15} /></button></div>
      <input className="tool-input" value={title} onChange={e => setTitle(e.target.value)} placeholder={t("contentOpsTitlePlaceholder")} maxLength={240} />
      <input className="tool-input" value={keyword} onChange={e => setKeyword(e.target.value)} placeholder={t("contentOpsKeywordPlaceholder")} maxLength={240} />
      <select className="tool-input" value={operationType} onChange={e => setOperationType(e.target.value as "new" | "update")}><option value="new">{t("contentOpsNewPage")}</option><option value="update">{t("contentOpsUpdatePage")}</option></select>
      <select className="tool-input" value={historyId} onChange={e => setHistoryId(e.target.value)}>
        <option value="">{t("contentOpsManualDraft")}</option>
        {history.map(h => <option key={h.id} value={h.id}>{h.keyword} · {h.type} · {h.words} {t("contentOpsWords")}</option>)}
      </select>
      {!historyId && <textarea className="tool-input" rows={5} value={content} onChange={e => setContent(e.target.value)} placeholder={t("contentOpsDraftOptional")} />}
      {error && <span style={{ color: "var(--color-accent-red)", fontSize: 12 }}>{error}</span>}
      <button style={primaryButton} disabled={busy || !title.trim()} onClick={submit}>{busy ? <Loader2 className="spin" size={14} /> : <Plus size={14} />} {t("contentOpsCreateIdea")}</button>
    </div>}
  </div>;
}

function OperationRow({ operation, active, onClick, t }: { operation: Operation; active: boolean; onClick: () => void; t: (k: string) => string }) {
  const color = STATUS_COLORS[operation.status] || "#8e8e93";
  return <button onClick={onClick} style={{ width: "100%", textAlign: "left", padding: "13px 15px", border: 0, borderBottom: "1px solid var(--color-border)", background: active ? "rgba(41,151,255,.07)" : "transparent", cursor: "pointer", display: "flex", gap: 10, alignItems: "center" }}>
    <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
    <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: "block", fontSize: 13, fontWeight: 650, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{operation.title}</span><span style={{ display: "block", marginTop: 3, fontSize: 11, color }}>{t(STATUS_KEYS[operation.status] || "contentOpsStatusIdea")}</span></span>
    <ChevronRight size={14} color="var(--color-text-tertiary)" />
  </button>;
}

function OperationDetail(props: {
  operation: Operation; repositories: Repo[]; busy: string; preview: Preview | null; confirmPr: boolean;
  setConfirmPr: (v: boolean) => void; onSave: (p: Record<string, unknown>, a?: string) => Promise<void>; onDelete: () => void;
  onPreview: () => void; onCreatePr: () => void; onRefreshPr: () => void; onVerifyLive: (options?: { trackKeyword?: boolean }) => void; t: (k: string) => string;
}) {
  const { operation, repositories, busy, preview, confirmPr, setConfirmPr, onSave, onDelete, onPreview, onCreatePr, onRefreshPr, onVerifyLive, t } = props;
  const [draft, setDraft] = useState({ title: operation.title, keyword: operation.keyword, targetUrl: operation.targetUrl || "", filePath: operation.filePath || "", content: operation.content, repositoryId: operation.repository?.id || "" });
  useEffect(() => setDraft({ title: operation.title, keyword: operation.keyword, targetUrl: operation.targetUrl || "", filePath: operation.filePath || "", content: operation.content, repositoryId: operation.repository?.id || "" }), [operation]);
  const locked = ["pr_open", "pr_merged", "live", "measuring", "completed"].includes(operation.status);
  const changed = draft.title !== operation.title || draft.keyword !== operation.keyword || draft.targetUrl !== (operation.targetUrl || "") || draft.filePath !== (operation.filePath || "") || draft.content !== operation.content || draft.repositoryId !== (operation.repository?.id || "");
  const gate = preview?.preflight || operation.gates;
  const save = () => onSave(draft, "save");
  return <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div><StatusBadge status={operation.status} t={t} /><span style={{ marginLeft: 8, fontSize: 11, color: "var(--color-text-tertiary)" }}>{operation.operationType === "update" ? t("contentOpsUpdatePage") : t("contentOpsNewPage")}</span></div>
        {!locked && <button style={{ ...iconButton, color: "var(--color-accent-red)" }} onClick={onDelete} title={t("contentOpsDelete")}><Trash2 size={15} /></button>}
      </div>
      <label style={labelStyle}>{t("contentOpsItemTitle")}<input className="tool-input" disabled={locked} value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} /></label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10 }}>
        <label style={labelStyle}>{t("contentOpsKeyword")}<input className="tool-input" disabled={locked} value={draft.keyword} onChange={e => setDraft(d => ({ ...d, keyword: e.target.value }))} /></label>
        <label style={labelStyle}>{t("contentOpsTargetUrl")}<input className="tool-input" disabled={locked} value={draft.targetUrl} onChange={e => setDraft(d => ({ ...d, targetUrl: e.target.value }))} placeholder="https://…" /></label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10 }}>
        <label style={labelStyle}>{t("contentOpsRepository")}<select className="tool-input" disabled={locked} value={draft.repositoryId} onChange={e => setDraft(d => ({ ...d, repositoryId: e.target.value }))}><option value="">{t("contentOpsChooseRepository")}</option>{repositories.map(r => <option key={r.id} value={r.id}>{r.name} · {r.owner}/{r.repo}</option>)}</select></label>
        <label style={labelStyle}>{t("contentOpsFilePath")}<input className="tool-input" disabled={locked} value={draft.filePath} onChange={e => setDraft(d => ({ ...d, filePath: e.target.value }))} placeholder="blog/article.md" /></label>
      </div>
      <label style={labelStyle}>{t("contentOpsDraft")}<textarea className="tool-input" disabled={locked} value={draft.content} onChange={e => setDraft(d => ({ ...d, content: e.target.value }))} rows={16} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: 1.55, resize: "vertical" }} /></label>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{t("contentOpsNoAiCost")}</span>
        {!locked && <button style={primaryButton} disabled={!changed || !!busy} onClick={save}>{busy === "save" ? <Loader2 className="spin" size={14} /> : <Save size={14} />} {t("contentOpsSave")}</button>}
      </div>
    </div>

    {!locked && <div className="panel">
      <h3 style={sectionTitle}><CheckCircle2 size={16} color="var(--color-accent-green)" /> {t("contentOpsApproval")}</h3>
      <p style={hintStyle}>{t("contentOpsApprovalHint")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {operation.status === "idea" && <button style={primaryButton} disabled={!!busy || changed} onClick={() => onSave({ status: "approved" }, "approve")}><Check size={14} /> {t("contentOpsApprove")}</button>}
        {operation.status === "approved" && <button style={primaryButton} disabled={!!busy || changed || !draft.content.trim()} onClick={() => onSave({ status: "review" }, "review")}><FileDiff size={14} /> {t("contentOpsToReview")}</button>}
        {operation.status === "review" && <button style={ghostButton} disabled={!!busy} onClick={() => onSave({ status: "approved" }, "back")}><RefreshCw size={14} /> {t("contentOpsBackToDraft")}</button>}
      </div>
      {changed && <p style={{ ...hintStyle, color: "var(--color-accent-orange)", marginTop: 8 }}>{t("contentOpsSaveBeforeAction")}</p>}
    </div>}

    {operation.status === "review" && <div className="panel">
      <h3 style={sectionTitle}><GitPullRequest size={16} /> {t("contentOpsPrDelivery")}</h3>
      <p style={hintStyle}>{t("contentOpsPrHint")}</p>
      <button style={ghostButton} disabled={!!busy || changed} onClick={onPreview}>{busy === "preview" ? <Loader2 className="spin" size={14} /> : <FileDiff size={14} />} {t("contentOpsPreview")}</button>
      {preview && <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        <GateSummary preflight={preview.preflight} t={t} />
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}><b>{preview.file.path}</b> · {preview.file.exists ? t("contentOpsExistingFile") : t("contentOpsNewFile")} · {preview.diff.beforeLines} → {preview.diff.afterLines} {t("contentOpsLines")}</div>
        {(preview.diff.removed.length > 0 || preview.diff.added.length > 0) && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 8 }}>
          <DiffBlock title={t("contentOpsRemoved")} lines={preview.diff.removed} color="#ff453a" prefix="−" />
          <DiffBlock title={t("contentOpsAdded")} lines={preview.diff.added} color="#34c759" prefix="+" />
        </div>}
        {!preview.preflight.blockers && <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, color: "var(--color-text-secondary)", cursor: "pointer" }}><input type="checkbox" checked={confirmPr} onChange={e => setConfirmPr(e.target.checked)} /> {t("contentOpsConfirmPr")}</label>}
        <button style={primaryButton} disabled={!confirmPr || !!preview.preflight.blockers || !!busy} onClick={onCreatePr}>{busy === "pr" ? <Loader2 className="spin" size={14} /> : <GitBranch size={14} />} {t("contentOpsCreatePr")}</button>
      </div>}
    </div>}

    {gate && !preview && <div className="panel"><GateSummary preflight={gate} t={t} /></div>}

    {operation.status === "pr_open" && <div className="panel">
      <h3 style={sectionTitle}><GitBranch size={16} /> {t("contentOpsPrOpen")}</h3>
      <p style={hintStyle}>{t("contentOpsNoAutoMerge")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {operation.prUrl && <a href={operation.prUrl} target="_blank" rel="noopener noreferrer" style={{ ...primaryButton, textDecoration: "none" }}>{t("contentOpsOpenPr")} #{operation.prNumber} <ExternalLink size={13} /></a>}
        <button style={ghostButton} disabled={!!busy} onClick={onRefreshPr}>{busy === "refresh" ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />} {t("contentOpsRefreshPr")}</button>
      </div>
    </div>}

    {operation.status === "pr_merged" && <div className="panel">
      <h3 style={sectionTitle}><CheckCircle2 size={16} color="var(--color-accent-green)" /> {t("contentOpsPrMerged")}</h3>
      <p style={hintStyle}>{t("contentOpsVerifyLiveHint")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button style={primaryButton} disabled={!!busy || !operation.targetUrl} onClick={() => onVerifyLive()}>{busy === "live" ? <Loader2 className="spin" size={14} /> : <Check size={14} />} {t("contentOpsVerifyLive")}</button>
        <button style={ghostButton} disabled={!!busy} onClick={() => onSave({ status: "live" }, "live")}>{t("contentOpsMarkLive")}</button>
      </div>
      {!operation.targetUrl && <p style={{ ...hintStyle, marginTop: 8, color: "var(--color-accent-orange)" }}>{t("contentOpsOutcomeNoUrl")}</p>}
    </div>}

    {["live", "measuring", "completed"].includes(operation.status) && <div className="panel">
      <h3 style={sectionTitle}><ExternalLink size={16} /> {t("contentOpsOutcome")}</h3>
      <p style={hintStyle}>{t("contentOpsOutcomeHint")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {operation.targetUrl && <a href={operation.targetUrl} target="_blank" rel="noopener noreferrer" style={{ ...ghostButton, textDecoration: "none" }}>{t("contentOpsOpenLive")} <ExternalLink size={13} /></a>}
        {operation.status === "live" && <button style={primaryButton} disabled={!!busy} onClick={() => onVerifyLive()}>{busy === "live" ? <Loader2 className="spin" size={14} /> : null} {t("contentOpsStartMeasuring")}</button>}
        {operation.status === "measuring" && <button style={ghostButton} onClick={() => onSave({ status: "completed" }, "complete")}>{t("contentOpsComplete")}</button>}
      </div>
      <OutcomeReport operation={operation} busy={busy} onTrackKeyword={() => onVerifyLive({ trackKeyword: true })} t={t} />
    </div>}

    <div className="panel">
      <h3 style={sectionTitle}><History size={16} /> {t("contentOpsTimeline")}</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{operation.events.map(e => <div key={e.id} style={{ display: "flex", gap: 9, fontSize: 12 }}><Circle size={9} fill={STATUS_COLORS[e.toStatus] || "#8e8e93"} color="transparent" style={{ marginTop: 4, flexShrink: 0 }} /><span style={{ flex: 1 }}><b>{t(STATUS_KEYS[e.toStatus] || "contentOpsStatusIdea")}</b>{e.note ? ` — ${EVENT_KEYS[e.note] ? t(EVENT_KEYS[e.note]) : e.note}` : ""}<small style={{ display: "block", color: "var(--color-text-tertiary)", marginTop: 2 }}>{new Date(e.createdAt).toLocaleString()}</small></span></div>)}</div>
    </div>
  </div>;
}

/**
 * What the published page actually did. Windows open at the live date and close at 7, 30 and 90
 * days; a checkpoint appears only once its window has closed and Search Console has had time to
 * deliver the data, so an empty row means "not measured yet", never "zero traffic".
 */
function OutcomeReport({ operation, busy, onTrackKeyword, t }: { operation: Operation; busy: string; onTrackKeyword: () => void; t: (k: string) => string }) {
  const outcome = operation.outcome;
  if (!outcome) return null;
  const base = outcome.baseline;
  const delta = (value: number, from: number | null | undefined) => {
    if (from == null) return null;
    const diff = value - from;
    return { diff, color: diff > 0 ? "#34c759" : diff < 0 ? "#ff453a" : "var(--color-text-tertiary)" };
  };
  return <div style={{ marginTop: 14 }}>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10, fontSize: 11, color: "var(--color-text-secondary)" }}>
      <span>{t("contentOpsOutcomeSite")}: <b style={{ color: "var(--color-text-primary)" }}>{operation.siteId ? t("contentOpsOutcomeLinked") : t("contentOpsOutcomeUntracked")}</b></span>
      <span>{t("contentOpsOutcomeIndexing")}: <b style={{ color: "var(--color-text-primary)" }}>{operation.indexingLinkedAt ? t("contentOpsOutcomeLinked") : "—"}</b></span>
      <span>{t("contentOpsOutcomeRank")}: <b style={{ color: "var(--color-text-primary)" }}>{operation.trackedKeywordId ? t("contentOpsOutcomeTracked") : "—"}</b></span>
    </div>
    {!operation.siteId && <p style={{ ...hintStyle, color: "var(--color-accent-orange)" }}>{t("contentOpsOutcomeNoSite")}</p>}
    {operation.siteId && !operation.trackedKeywordId && operation.keyword.trim() && <div style={{ marginBottom: 10 }}>
      <button style={ghostButton} disabled={!!busy} onClick={onTrackKeyword}>{busy === "track" ? <Loader2 className="spin" size={14} /> : null} {t("contentOpsOutcomeTrackKeyword")}</button>
      <p style={{ ...hintStyle, marginTop: 6 }}>{t("contentOpsOutcomeTrackKeywordHint")}</p>
    </div>}
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead><tr style={{ color: "var(--color-text-tertiary)", textAlign: "left" }}>
          <th style={outcomeCell}>{t("contentOpsOutcomeWindow")}</th>
          <th style={outcomeCell}>{t("clicks")}</th>
          <th style={outcomeCell}>{t("impressions")}</th>
          <th style={outcomeCell}>{t("contentOpsOutcomePosition")}</th>
          <th style={outcomeCell}>{t("contentOpsOutcomeRank")}</th>
        </tr></thead>
        <tbody>
          {base && <tr><td style={outcomeCell}>{t("contentOpsOutcomeBaseline")}</td><td style={outcomeCell}>{base.clicks}</td><td style={outcomeCell}>{base.impressions}</td><td style={outcomeCell}>{base.position ?? "—"}</td><td style={outcomeCell}>—</td></tr>}
          {[7, 30, 90].map(day => {
            const point = outcome.checkpoints.find(item => item.day === day);
            if (!point) return <tr key={day}><td style={outcomeCell}>{day} {t("contentOpsOutcomeDays")}</td><td style={{ ...outcomeCell, color: "var(--color-text-tertiary)" }} colSpan={4}>{t("contentOpsOutcomePending")}</td></tr>;
            const clickDelta = delta(point.clicks, base?.clicks);
            return <tr key={day}>
              <td style={outcomeCell}>{day} {t("contentOpsOutcomeDays")}</td>
              <td style={outcomeCell}><b>{point.clicks}</b>{clickDelta && clickDelta.diff !== 0 && <small style={{ marginLeft: 5, color: clickDelta.color }}>{clickDelta.diff > 0 ? "+" : ""}{clickDelta.diff}</small>}</td>
              <td style={outcomeCell}>{point.impressions}</td>
              <td style={outcomeCell}>{point.position ?? "—"}</td>
              <td style={outcomeCell}>{point.rank ?? "—"}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  </div>;
}
const outcomeCell: React.CSSProperties = { padding: "7px 9px", borderBottom: "1px solid var(--color-border)", whiteSpace: "nowrap" };

function RepositoryPanel({ repositories, setRepositories, t }: { repositories: Repo[]; setRepositories: React.Dispatch<React.SetStateAction<Repo[]>>; t: (k: string) => string }) {
  const [form, setForm] = useState({ name: "", owner: "", repo: "", baseBranch: "main", contentRoot: "content", token: "" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [ok, setOk] = useState("");
  async function save() {
    setBusy(true); setError(""); setOk("");
    try {
      const res = await fetch("/api/content-ops/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const d = await res.json(); if (!res.ok) throw new Error(apiError(d));
      setRepositories(list => [d.repository, ...list.filter(r => r.id !== d.repository.id)]); setForm({ name: "", owner: "", repo: "", baseBranch: "main", contentRoot: "content", token: "" }); setOk(t("contentOpsRepoVerified"));
    } catch (e) { setError(e instanceof Error ? e.message : "request_failed"); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (!window.confirm(t("contentOpsRepoDeleteConfirm"))) return;
    const res = await fetch(`/api/content-ops/repositories/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setRepositories(list => list.filter(r => r.id !== id));
  }
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 14, alignItems: "start" }}>
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      <h3 style={sectionTitle}><Settings2 size={16} /> {t("contentOpsAddRepository")}</h3>
      <p style={hintStyle}>{t("contentOpsTokenHint")}</p>
      <input className="tool-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={t("contentOpsRepoName")} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}><input className="tool-input" value={form.owner} onChange={e => setForm(f => ({ ...f, owner: e.target.value }))} placeholder={t("contentOpsOwner")} /><input className="tool-input" value={form.repo} onChange={e => setForm(f => ({ ...f, repo: e.target.value }))} placeholder={t("contentOpsRepo")} /></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}><input className="tool-input" value={form.baseBranch} onChange={e => setForm(f => ({ ...f, baseBranch: e.target.value }))} placeholder="main" /><input className="tool-input" value={form.contentRoot} onChange={e => setForm(f => ({ ...f, contentRoot: e.target.value }))} placeholder="content" /></div>
      <input className="tool-input" type="password" autoComplete="new-password" value={form.token} onChange={e => setForm(f => ({ ...f, token: e.target.value }))} placeholder={t("contentOpsToken")} />
      {error && <span style={{ fontSize: 12, color: "var(--color-accent-red)" }}>{error}</span>}{ok && <span style={{ fontSize: 12, color: "var(--color-accent-green)" }}>{ok}</span>}
      <button style={primaryButton} disabled={busy || !form.owner || !form.repo || !form.token} onClick={save}>{busy ? <Loader2 className="spin" size={14} /> : <GitPullRequest size={14} />} {t("contentOpsVerifySave")}</button>
    </div>
    <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--color-border)", fontWeight: 700, fontSize: 14 }}>{t("contentOpsSavedRepositories")}</div>
      {!repositories.length && <div style={{ padding: 26, textAlign: "center", fontSize: 13, color: "var(--color-text-secondary)" }}>{t("contentOpsNoRepositories")}</div>}
      {repositories.map(repo => <div key={repo.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 16px", borderBottom: "1px solid var(--color-border)" }}><GitPullRequest size={17} /><span style={{ flex: 1, minWidth: 0, fontSize: 13 }}><b style={{ display: "block" }}>{repo.name}</b><small style={{ color: "var(--color-text-tertiary)" }}>{repo.owner}/{repo.repo} · {repo.baseBranch} · /{repo.contentRoot}</small></span><button style={{ ...iconButton, color: "var(--color-accent-red)" }} onClick={() => remove(repo.id)}><Trash2 size={14} /></button></div>)}
    </div>
  </div>;
}

function StatusBadge({ status, t }: { status: string; t: (k: string) => string }) { const color = STATUS_COLORS[status] || "#8e8e93"; return <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 9px", borderRadius: 20, color, background: `${color}18`, fontSize: 11, fontWeight: 700 }}><Circle size={7} fill={color} color={color} />{t(STATUS_KEYS[status] || "contentOpsStatusIdea")}</span>; }
function GateSummary({ preflight, t }: { preflight: Preflight; t: (k: string) => string }) { return <div><h3 style={sectionTitle}><ShieldCheck size={16} /> {t("contentOpsPreflight")}</h3><div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}><Metric color={preflight.blockers ? "#ff453a" : "#34c759"} value={preflight.blockers} label={t("contentOpsBlockers")} /><Metric color="#ff9f0a" value={preflight.warnings} label={t("contentOpsWarnings")} /><Metric color="#2997ff" value={preflight.words} label={t("contentOpsWords")} /></div><div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{preflight.gates.map(g => { const gateKey = g.id === "target_mode" ? (g.message.startsWith("New") ? "contentOpsGateNewExists" : "contentOpsGateUpdateMissing") : GATE_KEYS[`${g.id}:${g.severity}`]; return <div key={g.id} style={{ display: "flex", alignItems: "flex-start", gap: 7, fontSize: 12, color: "var(--color-text-secondary)" }}>{g.severity === "pass" ? <CheckCircle2 size={14} color="#34c759" /> : g.severity === "warning" ? <AlertTriangle size={14} color="#ff9f0a" /> : <XCircle size={14} color="#ff453a" />}<span>{gateKey ? t(gateKey) : g.message}{g.detail ? <small style={{ display: "block", color: "var(--color-text-tertiary)" }}>{g.detail}</small> : null}</span></div>; })}</div></div>; }
function Metric({ color, value, label }: { color: string; value: number; label: string }) { return <span style={{ padding: "4px 9px", borderRadius: 8, background: `${color}16`, color, fontSize: 11, fontWeight: 700 }}>{value} {label}</span>; }
function DiffBlock({ title, lines, color, prefix }: { title: string; lines: string[]; color: string; prefix: string }) { return <div style={{ border: `1px solid ${color}35`, borderRadius: 8, overflow: "hidden" }}><div style={{ padding: "6px 9px", color, background: `${color}10`, fontSize: 11, fontWeight: 700 }}>{title} · {lines.length}</div><pre style={{ margin: 0, padding: 9, maxHeight: 260, overflow: "auto", fontSize: 10, lineHeight: 1.45, whiteSpace: "pre-wrap", color: "var(--color-text-secondary)" }}>{lines.map((line, i) => `${prefix} ${line}${i < lines.length - 1 ? "\n" : ""}`)}</pre></div>; }
function Notice({ tone, children }: { tone: "warning" | "error"; children: React.ReactNode }) { const color = tone === "error" ? "#ff453a" : "#ff9f0a"; return <div style={{ padding: "11px 13px", borderRadius: 9, border: `1px solid ${color}45`, background: `${color}0d`, color, fontSize: 12 }}>{children}</div>; }

const titleStyle: React.CSSProperties = { fontSize: 20, fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px" };
const subStyle: React.CSSProperties = { fontSize: 13, color: "var(--color-text-secondary)", margin: 0, maxWidth: 760, lineHeight: 1.5 };
const sectionTitle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 8px" };
const hintStyle: React.CSSProperties = { fontSize: 12, lineHeight: 1.5, color: "var(--color-text-secondary)", margin: "0 0 11px" };
const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5, fontSize: 11, fontWeight: 650, color: "var(--color-text-secondary)" };
const primaryButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "8px 13px", borderRadius: 8, border: 0, background: "var(--color-accent-blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" };
const ghostButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "8px 13px", borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: 12, fontWeight: 650, cursor: "pointer" };
const iconButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 7, borderRadius: 7, border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", cursor: "pointer" };
function tabButton(active: boolean): React.CSSProperties { return { ...ghostButton, color: active ? "#fff" : "var(--color-text-secondary)", background: active ? "var(--color-accent-blue)" : "var(--color-card)", borderColor: active ? "var(--color-accent-blue)" : "var(--color-border)" }; }
