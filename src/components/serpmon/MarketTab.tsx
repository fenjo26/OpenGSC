"use client";

// Market tab — one row per keyword: leaders, host-level change chips, volatility, own position.
// Filters live in the URL (a filtered view is a link a colleague can open), the page number is
// plain state: any filter change resets to page 1 during render, before the effect fires —
// page 4 of the old result set is not page 4 of the new one.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Search } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePersistedState } from "@/lib/usePersistedState";
import type { MarketRow } from "@/lib/serpmon/types";
import { ChangeChips } from "./ChangeChip";
import {
  ErrorLine, getJson, pagerBtn, problemLabel, tdStyle, tdNum, thStyle, thNum,
  trOf, VolBar,
} from "./shared";

const PAGE_SIZE = 50;
const SORTS = ["keyword", "volatility", "changes"] as const;
type Sort = (typeof SORTS)[number];

const isStr = (v: unknown): boolean => typeof v === "string";
const isFlag = (v: unknown): boolean => v === "" || v === "1";
const isSort = (v: unknown): boolean => typeof v === "string" && (SORTS as readonly string[]).includes(v);
const isChanged = (v: unknown): boolean => v === "" || v === "1";

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ page: String(page + 1), pageSize: String(PAGE_SIZE), sort });
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
  }, [projectId, page, sort, q, host, group, changed]);

  // Debounced so typing in the filter box does not fire a query per keystroke.
  useEffect(() => {
    const id = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(id);
  }, [load, version]);

  // Any filter change invalidates the current page number, corrected during render so no
  // request ever goes out for a page that no longer exists.
  const filterKey = `${q}|${host}|${group}|${changed}|${sort}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    if (page !== 0) setPage(0);
  }

  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
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

      {/* Table */}
      <div className="panel" style={{ overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th style={thStyle}>{tr("serpmonColKeyword")}</th>
                <th style={thStyle}>{tr("serpmonColLeaders")}</th>
                <th style={thStyle}>{tr("serpmonColChanges")}</th>
                <th style={thStyle}>{tr("serpmonColVolatility")}</th>
                <th style={thNum}>{tr("serpmonColOwn")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.keywordId} onClick={() => onOpenKeyword(r.keywordId)}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--color-card-hover)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
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
                    {r.status === "failed" || r.status === "partial" ? (
                      // No chips off a failed/partial take: the problem line is the truth, and a
                      // "−host" off a burned proxy would be a fake storm (CONTRACT §0.1).
                      <span title={r.problem ? problemLabel(r.problem, tr) : tr("serpmonNoComparison")}
                        style={{ display: "inline-flex", alignItems: "center", gap: 5, color: r.status === "failed" ? "var(--color-danger)" : "var(--color-accent-orange)" }}>
                        <AlertTriangle size={12} />
                        <span style={{ fontSize: 11.5 }}>
                          {r.problem ? problemLabel(r.problem, tr) : tr("serpmonNoComparison")}
                        </span>
                      </span>
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
                <tr><td colSpan={5} style={{ ...tdStyle, textAlign: "center", padding: 22, color: "var(--color-text-tertiary)" }}>—</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
          padding: "10px 14px", borderTop: "1px solid var(--color-border)", fontSize: 12,
          color: "var(--color-text-secondary)", flexWrap: "wrap",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pagerBtn(page === 0)}>
              ← {tr("serpmonPrev")}
            </button>
            <span style={{ whiteSpace: "nowrap" }}>
              {tr("serpmonCountOf").replace("{shown}", total.toLocaleString()).replace("{total}", all.toLocaleString())}
            </span>
            <button onClick={() => setPage(p => p + 1)} disabled={page >= lastPage} style={pagerBtn(page >= lastPage)}>
              {tr("serpmonNext")} →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
