"use client";

// Workspace-wide audit history (the per-site Audit tab only ever listed one site's runs).
// This page answers the portfolio questions an operator actually has: which sites were audited
// and when, which were never audited at all, where the issue count jumped, which verification
// runs regressed. Rows are thin scalars extracted server-side (src/lib/audit/historyRows.ts) —
// the full report stays one click away in the site's Audit tab, where audits also get started.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, ClipboardCheck, ExternalLink, Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import type { AuditHistoryRow } from "@/lib/audit/historyRows";

type NeverAudited = { id: string; url: string };
type SortKey = "newest" | "issues" | "regressions" | "health";
type StatusFilter = "all" | "completed" | "running" | "error";

const PAGE = 50;

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

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

  useEffect(() => { load(); }, [load]);

  // A running audit crawls for minutes; refresh while any row is in flight, so progress and
  // freshly completed results appear without a manual reload.
  const hasRunning = rows.some(r => r.status === "running");
  useEffect(() => {
    if (!hasRunning) return;
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [hasRunning, load]);

  const counts = useMemo(() => ({
    all: rows.length,
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

  const openSite = (id: string) => router.push(`/site/${id}?tab=audit`);

  const healthColor = (score: number | null) =>
    score == null ? "var(--color-text-tertiary)" : score >= 80 ? "#34c759" : score >= 50 ? "#ff9f0a" : "#ff375f";

  const verifyTip = (v: NonNullable<AuditHistoryRow["verification"]>) =>
    `${t("auditVerifyResolved")}: ${v.resolved} · ${t("auditVerifyStill")}: ${v.stillPresent} · ${t("auditVerifyInconclusive")}: ${v.inconclusive}`;

  const FILTERS: { key: StatusFilter; labelKey: string; count: number }[] = [
    { key: "all", labelKey: "auditsGFilterAll", count: counts.all },
    { key: "completed", labelKey: "auditsGFilterCompleted", count: counts.completed },
    { key: "running", labelKey: "auditsGFilterRunning", count: counts.running },
    { key: "error", labelKey: "auditsGFilterError", count: counts.error },
  ];

  const inputStyle: React.CSSProperties = {
    padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--color-border)",
    background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <div>
        <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px" }}>{t("auditsGTitle")}</h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("auditsGSub")}</p>
      </div>

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

        {/* Sites the portfolio is missing audits for. On a large portfolio these rows matter
            more than the ones in the table: no audit means no data at all. Rendered whenever
            the list is non-empty — it is not reachable through the filters above by design. */}
        {neverAudited.length > 0 && (
          <div style={{ marginBottom: "14px", padding: "12px 14px", borderRadius: "var(--radius-md)", border: "1px dashed var(--color-border)", background: "var(--color-bg)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <ClipboardCheck size={14} color="var(--color-text-secondary)" />
              <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>
                {t("auditsGNeverTitle").replace("{n}", String(neverAudited.length))}
              </span>
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "10px" }}>{t("auditsGNeverSub")}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {neverAudited.map(s => (
                <button key={s.id} onClick={() => openSite(s.id)} title={t("auditsGOpen")} style={{
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
                    return (
                      <tr key={r.id} onClick={() => openSite(r.siteId)} title={t("auditsGOpen")}
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
                            : r.status === "completed"
                              ? <span style={{ color: "#34c759", fontWeight: 700 }}>✓</span>
                              : <span title={r.error ?? undefined} style={{ color: "#ff375f", fontWeight: 700 }}>✗</span>}
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
