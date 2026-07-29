"use client";

// Site Audit tab — built-in crawler (no external APIs, free). Start a crawl, poll while
// it runs, then browse issues: summary cards by issue type → click a card to filter the
// page table. Same fire-and-forget/poll UX as the SEO Tools background jobs.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, Trash2, AlertTriangle, CheckCircle, ExternalLink, Filter, Download } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { withShare, isGuestView } from "@/lib/shareParam";
import { buildAuditMarkdown } from "@/lib/audit/exportMd";
import { downloadFile } from "@/lib/seo/exportFormats";

const ISSUE_LABEL_KEYS: Record<string, string> = {
  http_error: "auditIssueHttpError",
  fetch_failed: "auditIssueFetchFailed",
  redirect: "auditIssueRedirect",
  title_missing: "auditIssueTitleMissing",
  title_too_long: "auditIssueTitleTooLong",
  title_duplicate: "auditIssueTitleDuplicate",
  description_missing: "auditIssueDescriptionMissing",
  description_too_long: "auditIssueDescriptionTooLong",
  h1_missing: "auditIssueH1Missing",
  h1_multiple: "auditIssueH1Multiple",
  noindex: "auditIssueNoindex",
  canonical_mismatch: "auditIssueCanonicalMismatch",
  thin_content: "auditIssueThinContent",
  images_no_alt: "auditIssueImagesNoAlt",
  broken_links: "auditIssueBrokenLinks",
  slow_response: "auditIssueSlowResponse",
};

const SEVERE = new Set(["http_error", "fetch_failed", "broken_links", "noindex"]);

export default function SiteAuditPanel({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  const guest = isGuestView();
  const [audits, setAudits] = useState<any[]>([]);
  const [current, setCurrent] = useState<any>(null); // { audit, pages }
  const [maxPages, setMaxPages] = useState(200);
  // On by default: the built-in list is bot-protection and admin endpoints that are supposed to
  // refuse a crawler, so counting them as broken links is always wrong.
  const [useDefaults, setUseDefaults] = useState(true);
  const [ignoreExtra, setIgnoreExtra] = useState("");
  const [issueFilter, setIssueFilter] = useState("");
  const [starting, setStarting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const loadList = useCallback(async () => {
    try {
      const d = await fetch(withShare(`/api/audit?siteId=${siteDbId}`)).then(r => r.json());
      const list = d.audits || [];
      setAudits(list);
      return list;
    } catch { return []; }
  }, [siteDbId]);

  const openAudit = useCallback(async (id: string, issue = "") => {
    try {
      const d = await fetch(withShare(`/api/audit/${id}${issue ? `?issue=${encodeURIComponent(issue)}` : ""}`)).then(r => r.json());
      if (d.audit) setCurrent(d);
    } catch {}
  }, []);

  // initial load: newest completed audit opens automatically
  useEffect(() => {
    (async () => {
      const list = await loadList();
      const latestDone = list.find((a: any) => a.status === "completed");
      if (latestDone) await openAudit(latestDone.id);
      setLoading(false);
    })();
  }, [loadList, openAudit]);

  // poll while an audit is running
  const running = audits.find(a => a.status === "running");
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(async () => {
      const list = await loadList();
      const r = list.find((a: any) => a.id === running.id);
      if (r && r.status !== "running") {
        clearInterval(iv);
        if (r.status === "completed") openAudit(r.id);
      }
    }, 4000);
    return () => clearInterval(iv);
  }, [running?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setStarting(true); setErr("");
    try {
      const res = await fetch("/api/audit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteId: siteDbId, maxPages,
          ignorePatterns: ignoreExtra,
          skipDefaultIgnores: !useDefaults,
        }),
      });
      const d = await res.json();
      if (!res.ok) setErr(d.error === "already_running" ? t("auditAlreadyRunning") : String(d.error ?? "error"));
      await loadList();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setStarting(false);
  };

  const remove = async (id: string) => {
    await fetch(`/api/audit/${id}`, { method: "DELETE" }).catch(() => {});
    if (current?.audit?.id === id) setCurrent(null);
    loadList();
  };

  // Always re-fetches unfiltered: the on-screen table may be narrowed to one issue, and an export
  // that silently inherited that filter would look complete while omitting most of the findings.
  const exportMd = async () => {
    const id = current?.audit?.id;
    if (!id) return;
    setExporting(true);
    try {
      const d = await fetch(withShare(`/api/audit/${id}`)).then(r => r.json());
      const md = buildAuditMarkdown(d.audit ?? {}, d.pages ?? [], code => t((ISSUE_LABEL_KEYS[code] ?? code) as never) || code);
      const host = (() => { try { return new URL(d.audit?.siteUrl || "").host; } catch { return "site"; } })();
      const day = new Date(d.audit?.finishedAt ?? Date.now()).toISOString().slice(0, 10);
      downloadFile(md, `audit-${host}-${day}.md`, "text/markdown;charset=utf-8");
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setExporting(false);
  };

  const filterIssue = (code: string) => {
    if (!current?.audit) return;
    const next = issueFilter === code ? "" : code;
    setIssueFilter(next);
    openAudit(current.audit.id, next);
  };

  const summary = current?.audit?.summary;

  return (
    // Padding and a max width to match the sibling tabs (Health, Clarity). Without them the audit
    // table ran edge to edge on a wide monitor, which is what made this tab look unfinished.
    <div style={{ padding: "28px 32px", maxWidth: "1400px", margin: "0 auto", width: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Launcher */}
      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "220px" }}>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("auditTitle")}</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{t("auditSub")}</div>
          </div>
          {!guest && <select value={maxPages} onChange={e => setMaxPages(parseInt(e.target.value))}
            style={{ padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px" }}>
            {[50, 100, 200, 350, 500].map(n => <option key={n} value={n}>{n} {t("auditPagesUnit")}</option>)}
          </select>}
          {summary && (
            <button onClick={exportMd} disabled={exporting} title={t("auditExportMdHint")}
              style={{ display: "inline-flex", alignItems: "center", gap: "7px", padding: "10px 14px", borderRadius: "9px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "13px", fontWeight: 600, cursor: exporting ? "default" : "pointer" }}>
              {exporting ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {t("auditExportMd")}
            </button>
          )}
          {!guest && <button onClick={start} disabled={starting || !!running}
            style={{ display: "inline-flex", alignItems: "center", gap: "7px", padding: "10px 16px", borderRadius: "9px", border: "none", background: running ? "rgba(255,255,255,0.08)" : "var(--color-accent-blue)", color: running ? "var(--color-text-secondary)" : "#fff", fontSize: "13px", fontWeight: 600, cursor: running ? "default" : "pointer" }}>
            {running ? <><Loader2 size={14} className="spin" /> {t("auditRunning")} ({running.pagesCrawled}/{running.maxPages})</> : <><Play size={14} /> {t("auditStart")}</>}
          </button>}
        </div>

        {/* Crawl exclusions, chosen before the run starts. */}
        {!guest && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--color-border)", paddingTop: "12px" }}>
            <label title={t("auditIgnoreDefaultsHint")} style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "13px", color: useDefaults ? "var(--color-accent-blue)" : "var(--color-text-secondary)", cursor: "pointer", width: "fit-content" }}>
              <input type="checkbox" checked={useDefaults} onChange={e => setUseDefaults(e.target.checked)} style={{ accentColor: "var(--color-accent-blue)" }} />
              <Filter size={14} /> {t("auditIgnoreDefaults")}
            </label>
            <input
              value={ignoreExtra}
              onChange={e => setIgnoreExtra(e.target.value)}
              placeholder={t("auditIgnoreExtraPh")}
              style={{ padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "12px", width: "100%", boxSizing: "border-box" }}
            />
            <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", lineHeight: 1.5 }}>{t("auditIgnoreExtraHint")}</div>
          </div>
        )}
      </div>
      {err && <div style={{ fontSize: "12px", color: "#f87171", display: "flex", alignItems: "center", gap: "6px" }}><AlertTriangle size={13} /> {err}</div>}

      {loading ? (
        <div style={{ padding: "40px", textAlign: "center", color: "var(--color-text-secondary)" }}><Loader2 size={18} className="spin" /></div>
      ) : !current && !running ? (
        <div className="panel" style={{ textAlign: "center", padding: "36px", color: "var(--color-text-secondary)", fontSize: "13px" }}>{t("auditEmpty")}</div>
      ) : null}

      {/* Summary */}
      {summary && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "10px" }}>
            <div className="panel" style={{ textAlign: "center" }}>
              <div style={{ fontSize: "26px", fontWeight: 800, color: summary.healthScore >= 80 ? "#34c759" : summary.healthScore >= 50 ? "#ff9f0a" : "#ff375f" }}>{summary.healthScore}</div>
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("auditHealthScore")}</div>
            </div>
            <div className="panel" style={{ textAlign: "center" }}>
              <div style={{ fontSize: "26px", fontWeight: 800, color: "var(--color-text-primary)" }}>{summary.pages}</div>
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("auditPagesCrawled")}</div>
            </div>
            <div className="panel" style={{ textAlign: "center" }}>
              <div style={{ fontSize: "26px", fontWeight: 800, color: "var(--color-text-primary)" }}>{summary.pagesWithIssues}</div>
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("auditPagesWithIssues")}</div>
            </div>
            <div className="panel" style={{ textAlign: "center" }}>
              <div style={{ fontSize: "26px", fontWeight: 800, color: "var(--color-text-primary)" }}>{summary.avgLoadMs}<span style={{ fontSize: "13px" }}> ms</span></div>
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("auditAvgLoad")}</div>
            </div>
          </div>

          {/* Issue chips */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {Object.entries(summary.issues as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([code, count]) => (
              <button key={code} onClick={() => filterIssue(code)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 12px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer",
                  border: `1px solid ${issueFilter === code ? "var(--color-accent-blue)" : "var(--color-border)"}`,
                  background: issueFilter === code ? "rgba(59,130,246,0.12)" : "var(--color-card)",
                  color: SEVERE.has(code) ? "#ff375f" : "var(--color-text-primary)",
                }}>
                {t((ISSUE_LABEL_KEYS[code] ?? code) as any)} <span style={{ opacity: 0.7 }}>{count}</span>
              </button>
            ))}
            {Object.keys(summary.issues ?? {}).length === 0 && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "#34c759" }}><CheckCircle size={14} /> {t("auditNoIssues")}</span>
            )}
          </div>

          {/* Pages table */}
          <div className="panel" style={{ overflowX: "auto", padding: 0 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--color-border)", color: "var(--color-text-secondary)", textAlign: "left" }}>
                  <th style={{ padding: "10px 14px" }}>URL</th>
                  <th style={{ padding: "10px 8px" }}>HTTP</th>
                  <th style={{ padding: "10px 8px" }}>{t("auditColTitle")}</th>
                  <th style={{ padding: "10px 8px" }}>{t("auditColWords")}</th>
                  <th style={{ padding: "10px 8px" }}>ms</th>
                  <th style={{ padding: "10px 14px" }}>{t("auditColIssues")}</th>
                </tr>
              </thead>
              <tbody>
                {(current?.pages ?? []).filter((p: any) => !issueFilter || p.issues.includes(issueFilter)).slice(0, 300).map((p: any) => (
                  <tr key={p.url} style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <td style={{ padding: "8px 14px", maxWidth: "340px" }}>
                      <a href={p.url} target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "320px", display: "inline-block", verticalAlign: "bottom" }}>{p.url.replace(/^https?:\/\/[^/]+/, "") || "/"}</span>
                        <ExternalLink size={11} />
                      </a>
                      {p.issues.includes("broken_links") && p.brokenLinks.length > 0 && (
                        <div style={{ fontSize: "11px", color: "#ff375f", marginTop: "2px" }}>
                          → {p.brokenLinks.slice(0, 3).map((b: string) => b.replace(/^https?:\/\/[^/]+/, "")).join(", ")}{p.brokenLinks.length > 3 ? ` +${p.brokenLinks.length - 3}` : ""}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "8px 8px", color: p.httpStatus >= 400 || p.httpStatus === 0 ? "#ff375f" : p.httpStatus >= 300 ? "#ff9f0a" : "#34c759", fontWeight: 700 }}>{p.httpStatus || "ERR"}</td>
                    <td style={{ padding: "8px 8px", maxWidth: "240px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: p.title ? "var(--color-text-primary)" : "#ff9f0a" }}>{p.title || "—"}</td>
                    <td style={{ padding: "8px 8px", color: "var(--color-text-secondary)" }}>{p.wordCount}</td>
                    <td style={{ padding: "8px 8px", color: p.loadMs > 3000 ? "#ff9f0a" : "var(--color-text-secondary)" }}>{p.loadMs}</td>
                    <td style={{ padding: "8px 14px" }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                        {p.issues.map((code: string) => (
                          <span key={code} style={{ fontSize: "10px", padding: "2px 7px", borderRadius: "5px", background: SEVERE.has(code) ? "rgba(255,55,95,0.12)" : "rgba(255,159,10,0.12)", color: SEVERE.has(code) ? "#ff375f" : "#ff9f0a", fontWeight: 600 }}>
                            {t((ISSUE_LABEL_KEYS[code] ?? code) as any)}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* History */}
      {audits.length > 0 && (
        <div className="panel">
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "10px" }}>{t("auditHistory")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {audits.map(a => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 10px", borderRadius: "8px", background: current?.audit?.id === a.id ? "rgba(59,130,246,0.08)" : "transparent", cursor: a.status === "completed" ? "pointer" : "default" }}
                onClick={() => a.status === "completed" && (setIssueFilter(""), openAudit(a.id))}>
                <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", minWidth: "140px" }}>{new Date(a.startedAt).toLocaleString()}</span>
                <span style={{ fontSize: "11px", fontWeight: 700, color: a.status === "completed" ? "#34c759" : a.status === "running" ? "#ff9f0a" : "#ff375f" }}>
                  {a.status === "completed" ? `✓ ${a.pagesCrawled} ${t("auditPagesUnit")}` : a.status === "running" ? t("auditRunning") : `✗ ${a.error ?? "error"}`}
                </span>
                {a.summary && <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("auditHealthScore")}: {a.summary.healthScore}</span>}
                <span style={{ flex: 1 }} />
                {!guest && <button onClick={e => { e.stopPropagation(); remove(a.id); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: "2px" }}><Trash2 size={13} /></button>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
