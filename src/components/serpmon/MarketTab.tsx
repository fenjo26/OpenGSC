"use client";

// Market tab — one row per keyword: leaders, host-level change chips, volatility, own position.
// Filters live in the URL (a filtered view is a link a colleague can open), the page number is
// plain state: any filter change resets to page 1 during render, before the effect fires —
// page 4 of the old result set is not page 4 of the new one.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Search, Trash2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePersistedState } from "@/lib/usePersistedState";
import type { MarketRow } from "@/lib/serpmon/types";
import { ChangeChips } from "./ChangeChip";
import { Pager } from "./Pager";
import {
  ErrorLine, getJson, sendJson, problemLabel, tdStyle, tdNum, thStyle, thNum,
  trOf, VolBar,
} from "./shared";

const DEFAULT_PAGE_SIZE = 50;
const SORTS = ["keyword", "volatility", "changes"] as const;
type Sort = (typeof SORTS)[number];

/** Theme-safe row shading: a whisper of the text color works on every palette. */
const ZEBRA_BG = "color-mix(in srgb, var(--color-text) 4%, transparent)";

const isStr = (v: unknown): boolean => typeof v === "string";
const isFlag = (v: unknown): boolean => v === "" || v === "1";
const isSort = (v: unknown): boolean => typeof v === "string" && (SORTS as readonly string[]).includes(v);
const isChanged = (v: unknown): boolean => v === "" || v === "1";
const isNum = (v: unknown): boolean => typeof v === "number";

export default function MarketTab({ projectId, groups, host, setHost, version, onOpenKeyword }: {
  projectId: string;
  groups: { name: string; count: number }[];
  /** Domain filter is owned by the project page: the Domains tab and chip clicks both land here. */
  host: string;
  setHost: (h: string) => void;
  /** Bumped when a run finishes — the tab reloads its data. */
  version: number;
  onOpenKeyword: (keywordId: string) => void;
}) {
  const { t } = useLanguage();
  const tr = trOf(t);

  const [rows, setRows] = useState<MarketRow[]>([]);
  const [total, setTotal] = useState(0);
  const [all, setAll] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // notMigrated is state, not a formatted message: the load callback must not depend on the
  // per-render t() closure (a new function every render would refetch the table forever).
  const [notMigrated, setNotMigrated] = useState(false);

  // URL-addressable filters (no localStorage: a stale keyword filter from last week is a
  // puzzle, not a convenience). changedOnly is the string "1"/"" so it round-trips through a
  // query param exactly as the API speaks it (changed=1).
  const [q, setQ] = usePersistedState<string>(null, "", isStr, "q");
  const [group, setGroup] = usePersistedState<string>(null, "", isStr, "group");
  const [changed, setChanged] = usePersistedState<string>(null, "", isChanged, "changed");
  const [sort, setSort] = usePersistedState<Sort>("serpmonSort", "keyword", isSort, "sort");
  // Display preferences persist locally only. Booleans ride as "1"/"" because usePersistedState
  // constrains its values to string|number (the URL path would not round-trip a boolean).
  const [platforms, setPlatforms] = usePersistedState<string>("serpmonPlatforms", "", isFlag);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = usePersistedState<number>("serpmonPageSize", DEFAULT_PAGE_SIZE, isNum);
  // Row selection for the bulk delete. Cleared whenever the table's shape changes (filter,
  // page, size) — checked boxes on page 3 must not silently apply to page 4's rows.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ page: String(page + 1), pageSize: String(pageSize), sort });
      if (q.trim()) p.set("q", q.trim());
      if (host.trim()) p.set("host", host.trim());
      if (group) p.set("group", group);
      if (changed === "1") p.set("changed", "1");
      const { status, body } = await getJson(`/api/serp-monitor/projects/${projectId}/market?${p}`);
      if (body.notMigrated) { setNotMigrated(true); setRows([]); setTotal(0); setAll(0); return; }
      setNotMigrated(false);
      if (status >= 400) { setError(String(body.error ?? status)); setRows([]); setTotal(0); setAll(0); return; }
      setError("");
      setRows(Array.isArray(body.rows) ? (body.rows as MarketRow[]) : []);
      setTotal(Number(body.total ?? 0));
      setAll(Number(body.all ?? 0));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, page, pageSize, sort, q, host, group, changed]);

  // Debounced so typing in the filter box does not fire a query per keystroke.
  useEffect(() => {
    const id = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(id);
  }, [load, version]);

  // Any filter (or page/size) change invalidates the current page number and the selection,
  // corrected during render so no request ever goes out for a page that no longer exists.
  const filterKey = `${q}|${host}|${group}|${changed}|${sort}|${page}|${pageSize}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    if (page !== 0) setPage(0);
    if (selected.size) setSelected(new Set());
    if (confirmDelete) setConfirmDelete(false);
  }

  /** Hard-deletes the selected keywords and every snapshot hanging off them (API cascades). */
  async function deleteSelected() {
    setDeleting(true);
    try {
      const { status, body } = await sendJson(`/api/serp-monitor/projects/${projectId}/keywords`, "DELETE", { ids: [...selected] });
      if (status >= 400) { setError(String(body.error ?? status)); return; }
      setNotice(tr("serpmonDeleted").replace("{n}", String(body.removed ?? selected.size)));
      setSelected(new Set());
      setConfirmDelete(false);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }
  const sortOptions = [
    { v: "keyword" as Sort, label: tr("serpmonColKeyword") },
    { v: "volatility" as Sort, label: tr("serpmonColVolatility") },
    { v: "changes" as Sort, label: tr("serpmonColChanges") },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 200px", maxWidth: 320 }}>
          <Search size={13} style={{ position: "absolute", left: 10, top: 9, color: "var(--color-text-tertiary)" }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr("serpmonFilterQuery")}
            style={{
              width: "100%", padding: "8px 10px 8px 30px", borderRadius: 8,
              border: "1px solid var(--color-border)", background: "var(--color-card)",
              color: "var(--color-text-primary)", fontSize: 12.5, outline: "none", boxSizing: "border-box",
            }} />
        </div>
        <input value={host} onChange={e => setHost(e.target.value)} placeholder={tr("serpmonFilterDomain")}
          style={{
            flex: "0 1 200px", padding: "8px 10px", borderRadius: 8,
            border: "1px solid var(--color-border)", background: "var(--color-card)",
            color: "var(--color-text-primary)", fontSize: 12.5, outline: "none", boxSizing: "border-box",
          }} />
        <select value={group} onChange={e => setGroup(e.target.value)}
          style={{
            padding: "8px 10px", borderRadius: 8, border: "1px solid var(--color-border)",
            background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: 12.5, cursor: "pointer",
          }}>
          <option value="">{tr("serpmonFilterGroup")}</option>
          {groups.map(g => <option key={g.name} value={g.name}>{g.name} ({g.count})</option>)}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--color-text-secondary)", cursor: "pointer" }}>
          <input type="checkbox" checked={changed === "1"} onChange={e => setChanged(e.target.checked ? "1" : "")} />
          {tr("serpmonChangedOnly")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--color-text-secondary)", cursor: "pointer" }}>
          <input type="checkbox" checked={platforms === "1"} onChange={e => setPlatforms(e.target.checked ? "1" : "")} />
          {tr("serpmonShowPlatforms")}
        </label>
        <select value={sort} onChange={e => setSort(e.target.value as Sort)}
          style={{
            marginLeft: "auto", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--color-border)",
            background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: 12.5, cursor: "pointer",
          }}>
          {sortOptions.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}
        </select>
      </div>

      {notMigrated && (
        <div className="panel" style={{ color: "var(--color-accent-orange)", fontSize: 13 }}>
          <AlertTriangle size={15} style={{ verticalAlign: -2, marginRight: 6 }} />{tr("serpmonNotMigrated")}
        </div>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
      {notice && <div className="panel" style={{ fontSize: 12.5, color: "var(--color-accent-blue)", padding: "8px 12px" }}>{notice}</div>}
      {selected.size > 0 && !confirmDelete && (
        <div className="panel" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, flexWrap: "wrap", padding: "8px 12px" }}>
          <span style={{ color: "var(--color-text-secondary)" }}>{tr("serpmonSelected").replace("{n}", String(selected.size))}</span>
          <button onClick={() => setConfirmDelete(true)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 8,
              border: "1px solid var(--color-border)", background: "var(--color-card)", cursor: "pointer",
              fontSize: 12.5, color: "var(--color-danger)",
            }}>
            <Trash2 size={13} /> {tr("serpmonDeleteSelected")}
          </button>
          <button onClick={() => setSelected(new Set())}
            style={{
              padding: "5px 10px", borderRadius: 8, border: "1px solid var(--color-border)",
              background: "var(--color-card)", cursor: "pointer", fontSize: 12.5, color: "var(--color-text-secondary)",
            }}>
            {tr("serpmonCancel")}
          </button>
        </div>
      )}
      {confirmDelete && (
        <div className="panel" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, flexWrap: "wrap", padding: "8px 12px" }}>
          <span style={{ color: "var(--color-text-primary)" }}>{tr("serpmonDeleteSelectedConfirm").replace("{n}", String(selected.size))}</span>
          <button onClick={() => setConfirmDelete(false)}
            style={{
              padding: "5px 10px", borderRadius: 8, border: "1px solid var(--color-border)",
              background: "var(--color-card)", cursor: "pointer", fontSize: 12.5, color: "var(--color-text-secondary)",
            }}>
            {tr("serpmonCancel")}
          </button>
          <button onClick={() => void deleteSelected()} disabled={deleting}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 8,
              border: "1px solid var(--color-danger)", background: "var(--color-danger)", cursor: deleting ? "wait" : "pointer",
              fontSize: 12.5, color: "#fff", opacity: deleting ? 0.6 : 1,
            }}>
            <Trash2 size={13} /> {tr("serpmonDeleteSelected")}
          </button>
        </div>
      )}

      {/* Table */}
      <div className="panel" style={{ overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: 30 }}>
                  <input type="checkbox" title={tr("serpmonSelected").replace("{n}", String(rows.length))}
                    checked={rows.length > 0 && rows.every(r => selected.has(r.keywordId))}
                    onChange={e => {
                      const next = new Set(selected);
                      if (e.target.checked) rows.forEach(r => next.add(r.keywordId));
                      else rows.forEach(r => next.delete(r.keywordId));
                      setSelected(next);
                    }} />
                </th>
                <th style={thStyle}>{tr("serpmonColKeyword")}</th>
                <th style={thStyle}>{tr("serpmonColLeaders")}</th>
                <th style={thStyle}>{tr("serpmonColChanges")}</th>
                <th style={thStyle}>{tr("serpmonColVolatility")}</th>
                <th style={thNum}>{tr("serpmonColOwn")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rowIdx) => (
                <tr key={r.keywordId} onClick={() => onOpenKeyword(r.keywordId)}
                  style={{ cursor: "pointer", background: rowIdx % 2 ? ZEBRA_BG : "transparent" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--color-card-hover)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = rowIdx % 2 ? ZEBRA_BG : "transparent"; }}>
                  <td style={{ ...tdStyle, width: 30 }} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(r.keywordId)}
                      onChange={e => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(r.keywordId);
                        else next.delete(r.keywordId);
                        setSelected(next);
                      }} />
                  </td>
                  <td style={{ ...tdStyle, color: "var(--color-text-primary)", maxWidth: 260 }}>
                    <div style={{ overflowWrap: "anywhere" }}>{r.keyword}</div>
                    {r.group && <div style={{ fontSize: 10.5, color: "var(--color-text-tertiary)" }}>{r.group}</div>}
                  </td>
                  <td style={{ ...tdStyle, maxWidth: 240, whiteSpace: "normal" }}>
                    {r.leaders.length
                      ? r.leaders.map((h, i) => (
                        <span key={`${h}-${i}`} style={{
                          display: "inline-block", maxWidth: 110, overflow: "hidden",
                          textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom",
                          marginRight: 6, fontSize: 11.5, color: "var(--color-text-secondary)",
                        }}>{h}</span>
                      ))
                      : <span style={{ color: "var(--color-text-tertiary)" }}>—</span>}
                  </td>
                  <td style={{ ...tdStyle, maxWidth: 420, whiteSpace: "normal" }}>
                    {r.status === "failed" ? (
                      // No chips off a failed take: the problem line is the truth, and a
                      // "−host" off a burned proxy would be a fake storm (CONTRACT §0.1). A
                      // partial take DID take part in the comparison, so its chips are real
                      // and stay visible.
                      <>
                        <span title={r.detail || (r.problem ? problemLabel(r.problem, tr) : tr("serpmonNoComparison"))}
                          style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--color-danger)" }}>
                          <AlertTriangle size={12} />
                          <span style={{ fontSize: 11.5 }}>
                            {r.problem ? problemLabel(r.problem, tr) : tr("serpmonNoComparison")}
                          </span>
                        </span>
                        {r.detail && (
                          <div title={r.detail} style={{
                            // Two lines, not one: the cause ("Ban proxy …") follows the verdict and
                            // was cut off by a single-line ellipsis. Full text stays in the tooltip.
                            fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 2,
                            maxWidth: 520, overflow: "hidden", overflowWrap: "anywhere",
                            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                          }}>{r.detail}</div>
                        )}
                      </>
                    ) : r.changes.length ? (
                      <ChangeChips changes={r.changes} showPlatforms={platforms === "1"} onHostClick={setHost} />
                    ) : (
                      <span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)" }}>{tr("serpmonNoChanges")}</span>
                    )}
                  </td>
                  <td style={tdStyle}><VolBar v={r.volatility} /></td>
                  <td style={tdNum}>
                    {r.own
                      ? <span title={r.own.host} style={{ color: "var(--color-accent-blue)", fontWeight: 600 }}>#{r.own.position}</span>
                      : <span style={{ color: "var(--color-text-tertiary)" }}>—</span>}
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && !error && (
                <tr><td colSpan={6} style={{ ...tdStyle, textAlign: "center", padding: 22, color: "var(--color-text-tertiary)" }}>—</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--color-border)" }}>
          <Pager page={page} pageSize={pageSize} total={total}
            onPage={p => setPage(p)}
            onPageSize={n => { setPageSize(n); setPage(0); }}
            extra={
              <span style={{ fontSize: 12, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                {tr("serpmonCountOf").replace("{shown}", total.toLocaleString()).replace("{total}", all.toLocaleString())}
              </span>
            } />
        </div>
      </div>
    </div>
  );
}
