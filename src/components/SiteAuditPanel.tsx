"use client";

// Site Audit tab — built-in crawler (no external APIs, free). Start a crawl, poll while
// it runs, then browse issues: summary cards by issue type → click a card to filter the
// page table. Same fire-and-forget/poll UX as the SEO Tools background jobs.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, Trash2, AlertTriangle, CheckCircle, ExternalLink, Filter, Download, RefreshCw } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { withShare, isGuestView } from "@/lib/shareParam";
import { buildAuditMarkdown } from "@/lib/audit/exportMd";
import { downloadFile } from "@/lib/seo/exportFormats";
import { AUDIT_RULES } from "@/lib/audit/rules";

const ISSUE_LABEL_KEYS = Object.fromEntries(AUDIT_RULES.map(rule => [rule.id, rule.titleKey]));
const SEVERE = new Set(AUDIT_RULES.filter(rule => rule.severity === "critical").map(rule => rule.id));
// Info-level issues are not faults to fix but limits of this crawler — flagging them red/orange
// alongside real problems would send a user to "repair" a JS-rendered page that isn't broken.
// js_rendered is informational: "we can't audit the rendered DOM", not "your page is wrong".
const INFO = new Set(AUDIT_RULES.filter(rule => rule.severity === "info").map(rule => rule.id));

// ─── AI Crawlability card ─────────────────────────────────────────────────────
// Site-wide (robots.txt + /llms.txt), so it is its own card rather than an entry in the per-page
// issue chip row. Renders only when summary.aiCrawlability is present: audits run before this
// check shipped have no key and must not render a half-empty card.

interface AiCrawlBot { token: string; engine: string; status: "allowed" | "blocked" | "unknown" }
interface AiCrawlSummary {
  robots: { status: "ok" | "missing" | "failed"; present: boolean };
  llmsTxt: { status: "ok" | "missing" | "failed"; present: boolean };
  bots: AiCrawlBot[];
  blockedCount: number;
  total: number;
}

// Inline bádgе: same visual vocabulary as SiteHealthPanel's StatusBadge (green/amber/red pill),
// kept local because the audit panel does not import that component.
function AiBadge({ status, label }: { status: AiCrawlBot["status"]; label: string }) {
  const color = status === "allowed" ? "#34c759" : status === "blocked" ? "#ff375f" : "var(--color-text-tertiary)";
  const bg = status === "allowed" ? "rgba(52,199,89,0.12)" : status === "blocked" ? "rgba(255,55,95,0.12)" : "var(--color-border-soft)";
  const mark = status === "allowed" ? "✓" : status === "blocked" ? "✗" : "?";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 8px", borderRadius: "var(--radius-pill)", fontSize: "11px", fontWeight: 600, color, background: bg, whiteSpace: "nowrap" }}>
      {mark} {label}
    </span>
  );
}

// The translation function's key type is the dictionary's keyof — same shape useLanguage exposes.
// Typed locally (not imported) so this card stays a self-contained block.
function AiCrawlabilityCard({ data, t }: { data: AiCrawlSummary; t: (k: string) => string }) {
  // File-level badges: present/missing/failed. Missing robots = all allowed per spec (neutral, not
  // red); failed = we couldn't read it (amber, genuinely uncertain). llms.txt missing is the norm,
  // never an error.
  const fileBadge = (status: AiCrawlSummary["robots"]["status"], present: boolean, presentLabel: string, missingLabel: string) =>
    present ? <AiBadge status="allowed" label={presentLabel} />
    : status === "failed" ? <AiBadge status="unknown" label={t("auditAiFailed")} />
    : <AiBadge status="unknown" label={missingLabel} />;

  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("auditAiTitle")}</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{t("auditAiSub")}</div>
        </div>
        <div style={{ fontSize: "12px", fontWeight: 600, color: data.blockedCount > 0 ? "#ff375f" : "#34c759" }}>
          {t("auditAiBlockedCount").replace("{n}", String(data.blockedCount)).replace("{m}", String(data.total))}
        </div>
      </div>

      {/* Files row */}
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          robots.txt
          {fileBadge(data.robots.status, data.robots.present, t("auditAiRobotsPresent"), t("auditAiRobotsMissing"))}
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          /llms.txt
          {fileBadge(data.llmsTxt.status, data.llmsTxt.present, t("auditAiLlmsPresent"), t("auditAiLlmsMissing"))}
        </div>
      </div>

      {/* Bots: one row per engine, engine name + token + status badge */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "8px" }}>
        {data.bots.map(b => (
          <div key={b.token} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", padding: "8px 12px", borderRadius: "var(--radius-md)", background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.engine}</div>
              <div style={{ fontSize: "10px", color: "var(--color-text-tertiary)", fontFamily: "monospace" }}>{b.token}</div>
            </div>
            <AiBadge status={b.status} label={b.status === "allowed" ? t("auditAiAllowed") : b.status === "blocked" ? t("auditAiBlocked") : t("auditAiUnknown")} />
          </div>
        ))}
      </div>
    </div>
  );
}


export default function SiteAuditPanel({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  const guest = isGuestView();
  const [audits, setAudits] = useState<any[]>([]);
  const [current, setCurrent] = useState<any>(null); // { audit, pages }
  // A 200-page crawl rendered 300 rows at once, which is a scroll bar rather than a table. The
  // filter changes what "page 1" means, so the position resets whenever the filter or audit does.
  const [auditPage, setAuditPage] = useState(0);
  // Empty means "the whole site", which is what almost everyone wants and what a crawler should do
  // without being asked. The field stays for the rare case of deliberately sampling a huge site.
  const [maxPages, setMaxPages] = useState<number | "">("");
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

  const start = async (baselineAuditId?: string) => {
    setStarting(true); setErr("");
    try {
      const res = await fetch("/api/audit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baselineAuditId
          ? { siteId: siteDbId, baselineAuditId }
          : {
              siteId: siteDbId, ...(maxPages ? { maxPages } : {}),
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
      const md = buildAuditMarkdown(
        d.audit ?? {}, d.pages ?? [],
        code => t((ISSUE_LABEL_KEYS[code] ?? code) as never) || code,
        // Passed only so the AI Crawlability section renders in the report's language. The section
        // is conditional on this object, so an audit without aiCrawlability still exports cleanly.
        {
          title: t("auditAiTitle"),
          blocked: t("auditAiBlocked"), allowed: t("auditAiAllowed"), unknown: t("auditAiUnknown"),
          robotsMissing: t("auditAiRobotsMissing"), robotsFailed: t("auditAiFailed"),
          llmsMissing: t("auditAiLlmsMissing"),
        },
      );
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
    setAuditPage(0);
    openAudit(current.audit.id, next);
  };

  const summary = current?.audit?.summary;
  // 300 rows in one table is a scroll bar pretending to be a report. The filter decides what page
  // one contains, so both it and switching audits reset the position.
  const AUDIT_PAGE_SIZE = 50;
  const filteredPages: any[] = (current?.pages ?? []).filter((p: any) => !issueFilter || p.issues.includes(issueFilter));
  const auditPageCount = Math.max(1, Math.ceil(filteredPages.length / AUDIT_PAGE_SIZE));
  const safePage = Math.min(auditPage, auditPageCount - 1);
  const visiblePages = filteredPages.slice(safePage * AUDIT_PAGE_SIZE, safePage * AUDIT_PAGE_SIZE + AUDIT_PAGE_SIZE);
  const verification = current?.audit?.verification;
  const verificationOpen = verification ? [
    ...(verification.regressions ?? []).map((finding: any) => ({ ...finding, kind: "regression" })),
    ...(verification.stillPresent ?? []).map((finding: any) => ({ ...finding, kind: "still" })),
  ].slice(0, 6) : [];

  return (
    // Padding and a max width to match the sibling tabs (Health, Clarity). Without them the audit
    // table ran edge to edge on a wide monitor, which is what made this tab look unfinished.
    <div style={{ padding: "28px var(--page-padding)", maxWidth: "var(--page-max-width)", margin: "0 auto", width: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Launcher */}
      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "220px" }}>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("auditTitle")}</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{t("auditSub")}</div>
          </div>
          {!guest && <input
            type="number" min={10} max={5000} value={maxPages}
            onChange={e => setMaxPages(e.target.value ? Math.max(10, Math.min(5000, parseInt(e.target.value) || 10)) : "")}
            placeholder={t("auditPagesAll")} title={t("auditPagesHint")}
            style={{ width: 132, padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px" }}
          />}
          {summary && (
            <button onClick={exportMd} disabled={exporting} title={t("auditExportMdHint")}
              style={{ display: "inline-flex", alignItems: "center", gap: "7px", padding: "10px 14px", borderRadius: "9px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "13px", fontWeight: 600, cursor: exporting ? "default" : "pointer" }}>
              {exporting ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {t("auditExportMd")}
            </button>
          )}
          {!guest && summary && current?.audit?.status === "completed" && (
            <button onClick={() => start(current.audit.id)} disabled={starting || !!running} title={t("auditVerifyHint")}
              style={{ display: "inline-flex", alignItems: "center", gap: "7px", padding: "10px 14px", borderRadius: "9px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "13px", fontWeight: 600, cursor: starting || running ? "default" : "pointer" }}>
              {starting || running ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} {t("auditVerifyRun")}
            </button>
          )}
          {!guest && <button onClick={() => start()} disabled={starting || !!running}
            style={{ display: "inline-flex", alignItems: "center", gap: "7px", padding: "10px 16px", borderRadius: "9px", border: "none", background: running ? "rgba(255,255,255,0.08)" : "var(--color-accent-blue)", color: running ? "var(--color-text-secondary)" : "#fff", fontSize: "13px", fontWeight: 600, cursor: running ? "default" : "pointer" }}>
            {running ? <><Loader2 size={14} className="spin" /> {t("auditRunning")} ({running.pagesCrawled})</> : <><Play size={14} /> {t("auditStart")}</>}
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
          {current?.audit?.verification && (
            <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div>
                <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("auditVerifyTitle")}</div>
                <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "3px" }}>{t("auditVerifyHint")}</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "8px" }}>
                {[
                  ["resolved", "auditVerifyResolved", "#34c759"],
                  ["stillPresent", "auditVerifyStill", "#ff9f0a"],
                  ["regressions", "auditVerifyRegressions", "#ff375f"],
                  ["inconclusive", "auditVerifyInconclusive", "#60a5fa"],
                ].map(([field, label, color]) => (
                  <div key={field} style={{ padding: "10px 12px", borderRadius: "var(--radius-md)", background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
                    <div style={{ fontSize: "22px", fontWeight: 800, color }}>{current.audit.verification.counts?.[field] ?? 0}</div>
                    <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t(label as any)}</div>
                  </div>
                ))}
              </div>
              {verificationOpen.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px", borderTop: "1px solid var(--color-border)", paddingTop: "10px" }}>
                  {verificationOpen.map((finding: any) => (
                    <div key={`${finding.kind}:${finding.url}:${finding.ruleId}`} style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, fontSize: "11px" }}>
                      <span style={{ flex: "0 0 auto", padding: "2px 6px", borderRadius: "5px", fontWeight: 700, color: finding.kind === "regression" ? "#ff375f" : "#ff9f0a", background: finding.kind === "regression" ? "rgba(255,55,95,0.12)" : "rgba(255,159,10,0.12)" }}>
                        {t(finding.kind === "regression" ? "auditVerifyRegressions" : "auditVerifyStill")}
                      </span>
                      <span style={{ flex: "0 0 auto", color: "var(--color-text-primary)", fontWeight: 600 }}>{t((ISSUE_LABEL_KEYS[finding.ruleId] ?? finding.ruleId) as any)}</span>
                      <a href={finding.url} target="_blank" rel="noreferrer" style={{ color: "var(--color-text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "none" }}>{finding.url}</a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
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

          {/* AI Crawlability — site-wide check, separate from the per-page issue chips below */}
          {/* t is cast to a plain string-key signature here: the card's keys are known-good literals,
              and widening at this single point keeps the card's own type honest without importing
              the dictionary's keyof union. */}
          {summary.aiCrawlability && <AiCrawlabilityCard data={summary.aiCrawlability} t={t as (k: string) => string} />}

          {/* Issue chips */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {Object.entries(summary.issues as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([code, count]) => (
              <button key={code} onClick={() => filterIssue(code)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 12px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer",
                  border: `1px solid ${issueFilter === code ? "var(--color-accent-blue)" : "var(--color-border)"}`,
                  background: issueFilter === code ? "rgba(59,130,246,0.12)" : "var(--color-card)",
                  color: SEVERE.has(code) ? "#ff375f" : INFO.has(code) ? "#60a5fa" : "var(--color-text-primary)",
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
                {visiblePages.map((p: any) => (
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
                        {p.issues.map((code: string) => {
                          // Info-level (js_rendered) gets the blue info tint so it reads as
                          // "audit limit", not as an orange warning to act on.
                          const isInfo = INFO.has(code);
                          const isSevere = SEVERE.has(code);
                          return (
                            <span key={code} style={{ fontSize: "10px", padding: "2px 7px", borderRadius: "5px", background: isSevere ? "rgba(255,55,95,0.12)" : isInfo ? "rgba(96,165,250,0.12)" : "rgba(255,159,10,0.12)", color: isSevere ? "#ff375f" : isInfo ? "#60a5fa" : "#ff9f0a", fontWeight: 600 }}>
                              {t((ISSUE_LABEL_KEYS[code] ?? code) as any)}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredPages.length > AUDIT_PAGE_SIZE && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 14px", borderTop: "1px solid var(--color-border)", fontSize: 12, color: "var(--color-text-secondary)" }}>
                <span>
                  {safePage * AUDIT_PAGE_SIZE + 1}–{safePage * AUDIT_PAGE_SIZE + visiblePages.length} / {filteredPages.length}
                </span>
                <span style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => setAuditPage(Math.max(0, safePage - 1))} disabled={safePage === 0} style={pagerButton(safePage === 0)}>←</button>
                  <span style={{ padding: "6px 4px" }}>{safePage + 1} / {auditPageCount}</span>
                  <button onClick={() => setAuditPage(Math.min(auditPageCount - 1, safePage + 1))} disabled={safePage >= auditPageCount - 1} style={pagerButton(safePage >= auditPageCount - 1)}>→</button>
                </span>
              </div>
            )}
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

const pagerButton = (disabled: boolean): React.CSSProperties => ({
  padding: "6px 11px", borderRadius: 7, border: "1px solid var(--color-border)",
  background: "var(--color-card)", color: disabled ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
  cursor: disabled ? "default" : "pointer", fontSize: 12,
});
