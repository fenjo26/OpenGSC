"use client";

// Workspace-wide audit hub (the per-site Audit tab only ever listed one site's runs).
// Two tabs:
//   History — every run in the workspace: when, what trigger started it, what it found,
//             which verification runs regressed. Rows are thin scalars extracted server-side
//             (src/lib/audit/historyRows.ts); the full report stays one click away in the
//             site's Audit tab.
//   Sites — the fleet view issue #19 asked for: one row per site with last/next audit,
//             the scheduling override, queue status, and checkboxes to run a bulk batch.
//             The queue panel (pause/resume/cancel/retry-failed) and the scheduler knobs
//             (concurrency, interval, hour, retry policy) live on this tab too — a knob
//             without a visible control reads as not shipped.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, ClipboardCheck, Clock, ExternalLink, Loader2, Pause, Play, RefreshCw, Settings2, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import type { AuditHistoryRow } from "@/lib/audit/historyRows";
import { DEFAULT_AUDIT_QUEUE_SETTINGS, parseSiteAuditSettings, siteIntervalDays, type AuditQueueSettings } from "@/lib/audit/schedule";

type NeverAudited = { id: string; url: string; auditSettings?: string | null };
type SortKey = "newest" | "issues" | "regressions" | "health";
type StatusFilter = "all" | "queued" | "completed" | "running" | "error";
type Tab = "history" | "sites";

// Fleet row: one per site — its scheduling override plus its latest audit (rows arrive
// newest-first, so the first row seen per site is the latest run).
type FleetRow = {
  id: string;
  url: string;
  auditSettings: string | null;
  last: AuditHistoryRow | null;
};

const PAGE = 50;
const INTERVAL_CHOICES = [1, 3, 7, 14, 30];

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

// /site/[id] decodes its param as a domain, not the internal Prisma id — build the route
// key the same way the dashboard's site cards do (getDomain + encodeURIComponent).
const siteRouteKey = (url: string) =>
  encodeURIComponent(url.replace("sc-domain:", "").replace(/^https?:\/\//, "").replace(/\/$/, ""));

// Compact page list: first, last, and a window around the current page, with ellipses.
function pageWindow(cur: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const out = [0];
  const from = Math.max(1, cur - 1);
  const to = Math.min(total - 2, cur + 1);
  if (from > 1) out.push("…");
  for (let p = from; p <= to; p++) out.push(p);
  if (to < total - 2) out.push("…");
  out.push(total - 1);
  return out;
}

export default function AuditsPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const [rows, setRows] = useState<AuditHistoryRow[]>([]);
  const [neverAudited, setNeverAudited] = useState<NeverAudited[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [siteId, setSiteId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [page, setPage] = useState(0);

  // Sites tab state
  const [tab, setTab] = useState<Tab>("history");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sitesSearch, setSitesSearch] = useState("");
  const [queueSettings, setQueueSettings] = useState<AuditQueueSettings>(DEFAULT_AUDIT_QUEUE_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<AuditQueueSettings>(DEFAULT_AUDIT_QUEUE_SETTINGS);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/audit", { cache: "no-store" });
      if (!res.ok) return;
      const d = await res.json();
      setRows(Array.isArray(d?.audits) ? d.audits : []);
      setNeverAudited(Array.isArray(d?.neverAudited) ? d.neverAudited : []);
    } catch { /* offline — keep whatever is already on screen */ }
    setLoading(false);
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/audit/settings", { cache: "no-store" });
      if (!res.ok) return;
      const d = await res.json();
      if (d?.queue) { setQueueSettings(d.queue); setSettingsDraft(d.queue); }
    } catch { /* defaults are already on screen */ }
  }, []);

  useEffect(() => { load(); loadSettings(); }, [load, loadSettings]);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(""), 6000);
  }, []);

  // An audit crawls for minutes; refresh while anything is in flight (queued rows wait for
  // a slot, running ones crawl), so progress and freshly completed results appear without
  // a manual reload.
  const hasActive = rows.some(r => r.status === "running" || r.status === "queued");
  useEffect(() => {
    if (!hasActive) return;
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [hasActive, load]);

  const counts = useMemo(() => ({
    all: rows.length,
    queued: rows.filter(r => r.status === "queued").length,
    completed: rows.filter(r => r.status === "completed").length,
    running: rows.filter(r => r.status === "running").length,
    error: rows.filter(r => r.status === "error").length,
  }), [rows]);

  const sites = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) if (!map.has(r.siteId)) map.set(r.siteId, hostOf(r.siteUrl));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  // Filters narrow the view; they never change what was fetched, and the empty state says
  // "no match" vs "nothing at all" so a narrow date range can't read as a lost history.
  const filtered = useMemo(() => {
    let list = rows;
    if (status !== "all") list = list.filter(r => r.status === status);
    if (siteId) list = list.filter(r => r.siteId === siteId);
    if (from) list = list.filter(r => r.startedAt.slice(0, 10) >= from);
    if (to) list = list.filter(r => r.startedAt.slice(0, 10) <= to);
    const score = (r: AuditHistoryRow): number =>
      sort === "issues" ? (r.pagesWithIssues ?? -1)
      : sort === "regressions" ? (r.verification?.regressions ?? -1)
      : sort === "health" ? (r.healthScore == null ? 101 : r.healthScore)
      : 0;
    const sorted = [...list];
    if (sort === "newest") sorted.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    else if (sort === "health") sorted.sort((a, b) => score(a) - score(b) || b.startedAt.localeCompare(a.startedAt));
    else sorted.sort((a, b) => score(b) - score(a) || b.startedAt.localeCompare(a.startedAt));
    return sorted;
  }, [rows, status, siteId, from, to, sort]);

  // A new filter or sort starts from the first page.
  useEffect(() => { setPage(0); }, [status, siteId, from, to, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const safePage = Math.min(page, pages - 1);
  const visible = useMemo(() => filtered.slice(safePage * PAGE, safePage * PAGE + PAGE), [filtered, safePage]);

  // Fleet: audited sites carry their settings on the history rows; never-audited ones
  // arrive in their own list. Search matches the host.
  const fleet = useMemo<FleetRow[]>(() => {
    const map = new Map<string, FleetRow>();
    for (const r of rows) {
      if (!map.has(r.siteId)) map.set(r.siteId, { id: r.siteId, url: r.siteUrl, auditSettings: r.siteAuditSettings, last: r });
    }
    for (const s of neverAudited) {
      if (!map.has(s.id)) map.set(s.id, { id: s.id, url: s.url, auditSettings: s.auditSettings ?? null, last: null });
    }
    const q = sitesSearch.trim().toLowerCase();
    return [...map.values()]
      .filter(f => !q || hostOf(f.url).toLowerCase().includes(q))
      .sort((a, b) => hostOf(a.url).localeCompare(hostOf(b.url)));
  }, [rows, neverAudited, sitesSearch]);

  const openSite = (url: string) => router.push(`/site/${siteRouteKey(url)}?tab=audit`);

  const healthColor = (score: number | null) =>
    score == null ? "var(--color-text-tertiary)" : score >= 80 ? "#34c759" : score >= 50 ? "#ff9f0a" : "#ff375f";

  const verifyTip = (v: NonNullable<AuditHistoryRow["verification"]>) =>
    `${t("auditVerifyResolved")}: ${v.resolved} · ${t("auditVerifyStill")}: ${v.stillPresent} · ${t("auditVerifyInconclusive")}: ${v.inconclusive}`;

  const FILTERS: { key: StatusFilter; labelKey: string; count: number }[] = [
    { key: "all", labelKey: "auditsGFilterAll", count: counts.all },
    { key: "queued", labelKey: "auditsGFilterQueued", count: counts.queued },
    { key: "completed", labelKey: "auditsGFilterCompleted", count: counts.completed },
    { key: "running", labelKey: "auditsGFilterRunning", count: counts.running },
    { key: "error", labelKey: "auditsGFilterError", count: counts.error },
  ];

  const inputStyle: React.CSSProperties = {
    padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--color-border)",
    background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px",
  };

  // ── Sites tab actions ─────────────────────────────────────────────────────────────

  const toggleSite = (id: string) => setSelected(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const selectFiltered = () => setSelected(new Set(fleet.map(f => f.id)));
  const clearSelection = () => setSelected(new Set());

  const runBulk = async () => {
    if (!selected.size || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/audit/bulk", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteIds: [...selected] }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { showNotice(String(d.error ?? "error")); return; }
      const skipped = Array.isArray(d.skipped) ? d.skipped.length : 0;
      showNotice(t("auditsBulkStarted").replace("{n}", String(d.created ?? 0)) + (skipped ? " " + t("auditsBulkSkipped").replace("{n}", String(skipped)) : ""));
      clearSelection();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const queueAction = async (action: "pause" | "resume" | "cancel" | "retryFailed") => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/audit/queue/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { showNotice(String(d.error ?? "error")); return; }
      if (action === "pause" || action === "resume") await loadSettings();
      if (action === "cancel") showNotice(t("auditsQueueCancelled").replace("{n}", String(d.cancelled ?? 0)));
      if (action === "retryFailed") showNotice(t("auditsQueueRetried").replace("{n}", String(d.retried ?? 0)));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const saveQueueSettings = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/audit/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queue: settingsDraft }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { showNotice(String(d.error ?? "error")); return; }
      if (d?.queue) { setQueueSettings(d.queue); setSettingsDraft(d.queue); }
      showNotice(t("auditsSettingsSaved"));
    } finally {
      setBusy(false);
    }
  };

  // Per-site interval select: "inherit" | "off" | a preset day count (sent as custom).
  const saveSiteInterval = async (siteId: string, value: string) => {
    const site = value === "inherit" || value === "off"
      ? { mode: value }
      : { mode: "custom", intervalDays: Number(value) };
    setRows(prev => prev.map(r => r.siteId === siteId
      ? { ...r, siteAuditSettings: JSON.stringify(site) } : r));
    setNeverAudited(prev => prev.map(s => s.id === siteId ? { ...s, auditSettings: JSON.stringify(site) } : s));
    const res = await fetch("/api/audit/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteId, site }),
    }).catch(() => null);
    if (!res || !res.ok) await load(); // revert the optimistic row on failure
  };

  const intervalValueOf = (auditSettings: string | null): string => {
    const s = parseSiteAuditSettings(auditSettings);
    if (s.mode === "off") return "off";
    if (s.mode === "custom") return String(s.intervalDays);
    return "inherit";
  };

  // Next audit: last finished + interval. Overdue dates render accented — that site runs
  // at the next schedule-hour window, and showing a stale silent date would read as
  // "scheduler forgot".
  const nextRunOf = (f: FleetRow): { text: string; overdue: boolean } | null => {
    const interval = siteIntervalDays(f.auditSettings, queueSettings);
    if (!interval) return null;
    const anchor = f.last?.finishedAt ?? f.last?.startedAt;
    if (!anchor) return { text: "—", overdue: true };
    const next = new Date(new Date(anchor).getTime() + interval * 86_400_000);
    const overdue = next.getTime() <= Date.now();
    return { text: next.toLocaleDateString(), overdue };
  };

  const numInput = (label: string, key: keyof AuditQueueSettings, min: number, max: number) => (
    <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
      {label}
      <input
        type="number" min={min} max={max} value={String(settingsDraft[key])}
        onChange={e => setSettingsDraft(d => ({ ...d, [key]: Math.min(max, Math.max(min, Number(e.target.value) || min)) }))}
        className="tool-input" style={{ ...inputStyle, width: "110px" }}
      />
    </label>
  );

  return (
    <div className="main-content">
      <div>
        <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px" }}>{t("auditsGTitle")}</h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("auditsGSub")}</p>
      </div>

      {/* Tab switch */}
      <div style={{ display: "flex", gap: "6px", marginBottom: "12px" }}>
        {([["history", "auditsTabHistory"], ["sites", "auditsTabSites"]] as const).map(([key, label]) => {
          const on = tab === key;
          return (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: "7px 14px", borderRadius: "8px", fontSize: "12px", fontWeight: on ? 700 : 500, cursor: "pointer",
              border: `1px solid ${on ? "var(--color-accent-blue)" : "var(--color-border)"}`,
              background: on ? "var(--color-accent-blue)" : "transparent",
              color: on ? "#fff" : "var(--color-text-secondary)",
            }}>
              {t(label)}
            </button>
          );
        })}
      </div>

      {notice && (
        <div style={{ marginBottom: "12px", padding: "9px 12px", borderRadius: "8px", fontSize: "12px", background: "rgba(59,130,246,0.1)", color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ flex: 1 }}>{notice}</span>
          <button onClick={() => setNotice("")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-tertiary)", display: "inline-flex" }}><X size={13} /></button>
        </div>
      )}

      {tab === "history" && (
      <div className="panel">
        {/* Filters: chips for status, selectors for site and order, dates on startedAt. */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "14px" }}>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {FILTERS.map(f => {
              const on = status === f.key;
              return (
                <button key={f.key} onClick={() => setStatus(f.key)} style={{
                  padding: "6px 12px", borderRadius: "8px", fontSize: "12px", fontWeight: on ? 700 : 500, cursor: "pointer",
                  border: "none", background: on ? "var(--color-accent-blue)" : "transparent",
                  color: on ? "#fff" : "var(--color-text-secondary)",
                }}>
                  {t(f.labelKey as any)} ({f.count})
                </button>
              );
            })}
          </div>
          <span style={{ flex: 1 }} />
          <select value={siteId} onChange={e => setSiteId(e.target.value)} className="tool-input" style={{ ...inputStyle, maxWidth: "220px" }}>
            <option value="">{t("auditsGFilterAll")} — {t("auditsGColSite")}</option>
            {sites.map(([id, host]) => <option key={id} value={id}>{host}</option>)}
          </select>
          <select value={sort} onChange={e => setSort(e.target.value as SortKey)} className="tool-input" style={inputStyle}>
            <option value="newest">{t("auditsGSortNewest")}</option>
            <option value="issues">{t("auditsGSortIssues")}</option>
            <option value="regressions">{t("auditsGSortRegressions")}</option>
            <option value="health">{t("auditsGSortHealth")}</option>
          </select>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} title={t("auditsGColStarted")} className="tool-input" style={inputStyle} />
          <input type="date" value={to} onChange={e => setTo(e.target.value)} title={t("auditsGColFinished")} className="tool-input" style={inputStyle} />
        </div>

        <div style={{ borderTop: "1px solid var(--color-border)" }}>
          {loading ? (
            <div style={{ padding: "40px", textAlign: "center", color: "var(--color-text-secondary)" }}><Loader2 size={18} className="spin" /></div>
          ) : counts.all === 0 ? (
            <div style={{ padding: "32px 12px", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>
              {t("auditsGEmpty")}
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: "32px 12px", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>
              {t("auditsGNoMatch")}
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--color-border)", color: "var(--color-text-secondary)", textAlign: "left" }}>
                    <th style={{ padding: "10px 14px" }}>{t("auditsGColSite")}</th>
                    <th style={{ padding: "10px 8px" }}>{t("auditsGColStarted")}</th>
                    <th style={{ padding: "10px 8px" }}>{t("auditsGColFinished")}</th>
                    <th style={{ padding: "10px 8px" }}>{t("auditsGColStatus")}</th>
                    <th style={{ padding: "10px 8px" }}>{t("auditsGColTrigger")}</th>
                    <th style={{ padding: "10px 8px" }}>{t("auditsGColPages")}</th>
                    <th style={{ padding: "10px 8px" }}>{t("auditsGColIssues")}</th>
                    <th style={{ padding: "10px 8px" }}>{t("auditsGColCritical")}</th>
                    <th style={{ padding: "10px 8px" }}>{t("auditsGColHealth")}</th>
                    <th style={{ padding: "10px 8px" }}>{t("auditsGColRegressions")}</th>
                    <th style={{ padding: "10px 14px" }} />
                  </tr>
                </thead>
                <tbody>
                  {visible.map(r => {
                    const regressions = r.verification?.regressions ?? null;
                    const triggerKey = r.trigger === "bulk" ? "auditsTriggerBulk" : r.trigger === "scheduled" ? "auditsTriggerScheduled" : r.trigger === "retry" ? "auditsTriggerRetry" : "auditsTriggerManual";
                    return (
                      <tr key={r.id} onClick={() => openSite(r.siteUrl)} title={t("auditsGOpen")}
                        style={{ borderBottom: "1px solid var(--color-border)", cursor: "pointer" }}>
                        <td style={{ padding: "8px 14px", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-text-primary)", fontWeight: 600 }}>
                          {hostOf(r.siteUrl)}
                        </td>
                        <td style={{ padding: "8px 8px", color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                          {new Date(r.startedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" } as Intl.DateTimeFormatOptions)}
                        </td>
                        <td style={{ padding: "8px 8px", color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>
                          {r.finishedAt ? new Date(r.finishedAt).toLocaleDateString() : "—"}
                        </td>
                        <td style={{ padding: "8px 8px", whiteSpace: "nowrap" }}>
                          {r.status === "running"
                            ? <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", color: "#ff9f0a", fontWeight: 700 }}><Loader2 size={12} className="spin" /> {t("auditRunning")}</span>
                            : r.status === "queued"
                              ? <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", color: "var(--color-text-secondary)", fontWeight: 700 }}><Clock size={12} /> {t("auditsGQueued")}</span>
                              : r.status === "completed"
                                ? <span style={{ color: "#34c759", fontWeight: 700 }}>✓</span>
                                : <span title={r.error ?? undefined} style={{ color: "#ff375f", fontWeight: 700 }}>✗</span>}
                        </td>
                        <td style={{ padding: "8px 8px" }}>
                          <span title={t("auditsGColTrigger")} style={{ padding: "2px 8px", borderRadius: "20px", fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
                            {t(triggerKey as any)}
                          </span>
                        </td>
                        <td style={{ padding: "8px 8px", color: "var(--color-text-primary)" }}>{r.pagesCrawled}</td>
                        <td style={{ padding: "8px 8px", color: (r.pagesWithIssues ?? 0) > 0 ? "var(--color-text-primary)" : "#34c759" }}>
                          {r.pagesWithIssues ?? "—"}
                        </td>
                        <td style={{ padding: "8px 8px", color: (r.criticalIssues ?? 0) > 0 ? "#ff375f" : "var(--color-text-tertiary)", fontWeight: (r.criticalIssues ?? 0) > 0 ? 700 : 400 }}>
                          {r.criticalIssues ?? "—"}
                        </td>
                        <td style={{ padding: "8px 8px", fontWeight: 800, color: healthColor(r.healthScore) }}>
                          {r.healthScore ?? "—"}
                        </td>
                        <td style={{ padding: "8px 8px" }}>
                          {regressions == null ? "—" : regressions > 0
                            ? <span title={verifyTip(r.verification!)} style={{ padding: "2px 8px", borderRadius: "20px", fontWeight: 700, fontSize: "11px", color: "#ff375f", background: "rgba(255,55,95,0.12)" }}>{regressions}</span>
                            : <span title={verifyTip(r.verification!)} style={{ color: "#34c759", fontWeight: 700 }}>✓</span>}
                        </td>
                        <td style={{ padding: "8px 14px", color: "var(--color-text-tertiary)" }}><ExternalLink size={12} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
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
      </div>
      )}

      {tab === "sites" && (
      <div className="panel">
        {/* Queue panel: live counts + operator controls. Pause stops new slots; flights land. */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "14px" }}>
          <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
            {t("auditsQueueRunning").replace("{n}", String(counts.running))} · {t("auditsQueueQueued").replace("{n}", String(counts.queued))}
          </span>
          {queueSettings.paused && (
            <span style={{ padding: "3px 9px", borderRadius: "20px", fontSize: "11px", fontWeight: 700, color: "#ff9f0a", background: "rgba(255,159,10,0.12)" }}>{t("auditsQueuePausedBadge")}</span>
          )}
          <span style={{ flex: 1 }} />
          <button onClick={() => queueAction(queueSettings.paused ? "resume" : "pause")} disabled={busy} style={actionBtn(false)}>
            {queueSettings.paused ? <><Play size={12} /> {t("auditsQueueResume")}</> : <><Pause size={12} /> {t("auditsQueuePause")}</>}
          </button>
          <button onClick={() => queueAction("cancel")} disabled={busy || counts.queued === 0} style={actionBtn(counts.queued === 0)}>
            <X size={12} /> {t("auditsQueueCancel")}
          </button>
          <button onClick={() => queueAction("retryFailed")} disabled={busy || counts.error === 0} style={actionBtn(counts.error === 0)}>
            <RefreshCw size={12} /> {t("auditsQueueRetry")}
          </button>
          <button onClick={() => { setSettingsOpen(v => !v); setSettingsDraft(queueSettings); }} style={actionBtn(false)}>
            <Settings2 size={12} /> {t("auditsSettingsTitle")}
          </button>
        </div>

        {/* Scheduler + queue knobs. Visible and described — a silent default is an unshipped feature. */}
        {settingsOpen && (
          <div style={{ marginBottom: "14px", padding: "12px 14px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "var(--color-bg)" }}>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "10px" }}>{t("auditsSettingsDesc")}</div>
            <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", alignItems: "flex-end" }}>
              {numInput(t("auditsSettingsConcurrency"), "concurrency", 1, 16)}
              {numInput(t("auditsSettingsInterval"), "defaultIntervalDays", 1, 365)}
              {numInput(t("auditsSettingsHour"), "scheduleHourUtc", 0, 23)}
              {numInput(t("auditsSettingsRetries"), "retryAttempts", 0, 5)}
              {numInput(t("auditsSettingsRetryDelay"), "retryDelayMin", 1, 1440)}
              <button onClick={saveQueueSettings} disabled={busy} style={primaryBtn(false)}>{t("auditsSettingsSave")}</button>
            </div>
          </div>
        )}

        {/* Bulk bar: search filters the fleet, select-all follows the filter, run queues one audit per selected site. */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "14px" }}>
          <input
            value={sitesSearch} onChange={e => setSitesSearch(e.target.value)} placeholder={t("auditsSitesSearch")}
            className="tool-input" style={{ ...inputStyle, width: "220px" }}
          />
          <button onClick={selectFiltered} style={actionBtn(false)}>{t("auditsSelectAll")}</button>
          <button onClick={clearSelection} disabled={!selected.size} style={actionBtn(!selected.size)}>{t("auditsSelectNone")}</button>
          <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
            {t("auditsSelected").replace("{n}", String(selected.size))}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={runBulk} disabled={!selected.size || busy} style={primaryBtn(!selected.size || busy)}>
            <Play size={12} /> {t("auditsBulkRun").replace("{n}", String(selected.size))}
          </button>
        </div>

        <div style={{ borderTop: "1px solid var(--color-border)" }}>
          {loading ? (
            <div style={{ padding: "40px", textAlign: "center", color: "var(--color-text-secondary)" }}><Loader2 size={18} className="spin" /></div>
          ) : fleet.length === 0 ? (
            <div style={{ padding: "32px 12px", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>
              {t("auditsGNoMatch")}
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--color-border)", color: "var(--color-text-secondary)", textAlign: "left" }}>
                    <th style={{ padding: "10px 8px", width: "34px" }}>
                      <input
                        type="checkbox" checked={fleet.length > 0 && selected.size >= fleet.length}
                        ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < fleet.length; }}
                        onChange={e => e.target.checked ? selectFiltered() : clearSelection()}
                      />
                    </th>
                    <th style={{ padding: "10px 14px" }}>{t("auditsGColSite")}</th>
                    <th style={{ padding: "10px 8px" }}>{t("auditsColLastAudit")}</th>
                    <th style={{ padding: "10px 8px" }}>{t("auditsGColHealth")}</th>
                    <th style={{ padding: "10px 8px" }}>{t("auditsColNextAudit")}</th>
                    <th style={{ padding: "10px 8px" }}>{t("auditsColInterval")}</th>
                    <th style={{ padding: "10px 8px" }}>{t("auditsGColStatus")}</th>
                    <th style={{ padding: "10px 14px" }} />
                  </tr>
                </thead>
                <tbody>
                  {fleet.map(f => {
                    const next = nextRunOf(f);
                    const intervalValue = intervalValueOf(f.auditSettings);
                    return (
                      <tr key={f.id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                        <td style={{ padding: "8px 8px" }}>
                          <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggleSite(f.id)} />
                        </td>
                        <td onClick={() => openSite(f.url)} title={t("auditsGOpen")} style={{ padding: "8px 14px", maxWidth: "240px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-text-primary)", fontWeight: 600, cursor: "pointer" }}>
                          {hostOf(f.url)}
                        </td>
                        <td style={{ padding: "8px 8px", color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                          {f.last?.finishedAt ? new Date(f.last.finishedAt).toLocaleDateString() : f.last ? t("auditRunning") : "—"}
                        </td>
                        <td style={{ padding: "8px 8px", fontWeight: 800, color: healthColor(f.last?.healthScore ?? null) }}>
                          {f.last?.healthScore ?? "—"}
                        </td>
                        <td style={{ padding: "8px 8px", whiteSpace: "nowrap", color: next?.overdue ? "#ff9f0a" : "var(--color-text-secondary)" }}>
                          {next ? next.text : "—"}
                        </td>
                        <td style={{ padding: "8px 8px" }} onClick={e => e.stopPropagation()}>
                          <select value={intervalValue} onChange={e => saveSiteInterval(f.id, e.target.value)} className="tool-input" style={{ ...inputStyle, padding: "4px 8px" }}>
                            <option value="inherit">{t("auditsIntervalInherit").replace("{n}", String(queueSettings.defaultIntervalDays))}</option>
                            <option value="off">{t("auditsIntervalOff")}</option>
                            {INTERVAL_CHOICES.map(d => <option key={d} value={String(d)}>{t("auditsIntervalDays").replace("{n}", String(d))}</option>)}
                          </select>
                        </td>
                        <td style={{ padding: "8px 8px", whiteSpace: "nowrap" }}>
                          {f.last?.status === "running"
                            ? <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", color: "#ff9f0a", fontWeight: 700 }}><Loader2 size={12} className="spin" /> {t("auditRunning")}</span>
                            : f.last?.status === "queued"
                              ? <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", color: "var(--color-text-secondary)", fontWeight: 700 }}><Clock size={12} /> {t("auditsGQueued")}</span>
                              : "—"}
                        </td>
                        <td onClick={() => openSite(f.url)} title={t("auditsGOpen")} style={{ padding: "8px 14px", color: "var(--color-text-tertiary)", cursor: "pointer" }}><ExternalLink size={12} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* The never-audited nudge lives on the Sites tab now: it is the same fleet view,
            and the checkboxes make acting on it one click instead of a per-site tour. */}
        {neverAudited.length > 0 && (
          <div style={{ marginTop: "14px", padding: "12px 14px", borderRadius: "var(--radius-md)", border: "1px dashed var(--color-border)", background: "var(--color-bg)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <ClipboardCheck size={14} color="var(--color-text-secondary)" />
              <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>
                {t("auditsGNeverTitle").replace("{n}", String(neverAudited.length))}
              </span>
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "10px" }}>{t("auditsGNeverSub")}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {neverAudited.map(s => (
                <button key={s.id} onClick={() => openSite(s.url)} title={t("auditsGOpen")} style={{
                  display: "inline-flex", alignItems: "center", gap: "6px", padding: "6px 11px", borderRadius: "8px",
                  border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)",
                  fontSize: "12px", cursor: "pointer",
                }}>
                  {hostOf(s.url)} <ExternalLink size={11} color="var(--color-text-tertiary)" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

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

function actionBtn(disabled?: boolean): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 12px", borderRadius: "8px",
    fontSize: "12px", fontWeight: 600, cursor: disabled ? "default" : "pointer",
    border: "1px solid var(--color-border)", background: "var(--color-card)",
    color: disabled ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
    opacity: disabled ? 0.5 : 1,
  };
}

function primaryBtn(disabled?: boolean): React.CSSProperties {
  return {
    ...actionBtn(disabled),
    border: "none", background: disabled ? "var(--color-border)" : "var(--color-accent-blue)", color: disabled ? "var(--color-text-tertiary)" : "#fff",
  };
}
