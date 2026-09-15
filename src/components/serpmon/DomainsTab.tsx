"use client";

// Domains tab — who holds how many keywords, who is new/young/rising/falling/bounced. The age
// and DR loaders walk the bounded POST domains/enrich step in a client-side loop (each step is
// durable on its own; a closed tab costs the current step), with a Stop and an honest
// "no key" ending instead of a silent zero.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePersistedState } from "@/lib/usePersistedState";
import { YOUNG_HOST_MONTHS, type DomainRow, type DomainTag } from "@/lib/serpmon/types";
import {
  btnGhost, btnGhostDisabled, ErrorLine, fmtDate, getJson, pagerBtn, sendJson, tdNum, tdStyle,
  thStyle, trOf,
} from "./shared";

const PAGE_SIZE = 50;
const PRESETS = ["all", "new", "young", "rising", "falling", "bounced"] as const;
type Preset = (typeof PRESETS)[number];
const SORTS = ["keywords", "top10", "bestPos", "firstSeen", "age", "dr"] as const;
type Sort = (typeof SORTS)[number];

const isFlag = (v: unknown): boolean => v === "" || v === "1";
const isPreset = (v: unknown): boolean => typeof v === "string" && (PRESETS as readonly string[]).includes(v);
const isSort = (v: unknown): boolean => typeof v === "string" && (SORTS as readonly string[]).includes(v);

const PRESET_KEYS: Record<Preset, string> = {
  all: "serpmonPresetAll", new: "serpmonPresetNew", young: "serpmonPresetYoung",
  rising: "serpmonPresetRising", falling: "serpmonPresetFalling", bounced: "serpmonPresetBounced",
};

const TAG_KEYS: Record<DomainTag, string> = {
  new: "serpmonTagNew", young: "serpmonTagYoung", rising: "serpmonTagRising",
  falling: "serpmonTagFalling", bounced: "serpmonTagBounced", platform: "serpmonTagPlatform",
  own: "serpmonTagOwn",
};

const TAG_COLORS: Record<DomainTag, string> = {
  new: "var(--color-accent-blue)", young: "var(--color-accent-teal, #30b0c7)",
  rising: "var(--color-success)", falling: "var(--color-danger)",
  bounced: "var(--color-accent-orange)", platform: "var(--color-text-tertiary)",
  own: "var(--color-accent-purple, #bf5af2)",
};

export default function DomainsTab({ projectId, version, onOpenDomain }: {
  projectId: string;
  version: number;
  onOpenDomain: (host: string) => void;
}) {
  const { t } = useLanguage();
  const tr = trOf(t);

  const [rows, setRows] = useState<DomainRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // State rather than a formatted message: the load callback must not close over the
  // per-render t() — a new function every render would refetch the table forever.
  const [notMigrated, setNotMigrated] = useState(false);

  const [preset, setPreset] = usePersistedState<Preset>("serpmonPreset", "all", isPreset, "preset");
  const [q, setQ] = useState("");
  const [maxAge, setMaxAge] = useState(String(YOUNG_HOST_MONTHS));
  const [platforms, setPlatforms] = usePersistedState<string>("serpmonPlatformsDom", "", isFlag);
  const [sort, setSort] = usePersistedState<Sort>("serpmonSortDom", "keywords", isSort);
  const [page, setPage] = useState(0);

  // The enrich walkers. Stop flags are refs: the loop reads them between steps, and a state
  // read there would be the value captured when the loop started.
  const [enrichBusy, setEnrichBusy] = useState<"" | "age" | "dr">("");
  const [enrichProgress, setEnrichProgress] = useState<{ remaining: number; updated: number } | null>(null);
  const enrichStop = useRef(false);

  // Query string shared by the table load and the CSV export — the export must be exactly what
  // the user is looking at.
  const queryString = useMemo(() => {
    const p = new URLSearchParams({ sort, page: String(page + 1), pageSize: String(PAGE_SIZE) });
    if (preset !== "all") p.set("preset", preset);
    if (q.trim()) p.set("q", q.trim());
    if (preset === "young" && Number(maxAge) > 0) p.set("maxAgeMonths", String(Number(maxAge)));
    if (platforms === "1") p.set("includePlatforms", "1");
    return p;
  }, [preset, q, maxAge, platforms, sort, page]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { status, body } = await getJson(`/api/serp-monitor/projects/${projectId}/domains?${queryString}`);
      if (body.notMigrated) { setNotMigrated(true); setRows([]); setTotal(0); return; }
      setNotMigrated(false);
      if (status >= 400) { setError(String(body.error ?? status)); setRows([]); setTotal(0); return; }
      setError("");
      setRows(Array.isArray(body.rows) ? (body.rows as DomainRow[]) : []);
      setTotal(Number(body.total ?? 0));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, queryString]);

  // Debounced like every table load; all state writes land after the awaited fetch.
  useEffect(() => {
    const id = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(id);
  }, [load, version]);

  // A filter change leaves page N of the old result set meaningless — reset before the effect.
  const filterKey = `${preset}|${q.trim()}|${preset === "young" ? maxAge : ""}|${platforms}|${sort}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    if (page !== 0) setPage(0);
  }

  /**
   * Walk POST domains/enrich one bounded step at a time until `remaining` hits 0.
   * A step that updates nothing AND does not shrink `remaining` is the honest end — the rest
   * of the list is hosts whose zones have no public answer, and looping further would only
   * hammer the registries.
   */
  async function runEnrich(what: "age" | "dr") {
    if (enrichBusy) return;
    enrichStop.current = false;
    setEnrichBusy(what); setError(""); setNotice(""); setNotMigrated(false);
    setEnrichProgress({ remaining: 0, updated: 0 });
    let updated = 0;
    let prevRemaining = Number.POSITIVE_INFINITY;
    try {
      for (;;) {
        const { status, body } = await sendJson(`/api/serp-monitor/projects/${projectId}/domains/enrich`, "POST", { what });
        if (body.notMigrated) { setNotMigrated(true); break; }
        if (status >= 400) { setError(String(body.error ?? status)); break; }
        // The DR half rides on the free Ahrefs endpoint; without a key anywhere there is
        // nothing to loop for, and that must be said out loud rather than shown as "0 updated".
        if (body.keyFound === false) { setError(tr("serpmonNoDrKey")); break; }
        const remaining = Number(body.remaining ?? 0);
        updated += Number(body[what] ?? 0);
        setEnrichProgress({ remaining, updated });
        const stalled = remaining >= prevRemaining && remaining > 0;
        prevRemaining = remaining;
        if (remaining === 0 || stalled || enrichStop.current) break;
      }
      if (updated > 0) setNotice(tr("serpmonEnrichDone").replace("{n}", String(updated)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnrichBusy("");
      setEnrichProgress(null);
      await load();
    }
  }

  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  const ageCell = (r: DomainRow) => {
    if (r.ageMonths != null) {
      const v = r.ageMonths >= 24
        ? tr("serpmonAgeYears").replace("{n}", String(Math.round(r.ageMonths / 12)))
        : tr("serpmonAgeMonths").replace("{n}", String(r.ageMonths));
      return <span title={r.registeredAt ? fmtDate(r.registeredAt) : undefined}>{v}</span>;
    }
    if (r.ageError) {
      return <span title={tr("serpmonAgeUnknown")} style={{ color: "var(--color-text-tertiary)" }}>—</span>;
    }
    return <span style={{ color: "var(--color-text-tertiary)" }}>—</span>;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Presets + filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {PRESETS.map(p => (
          <button key={p} onClick={() => setPreset(p)}
            style={{
              padding: "6px 12px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${preset === p ? "var(--color-accent-blue)" : "var(--color-border)"}`,
              color: preset === p ? "var(--color-accent-blue)" : "var(--color-text-secondary)",
              background: "transparent", whiteSpace: "nowrap",
            }}>
            {tr(PRESET_KEYS[p])}
          </button>
        ))}
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--color-text-secondary)" }}>
          {tr("serpmonMaxAge")}
          <input type="number" min={1} max={360} value={maxAge} onChange={e => setMaxAge(e.target.value)}
            disabled={preset !== "young"}
            style={{
              width: 70, padding: "6px 8px", borderRadius: 8, border: "1px solid var(--color-border)",
              background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: 12.5,
              outline: "none", opacity: preset !== "young" ? 0.5 : 1, boxSizing: "border-box",
            }} />
        </label>
        <div style={{ position: "relative", flex: "1 1 160px", maxWidth: 260, marginLeft: "auto" }}>
          <Search size={13} style={{ position: "absolute", left: 10, top: 9, color: "var(--color-text-tertiary)" }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr("serpmonFilterDomain")}
            style={{
              width: "100%", padding: "8px 10px 8px 30px", borderRadius: 8,
              border: "1px solid var(--color-border)", background: "var(--color-card)",
              color: "var(--color-text-primary)", fontSize: 12.5, outline: "none", boxSizing: "border-box",
            }} />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--color-text-secondary)", cursor: "pointer" }}>
          <input type="checkbox" checked={platforms === "1"} onChange={e => setPlatforms(e.target.checked ? "1" : "")} />
          {tr("serpmonShowPlatforms")}
        </label>
      </div>

      {/* Loaders + export */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={enrichBusy ? () => { enrichStop.current = true; } : () => void runEnrich("age")}
          style={btnGhostDisabled(enrichBusy === "dr")}>
          {enrichBusy === "age" ? <Loader2 size={12} className="spin" /> : null}
          {enrichBusy === "age" ? tr("serpmonStop") : tr("serpmonLoadAge")}
        </button>
        <button onClick={enrichBusy ? () => { enrichStop.current = true; } : () => void runEnrich("dr")}
          style={btnGhostDisabled(enrichBusy === "age")}>
          {enrichBusy === "dr" ? <Loader2 size={12} className="spin" /> : null}
          {enrichBusy === "dr" ? tr("serpmonStop") : tr("serpmonLoadDr")}
        </button>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{tr("serpmonLoadFreeNote")}</span>
        {enrichProgress && (
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>
            {enrichBusy === "age" ? tr("serpmonLoadAge") : tr("serpmonLoadDr")}: {enrichProgress.updated} · {enrichProgress.remaining}
          </span>
        )}
        <a href={`/api/serp-monitor/projects/${projectId}/export?kind=domains&${queryString}`}
          style={{ ...btnGhost, textDecoration: "none", marginLeft: "auto" }}>
          {tr("serpmonExportDomains")}
        </a>
      </div>

      {notMigrated && (
        <div className="panel" style={{ color: "var(--color-accent-orange)", fontSize: 13 }}>
          {tr("serpmonNotMigrated")}
        </div>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
      {notice && (
        <div className="panel" style={{ fontSize: 12.5, color: "var(--color-success)" }}>{notice}</div>
      )}
      {loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--color-text-tertiary)" }}>
          <Loader2 size={12} className="spin" /> …
        </div>
      )}

      {/* Table */}
      <div className="panel" style={{ overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                {([
                  { key: "serpmonColHost", sort: null as Sort | null },
                  { key: "serpmonColAge", sort: "age" as Sort | null },
                  { key: "serpmonColDr", sort: "dr" as Sort | null },
                  { key: "serpmonColKeywords", sort: "keywords" as Sort | null },
                  { key: "serpmonColTop10", sort: "top10" as Sort | null },
                  { key: "serpmonColBest", sort: "bestPos" as Sort | null },
                  { key: "serpmonColAvg", sort: null as Sort | null },
                  { key: "serpmonColFirstSeen", sort: "firstSeen" as Sort | null },
                ]).map(c => (
                  <th key={c.key} style={c.sort ? { ...thStyle, cursor: "pointer" } : thStyle}
                    onClick={c.sort ? () => setSort(c.sort as Sort) : undefined}
                    title={c.sort ? c.key : undefined}>
                    {tr(c.key)}{c.sort && sort === c.sort ? " ↓" : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const delta = r.keywords - r.prevKeywords;
                return (
                  <tr key={r.hostId} onClick={() => onOpenDomain(r.host)} style={{ cursor: "pointer" }}
                    onMouseEnter={e => { e.currentTarget.style.background = "var(--color-card-hover)"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
                    <td style={{ ...tdStyle, color: "var(--color-text-primary)", maxWidth: 260, whiteSpace: "normal" }}>
                      <div style={{ overflowWrap: "anywhere" }}>{r.host}</div>
                      {r.tags.length > 0 && (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
                          {r.tags.map(tag => (
                            <span key={tag} style={{
                              fontSize: 10, fontWeight: 600, padding: "0 6px", borderRadius: 5,
                              border: `1px solid ${TAG_COLORS[tag]}`, color: TAG_COLORS[tag],
                            }}>
                              {tr(TAG_KEYS[tag])}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={tdStyle}>{ageCell(r)}</td>
                    <td style={tdNum}>{r.dr != null ? Math.round(r.dr) : <span style={{ color: "var(--color-text-tertiary)" }}>—</span>}</td>
                    <td style={tdNum}>
                      {r.keywords}
                      {delta !== 0 && (
                        <span style={{
                          marginLeft: 5, fontSize: 11, fontWeight: 600,
                          color: delta > 0 ? "var(--color-success)" : "var(--color-danger)",
                        }}>
                          {delta > 0 ? "+" : "−"}{Math.abs(delta)}
                        </span>
                      )}
                    </td>
                    <td style={tdNum}>{r.top10}</td>
                    <td style={tdNum}>{r.bestPos != null ? `#${r.bestPos}` : "—"}</td>
                    <td style={tdNum}>{r.avgPos != null ? r.avgPos.toFixed(1) : "—"}</td>
                    <td style={tdStyle} title={fmtDate(r.lastSeenAt)}>{fmtDate(r.firstSeenAt)}</td>
                  </tr>
                );
              })}
              {!loading && rows.length === 0 && !error && (
                <tr><td colSpan={8} style={{ ...tdStyle, textAlign: "center", padding: 22, color: "var(--color-text-tertiary)" }}>—</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
          borderTop: "1px solid var(--color-border)", fontSize: 12, color: "var(--color-text-secondary)", flexWrap: "wrap",
        }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pagerBtn(page === 0)}>
            ← {tr("serpmonPrev")}
          </button>
          <span style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{total.toLocaleString()}</span>
          <button onClick={() => setPage(p => p + 1)} disabled={page >= lastPage} style={pagerBtn(page >= lastPage)}>
            {tr("serpmonNext")} →
          </button>
        </div>
      </div>
    </div>
  );
}
