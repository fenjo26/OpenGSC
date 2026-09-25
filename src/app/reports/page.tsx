"use client";

// N8 — /reports: the operator's list of client reports. Everything a report can do lives
// on its card: preview (the exact HTML that would freeze), Send now (snapshot + PDF +
// e-mail), the client link (create/rotate/copy/disable), the sent snapshots with HTML/PDF
// downloads, edit and delete. The constructor itself is ReportEditor.

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, CalendarClock, Clock, Copy, FileDown, FileText, Link2, Link2Off,
  Loader2, Mail, Pencil, Plus, Send, Trash2,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import ReportEditor, { type EditorDraft } from "@/components/reports/ReportEditor";
import type { ReportRow } from "@/lib/reports/store";

const btn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px",
  borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
  border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)",
};
const btnPrimary: React.CSSProperties = { ...btn, border: "1px solid transparent", background: "#2563eb", color: "#fff" };
const btnDanger: React.CSSProperties = { ...btn, color: "var(--color-accent-red, #dc2626)" };

const fmtDateTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

export default function ReportsPage() {
  const { t } = useLanguage();
  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [sites, setSites] = useState<{ id: string; domain: string }[]>([]);
  const [smtpOk, setSmtpOk] = useState(true);
  const [notMigrated, setNotMigrated] = useState(false);
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ReportRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const r = await fetch("/api/reports");
      const body = await r.json().catch(() => ({}));
      if (body.notMigrated) { setNotMigrated(true); setReports([]); setSites([]); return; }
      if (!r.ok) { setError(String(body.error ?? r.status)); setReports([]); return; }
      setNotMigrated(false);
      setReports(Array.isArray(body.reports) ? body.reports : []);
      setSites(Array.isArray(body.sites) ? body.sites : []);
      setSmtpOk(Boolean(body.smtpConfigured));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReports([]);
    }
  }, []);

  // State writes happen after the awaited fetch — several ticks after render, so no
  // second render can cascade before paint (the pattern every list page here uses).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(""), 4000);
    return () => clearTimeout(timer);
  }, [note]);

  const onSave = async (draft: EditorDraft) => {
    setSaving(true);
    setEditorError("");
    try {
      const r = await fetch(editing ? `/api/reports/${editing.id}` : "/api/reports", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setEditorError(String(body.error ?? r.status)); return; }
      setEditorOpen(false);
      setEditing(null);
      await load();
    } catch (e) {
      setEditorError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onSendNow = async (r0: ReportRow) => {
    setBusyId(r0.id);
    try {
      const r = await fetch(`/api/reports/${r0.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: typeof navigator !== "undefined" ? navigator.language : undefined }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setNote(`${t("repSendNow")}: ${String(body.error ?? r.status)}`); return; }
      setNote(body.sentTo
        ? `${t("repSentTo" as never) || "Sent to"}: ${body.sentTo}`
        : `${t("repSendNone" as never) || "Snapshot created, not sent"}${body.error ? ` (${body.error})` : ""}`);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const onShare = async (r0: ReportRow, on: boolean) => {
    setBusyId(r0.id);
    try {
      const r = await fetch(`/api/reports/${r0.id}/share`, { method: on ? "POST" : "DELETE" });
      if (r.ok) await load();
    } finally {
      setBusyId(null);
    }
  };

  const onCopyLink = async (r0: ReportRow) => {
    if (!r0.shareToken) return;
    const url = `${window.location.origin}/share/report/${r0.shareToken}`;
    try {
      await navigator.clipboard.writeText(url);
      setNote(t("settCopied") || "Copied");
    } catch {
      setNote(url);
    }
  };

  const onDelete = async (r0: ReportRow) => {
    if (!window.confirm(`${t("repDeleteConfirm" as never) || "Delete report"}: ${r0.title}?`)) return;
    setBusyId(r0.id);
    try {
      const r = await fetch(`/api/reports/${r0.id}`, { method: "DELETE" });
      if (r.ok) await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="main-content" style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 20, paddingBottom: 40 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1 style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 22, margin: 0, color: "var(--color-text-primary)" }}>
            <FileText size={20} /> {t("repTitle")}
          </h1>
          <p style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 6, maxWidth: 760 }}>
            {t("repSubtitle" as never) || "White-label HTML snapshots with PDF, schedule and a client link."}
          </p>
        </div>
        <button
          onClick={() => { setEditing(null); setEditorError(""); setEditorOpen(true); }}
          style={btnPrimary} disabled={notMigrated || (sites.length === 0)}
          aria-label={t("repNew")}
        >
          <Plus size={14} /> {t("repNew")}
        </button>
      </div>

      {notMigrated && (
        <div className="panel" style={{ color: "var(--color-accent-orange)", fontSize: 13 }}>
          <AlertTriangle size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
          {t("autoSyncNotMigrated") || "Run npx prisma db push"}
        </div>
      )}
      {!notMigrated && !smtpOk && reports?.length ? (
        <div className="panel" style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          <Mail size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
          {t("repNoSmtp")} — <a href="/settings">{t("notifyChTitle") || "Settings"}</a>
        </div>
      ) : null}
      {error && <div className="panel" style={{ color: "var(--color-accent-red, #dc2626)", fontSize: 13 }}>{error}</div>}
      {note && <div className="panel" style={{ fontSize: 13 }}>{note}</div>}

      {reports === null ? (
        <div className="panel" style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--color-text-secondary)", fontSize: 13 }}>
          <Loader2 size={15} className="rep-spin" /> {t("shareLoading") || "Loading..."}
        </div>
      ) : reports.length === 0 ? (
        <div className="panel" style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>
          {t("repEmpty" as never) || "No reports yet — create the first one."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {reports.map(r => (
            <div key={r.id} className="card" style={{ padding: 16 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)" }}>{r.title}</div>
                  <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <span>{r.siteDomain}</span>
                    <span>· {t(`repTemplate_${r.template}` as never) || r.template}</span>
                    <span>· {t("repPeriod")} {r.periodDays}d</span>
                    <span aria-label={t("repSchedule")}>· {t(`repSchedule_${r.schedule}` as never) || r.schedule}{r.schedule !== "off" ? ` (d${r.sendDay})` : ""}</span>
                    {r.recipients.length > 0 && <span>· {r.recipients.length} @</span>}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginTop: 3, display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }} title={t("repRuns")}>
                      <Clock size={11} /> {t("repRuns")}: {r.runs.length}
                    </span>
                    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }} title={t("repNextSend" as never) || "Next send"}>
                      <CalendarClock size={11} /> {r.schedule === "off" ? (t("repSchedule_off") || "Manual") : `${t("repNextSend" as never) || "Next"}: ${fmtDateTime(r.nextSendAt)}`}
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <a href={`/api/reports/${r.id}/preview`} target="_blank" rel="noreferrer" style={{ ...btn, textDecoration: "none" }} aria-label={t("repPreview")}>
                    <FileText size={13} /> {t("repPreview")}
                  </a>
                  <button onClick={() => void onSendNow(r)} disabled={busyId === r.id} style={btnPrimary} aria-label={t("repSendNow")}>
                    {busyId === r.id ? <Loader2 size={13} className="rep-spin" /> : <Send size={13} />} {t("repSendNow")}
                  </button>
                  {r.shareToken ? (
                    <>
                      <button onClick={() => void onCopyLink(r)} style={btn} title={`/share/report/${r.shareToken.slice(0, 8)}…`} aria-label={t("repClientLink")}>
                        <Copy size={13} /> {t("repClientLink")}
                      </button>
                      <button onClick={() => void onShare(r, true)} disabled={busyId === r.id} style={btn} title={t("repShareRotate" as never) || "Rotate"} aria-label={t("repShareRotate" as never) || "Rotate link"}>
                        <Link2 size={13} />
                      </button>
                      <button onClick={() => void onShare(r, false)} disabled={busyId === r.id} style={btnDanger} title={t("repShareOff" as never) || "Disable"} aria-label={t("repShareOff" as never) || "Disable link"}>
                        <Link2Off size={13} />
                      </button>
                    </>
                  ) : (
                    <button onClick={() => void onShare(r, true)} disabled={busyId === r.id} style={btn} aria-label={t("repClientLink")}>
                      <Link2 size={13} /> {t("repClientLink")}
                    </button>
                  )}
                  <button onClick={() => { setEditing(r); setEditorError(""); setEditorOpen(true); }} style={btn} aria-label={t("repEdit" as never) || "Edit"}>
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => void onDelete(r)} style={btnDanger} aria-label={t("repDelete" as never) || "Delete"}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              {r.runs.length > 0 && (
                <div style={{ marginTop: 12, borderTop: "1px solid var(--color-border)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  {r.runs.map(run => (
                    <div key={run.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
                      <span style={{ color: "var(--color-text-primary)", fontWeight: 600 }}>{run.periodFrom} — {run.periodTo}</span>
                      <span style={{ color: "var(--color-text-tertiary)" }}>{fmtDateTime(run.createdAt)}</span>
                      {run.sentTo ? (
                        <span className="pill" style={{ background: "rgba(22,163,74,0.12)", color: "#16a34a" }} title={`${t("repSentTo" as never) || "Sent to"}: ${run.sentTo}`}>
                          <Mail size={10} style={{ verticalAlign: -1 }} /> {t("repSentTo" as never) || "Sent"}
                        </span>
                      ) : run.error ? (
                        <span className="pill" style={{ background: "rgba(220,38,38,0.1)", color: "var(--color-accent-red, #dc2626)" }} title={run.error}>
                          {run.error === "smtp_not_configured" ? t("repNoSmtp") : (t("repRunError" as never) || "Error")}
                        </span>
                      ) : (
                        <span className="pill" style={{ background: "var(--color-bg)", color: "var(--color-text-secondary)" }}>
                          {t("repSendNone" as never) || "Not sent"}
                        </span>
                      )}
                      <span style={{ flex: 1 }} />
                      <a href={`/api/reports/${r.id}/runs/${run.id}?format=html`} style={{ ...btn, textDecoration: "none", padding: "5px 10px" }} aria-label={`${t("repDownloadHtml")} ${run.periodFrom}`}>
                        <FileDown size={12} /> HTML
                      </a>
                      {run.hasPdf ? (
                        <a href={`/api/reports/${r.id}/runs/${run.id}?format=pdf`} style={{ ...btn, textDecoration: "none", padding: "5px 10px" }} aria-label={`${t("repDownloadPdf")} ${run.periodFrom}`}>
                          <FileDown size={12} /> PDF
                        </a>
                      ) : (
                        <span className="pill" title={t("repPdfUnavailable")} style={{ border: "1px dashed var(--color-border)", color: "var(--color-text-tertiary)" }}>PDF</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editorOpen && (
        <ReportEditor
          key={editing?.id ?? "new"}
          sites={sites}
          editing={editing}
          saving={saving}
          error={editorError}
          onSave={onSave}
          onClose={() => { setEditorOpen(false); setEditing(null); }}
        />
      )}

      <style>{`.rep-spin { animation: rep-rotate 0.9s linear infinite; } @keyframes rep-rotate { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
