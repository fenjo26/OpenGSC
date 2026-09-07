"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Boxes, Database, Globe2, History, Loader2, Plus, Radar, Search, Square, Star, Trash2, Upload } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import type { DropSource, DropStage } from "@/lib/drops/types";
import { usePersistedState } from "@/lib/usePersistedState";
import { getAhrefsDrKey } from "@/lib/seo/keys";
import { getMetricsCreds } from "@/lib/seo/metricsClient";

type Run = {
  id: string; label: string | null; source: string; sourceRef: string | null;
  total: number; skipped: number; createdAt: string;
};
type Candidate = {
  id: string; domain: string; tld: string; stage: DropStage;
  dr: number | null; refdomains: number | null; refdomainsDofollow: number | null;
  waybackSnapshots: number | null; score: number | null; lastCheckedAt: string | null;
  corroborated: boolean; lastError?: string | null;
};
type ImportSummary = {
  accepted: number; inserted: number; reattached: number;
  skipped: number; skipReport: Record<string, number>;
};

type SortField = "score" | "domain" | "createdAt" | "dr" | "refdomains" | "snapshots" | "checkedAt";
const PAGE_SIZES = [25, 50, 100, 200];

const SOURCES: { value: DropSource; key: string }[] = [
  { value: "csv", key: "dropsSourceCsv" },
  { value: "ahrefs_refdomains", key: "dropsSourceAhrefsRef" },
  { value: "ahrefs_broken", key: "dropsSourceAhrefsBroken" },
  { value: "crawler", key: "dropsSourceCrawler" },
  { value: "zone_diff", key: "dropsSourceZone" },
];

/**
 * Stages in funnel order, so the chip row reads as the pipeline rather than as an alphabetical
 * list of statuses. Colour carries the same meaning everywhere: green is a name we might buy,
 * grey is one that left the funnel, blue is still moving.
 */
const STAGES: { value: DropStage; key: string; color: string }[] = [
  { value: "ingested", key: "dropsStageIngested", color: "var(--color-text-secondary)" },
  { value: "dns_checked", key: "dropsStageDnsChecked", color: "var(--color-accent-blue)" },
  { value: "resolved_taken", key: "dropsStageResolvedTaken", color: "var(--color-text-tertiary)" },
  { value: "checking", key: "dropsStageChecking", color: "var(--color-accent-blue)" },
  { value: "available", key: "dropsStageAvailable", color: "var(--color-accent-green, #34c759)" },
  { value: "taken", key: "dropsStageTaken", color: "var(--color-text-tertiary)" },
  { value: "confirmed", key: "dropsStageConfirmed", color: "var(--color-accent-green, #34c759)" },
  { value: "rejected", key: "dropsStageRejected", color: "var(--color-text-tertiary)" },
  { value: "acquired", key: "dropsStageAcquired", color: "var(--color-accent-purple)" },
];

/** Rejection reasons the importer reports, in the order a user cares about them. */
const SKIP_KEYS: Record<string, string> = {
  ip_address: "dropsSkipIpAddress",
  duplicate: "dropsSkipDuplicate",
  no_dot: "dropsSkipNoDot",
  bad_characters: "dropsSkipBadCharacters",
  bad_label: "dropsSkipBadLabel",
  too_long: "dropsSkipTooLong",
  not_registrable: "dropsSkipNotRegistrable",
  empty: "dropsSkipEmpty",
};

/** Sortable columns, in table order. `field: null` marks a non-sorting column. */
const COLUMNS: { field: SortField | null; key: string; num?: boolean }[] = [
  { field: "domain", key: "dropsColDomain" },
  { field: null, key: "dropsStage" },
  { field: "dr", key: "dropsColDr", num: true },
  { field: "refdomains", key: "dropsColRefdomains", num: true },
  { field: "snapshots", key: "dropsColSnapshots", num: true },
  { field: "score", key: "dropsColScore", num: true },
  { field: "checkedAt", key: "dropsColChecked" },
];

const DEFAULT_DIR: Record<SortField, "asc" | "desc"> = {
  score: "desc", domain: "asc", createdAt: "desc", dr: "desc",
  refdomains: "desc", snapshots: "desc", checkedAt: "desc",
};

const isPageSize = (v: unknown): boolean => typeof v === "number" && PAGE_SIZES.includes(v);

export default function DropsPage() {
  const { t } = useLanguage();
  const tr = (k: string) => t(k as never) as string;

  const [runs, setRuns] = useState<Run[]>([]);
  const [rows, setRows] = useState<Candidate[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [notMigrated, setNotMigrated] = useState(false);
  const [loading, setLoading] = useState(true);

  const [runId, setRunId] = useState("");
  const [stage, setStage] = useState<"" | DropStage>("");
  const [tld, setTld] = useState("");
  const [q, setQ] = useState("");
  const [orderBy, setOrderBy] = useState<SortField>("score");
  const [orderDir, setOrderDir] = useState<"asc" | "desc">("desc");
  const [pageSize, setPageSize] = usePersistedState<number>("dropsPageSize", 50, isPageSize);
  const [offset, setOffset] = useState(0);

  // Selection. Two modes, like the reference catalogue this screen was modelled on: explicit
  // `ids` (the checked rows) and "all by filter" — when the user selects a filtered set of
  // 5 000 rows, they mean 5 000 rows, not the fifty on the page. The counter always shows the
  // truth about what a bulk action will touch.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllFilter, setSelectAllFilter] = useState(false);

  const [showImport, setShowImport] = useState(false);
  const [raw, setRaw] = useState("");
  const [label, setLabel] = useState("");
  const [source, setSource] = useState<DropSource>("csv");
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // DNS pre-filter progress. `dnsStop` is a ref, not state: the loop below reads it between
  // batches, and a state read there would be the value captured when the loop started.
  const [dnsBusy, setDnsBusy] = useState(false);
  const [dnsProgress, setDnsProgress] = useState<{ checked: number; retired: number; advanced: number; remaining: number } | null>(null);
  const dnsStop = useRef(false);

  // The registry stage. Same shape as the DNS loop and, deliberately, a separate control: it is
  // orders of magnitude slower and it is the one that talks to somebody else's servers.
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkProgress, setCheckProgress] = useState<{ checked: number; available: number; taken: number; deferred: number; uncheckable: number; remaining: number } | null>(null);
  const checkStop = useRef(false);

  // Enrichment (DR / Wayback / refdomains). One busy-flag family and one progress line — they
  // are free, free and paid respectively, but they share the shape "walk the target list in
  // bounded batches until it is done".
  const [enrichBusy, setEnrichBusy] = useState<"" | "dr" | "wayback" | "refs">("");
  const [enrichProgress, setEnrichProgress] = useState<{ done: number; total: number; updated: number } | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/drops/runs", { cache: "no-store" });
      const body = await res.json();
      if (body?.notMigrated) { setNotMigrated(true); return; }
      setRuns(Array.isArray(body) ? body : []);
    } catch { /* the run filter is a convenience; its failure must not blank the table */ }
  }, []);

  const loadRows = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ limit: String(pageSize), offset: String(offset), orderBy, order: orderDir });
      if (runId) p.set("runId", runId);
      if (stage) p.set("stage", stage);
      if (tld.trim()) p.set("tld", tld.trim());
      if (q.trim()) p.set("q", q.trim());
      const res = await fetch(`/api/drops/candidates?${p}`, { cache: "no-store" });
      const body = await res.json();
      if (body?.notMigrated) { setNotMigrated(true); setRows([]); setTotal(0); return; }
      setRows(Array.isArray(body.rows) ? body.rows : []);
      setTotal(body.total ?? 0);
      setCounts(body.counts ?? {});
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [runId, stage, tld, q, orderBy, orderDir, pageSize, offset]);

  // The rule guards against a setState that cascades a second render before paint. This one
  // cannot: every state write inside `loadRuns` happens after an awaited fetch, several ticks
  // later. The linter cannot see across the await, so the suppression is narrow and local.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadRuns(); }, [loadRuns]);
  // Debounced so typing in the search box does not fire a query per keystroke against a table
  // that can hold 50 000 rows.
  useEffect(() => {
    const id = setTimeout(() => { void loadRows(); }, 250);
    return () => clearTimeout(id);
  }, [loadRows]);

  // Any filter change invalidates the current page number — page 4 of the old result set is not
  // page 4 of the new one, and staying there shows an empty table for a filter that has matches.
  //
  // Reset during render rather than in an effect: an effect would let one render commit with the
  // new filter and the old offset, which is a real request for a page that may not exist, and it
  // trips react-hooks/set-state-in-effect besides.
  const filterKey = `${runId}|${stage}|${tld.trim()}|${q.trim()}|${orderBy}|${orderDir}|${pageSize}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    if (offset !== 0) setOffset(0);
  }

  const sortClick = (field: SortField) => {
    if (orderBy === field) {
      setOrderDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setOrderBy(field);
      setOrderDir(DEFAULT_DIR[field]);
    }
  };

  // The selection a bulk action will touch: explicit ids, or the whole filter with its count.
  // Enrichment alone never runs in filter mode — a "free DR" sweep over 50 000 rows takes
  // forever and a paid one bills for it, so it walks the selection or the visible page.
  const selectedCount = selectAllFilter ? total : selectedIds.size;
  const enrichTargets = () => {
    const base = selectedIds.size ? rows.filter(r => selectedIds.has(r.id)).map(r => r.domain) : rows.map(r => r.domain);
    return [...new Set(base)];
  };

  function toggleRow(id: string) {
    if (selectAllFilter) { setSelectAllFilter(false); setSelectedIds(new Set(rows.map(r => r.id))); return; }
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectAllFilter(false);
    setSelectedIds(new Set());
  }

  async function runImport() {
    if (!raw.trim() || importing) return;
    setImporting(true); setError(""); setSummary(null);
    try {
      const res = await fetch("/api/drops/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw, label: label.trim() || null, source }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "import_failed");
      setSummary(body);
      setRaw("");
      await loadRuns();
      await loadRows();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  /**
   * Walk a batch endpoint one slice at a time until the server says nothing is left.
   *
   * The loop lives here rather than on the server because each batch is durable on its own: a
   * closed tab costs the current batch and nothing else, and the user watches the count fall
   * instead of staring at one request that may or may not still be alive.
   */
  async function runDnsPrefilter() {
    if (dnsBusy) return;
    dnsStop.current = false;
    setDnsBusy(true); setError("");
    const totals = { checked: 0, retired: 0, advanced: 0, remaining: 0 };
    try {
      for (;;) {
        const res = await fetch("/api/drops/prefilter", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: runId || undefined }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || "prefilter_failed");
        totals.checked += body.checked ?? 0;
        totals.retired += body.retired ?? 0;
        totals.advanced += body.advanced ?? 0;
        totals.remaining = body.remaining ?? 0;
        setDnsProgress({ ...totals });
        if (body.done || body.checked === 0 || dnsStop.current) break;
      }
      await loadRows();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDnsBusy(false);
    }
  }

  async function runRegistryCheck(domains?: string[]) {
    if (checkBusy) return;
    checkStop.current = false;
    setCheckBusy(true); setError(""); setNotice("");
    const totals = { checked: 0, available: 0, taken: 0, deferred: 0, uncheckable: 0, remaining: 0 };
    try {
      for (;;) {
        const res = await fetch("/api/drops/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: runId || undefined, domains }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || "check_failed");
        totals.checked += body.checked ?? 0;
        totals.available += body.available ?? 0;
        totals.taken += body.taken ?? 0;
        totals.deferred += body.deferred ?? 0;
        totals.uncheckable += body.uncheckable ?? 0;
        totals.remaining = body.remaining ?? 0;
        setCheckProgress({ ...totals });
        // `done` also comes back when a whole batch was deferred — every zone in it is
        // throttled, and hammering them again in the same second would only deepen the backoff.
        if (body.done || body.checked === 0 || checkStop.current) break;
        await loadRows();
      }
      if (totals.uncheckable > 0) setNotice(tr("dropsCheckUncheckableNotice"));
      await loadRows();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckBusy(false);
    }
  }

  /** Shared walker for the three enrichment buttons: bounded slices until the list is done. */
  async function walkEnrichment(
    kind: "dr" | "wayback" | "refs",
    targets: string[],
    sliceSize: number,
    step: (slice: string[]) => Promise<number>,
  ) {
    setEnrichBusy(kind); setError(""); setNotice("");
    setEnrichProgress({ done: 0, total: targets.length, updated: 0 });
    let done = 0, updated = 0;
    try {
      for (let i = 0; i < targets.length; i += sliceSize) {
        const slice = targets.slice(i, i + sliceSize);
        updated += await step(slice);
        done += slice.length;
        setEnrichProgress({ done, total: targets.length, updated });
      }
      setNotice(tr("dropsEnrichDone").replace("{n}", String(updated)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnrichBusy("");
      await loadRows();
    }
  }

  async function persistMetrics(entries: { domain: string; dr?: number; refdomains?: number; backlinks?: number }[]) {
    if (!entries.length) return 0;
    const res = await fetch("/api/drops/metrics", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || "persist_failed");
    return body.updated ?? 0;
  }

  // Free DR via /api/dr: the 7-day DrCache there means re-running this is cheap, and rows the
  // endpoint does not know are simply skipped — a failed lookup must not clear a column.
  const enrichDr = () => walkEnrichment("dr", enrichTargets(), 60, async slice => {
    const key = getAhrefsDrKey();
    const res = await fetch(`/api/dr?domains=${encodeURIComponent(slice.join(","))}`,
      { headers: key ? { "x-ahrefs-dr-key": key } : {} });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || "dr_failed");
    const ratings = (body?.ratings ?? {}) as Record<string, { dr?: number }>;
    return persistMetrics(Object.entries(ratings).map(([domain, r]) => ({ domain, dr: r?.dr })));
  });

  // Wayback is served by the app itself in bounded 12-domain slices (see the wayback route).
  const enrichWayback = () => walkEnrichment("wayback", enrichTargets(), 12, async slice => {
    const res = await fetch("/api/drops/wayback", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains: slice }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || "wayback_failed");
    return body.updated ?? 0;
  });

  // Refdomains go through the existing paid metrics route, which owns the unit reservation and
  // the cap. Explicit creds, same pattern as the dashboard's DR chip: keys live in this browser.
  const enrichRefs = () => {
    const creds = getMetricsCreds();
    if (!creds.apiKey) { setError(tr("dropsEnrichNoKey")); return; }
    const n = enrichTargets().length;
    if (!window.confirm(tr("dropsEnrichRefsConfirm").replace("{n}", String(n)))) return;
    return walkEnrichment("refs", enrichTargets(), 25, async slice => {
      const res = await fetch("/api/metrics/domain", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domains: slice, fetch: true,
          provider: creds.provider, apiKey: creds.apiKey, baseUrl: creds.baseUrl, cap: creds.cap,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "metrics_failed");
      const metrics = (body?.metrics ?? {}) as Record<string, { refDomains?: number | null; backlinks?: number | null }>;
      return persistMetrics(Object.entries(metrics).map(([domain, m]) => ({
        domain, refdomains: m?.refDomains ?? undefined, backlinks: m?.backlinks ?? undefined,
      })));
    });
  };

  /** Bulk delete / star. `matchAll` hands the server the live filter for "выбрать все". */
  async function bulk(action: "delete" | "star" | "unstar") {
    if (action === "delete" && !window.confirm(tr("dropsConfirmDelete").replace("{n}", String(selectedCount)))) return;
    try {
      const payload = selectAllFilter
        ? { matchAll: true, action, filter: { runId: runId || "", stage: stage || "", tld: tld.trim(), q: q.trim() } }
        : { ids: [...selectedIds], action };
      const res = await fetch("/api/drops/candidates", {
        method: action === "delete" ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "bulk_failed");
      setNotice(action === "delete"
        ? tr("dropsDeleted").replace("{n}", String(body.deleted ?? 0))
        : tr("dropsStarred").replace("{n}", String(body.updated ?? 0)));
      clearSelection();
      await Promise.all([loadRows(), loadRuns()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const pageAllSelected = rows.length > 0 && rows.every(r => selectAllFilter || selectedIds.has(r.id));
  const togglePage = () => {
    if (selectAllFilter) { clearSelection(); return; }
    if (pageAllSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        rows.forEach(r => next.delete(r.id));
        return next;
      });
    } else {
      setSelectedIds(prev => new Set([...prev, ...rows.map(r => r.id)]));
    }
  };

  const zones = useMemo(() => [...new Set(rows.map(r => r.tld))].sort(), [rows]);
  const totalAll = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts]);
  const pageFrom = total === 0 ? 0 : offset + 1;
  const pageTo = Math.min(offset + pageSize, total);
  const lastPage = offset + pageSize >= total;

  const arrowFor = (field: SortField) =>
    orderBy === field ? (orderDir === "asc" ? "▲" : "▼") : "";

  return <div className="main-content" style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 20, paddingBottom: 40 }}>
    <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 22, margin: 0, color: "var(--color-text-primary)" }}>
          <Boxes size={20} /> {tr("dropsTitle")}
        </h1>
        <p style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 6, maxWidth: 820 }}>{tr("dropsSubtitle")}</p>
      </div>
      <button onClick={() => setShowImport(v => !v)} style={primaryBtn}>
        <Plus size={14} /> {tr("dropsImport")}
      </button>
    </div>

    {notMigrated && <div className="panel" style={{ color: "var(--color-accent-orange, #ff9f0a)", fontSize: 13 }}>
      <AlertTriangle size={15} style={{ verticalAlign: -2, marginRight: 6 }} />{tr("dropsNotMigrated")}
    </div>}

    {(error || notice) && <div className="panel" style={{ fontSize: 12.5, lineHeight: 1.6, display: "flex", flexDirection: "column", gap: 4 }}>
      {error && <div style={{ color: "#ff6b62" }}><AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />{error}</div>}
      {notice && <div style={{ color: "var(--color-accent-orange, #ff9f0a)" }}>{notice}</div>}
    </div>}

    {showImport && <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input className="tool-input" style={{ flex: 1, minWidth: 200 }} value={label}
          onChange={e => setLabel(e.target.value)} placeholder={tr("dropsLabelField")} />
        <select className="tool-input" style={{ width: 220 }} value={source}
          onChange={e => setSource(e.target.value as DropSource)}>
          {SOURCES.map(s => <option key={s.value} value={s.value}>{tr(s.key)}</option>)}
        </select>
      </div>
      <textarea className="tool-input" rows={8} value={raw} onChange={e => setRaw(e.target.value)}
        placeholder={tr("dropsImportPlaceholder")} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button onClick={runImport} disabled={importing || !raw.trim()} style={primaryBtn}>
          {importing ? <Loader2 className="spin" size={14} /> : <Upload size={14} />}
          {importing ? tr("dropsImporting") : tr("dropsImportRun")}
        </button>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{tr("dropsImportHint")}</span>
      </div>

      {/* Why rows were dropped, not just how many. A bare count reads as "the tool lost them". */}
      {summary && <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.7 }}>
        <b style={{ color: "var(--color-text-primary)" }}>{summary.accepted}</b> {tr("dropsAccepted")}
        {" · "}<b style={{ color: "var(--color-accent-green, #34c759)" }}>{summary.inserted}</b> {tr("dropsInserted")}
        {summary.reattached > 0 && <> · {summary.reattached} {tr("dropsReattached")}</>}
        {summary.skipped > 0 && <> · {summary.skipped} {tr("dropsSkipped")}</>}
        {summary.skipped > 0 && <div style={{ color: "var(--color-text-tertiary)" }}>
          {Object.entries(summary.skipReport)
            .sort((a, b) => b[1] - a[1])
            .map(([reason, n]) => `${n} — ${SKIP_KEYS[reason] ? tr(SKIP_KEYS[reason]) : reason}`)
            .join(" · ")}
        </div>}
      </div>}
    </div>}

    {/* The stage that makes the rest affordable, and the only one the user has to start by hand.
        It sits above the funnel because that is where its effect is read. */}
    {((counts.ingested ?? 0) > 0 || dnsBusy || dnsProgress) && <div className="panel" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <button onClick={dnsBusy ? () => { dnsStop.current = true; } : runDnsPrefilter} style={primaryBtn}>
        {dnsBusy ? <Square size={13} /> : <Radar size={14} />}
        {dnsBusy ? tr("dropsDnsStop") : tr("dropsRunDns")}
      </button>
      {(counts.ingested ?? 0) > 0 && <span style={{ fontSize: 12.5, color: "var(--color-text-secondary)" }}>
        <b style={{ color: "var(--color-text-primary)" }}>{(counts.ingested ?? 0).toLocaleString()}</b> {tr("dropsDnsPending")}
      </span>}
      {dnsBusy && <Loader2 className="spin" size={14} color="var(--color-text-tertiary)" />}
      {dnsProgress && <span style={{ fontSize: 12.5, color: "var(--color-text-secondary)" }}>
        {dnsProgress.checked.toLocaleString()} → <b style={{ color: "var(--color-text-tertiary)" }}>{dnsProgress.retired.toLocaleString()}</b> {tr("dropsDnsRetired")}
        {" · "}<b style={{ color: "var(--color-accent-green, #34c759)" }}>{dnsProgress.advanced.toLocaleString()}</b> {tr("dropsDnsAdvanced")}
      </span>}
      <span style={{ flex: 1, minWidth: 160, fontSize: 12, color: "var(--color-text-tertiary)" }}>{tr("dropsDnsHint")}</span>
    </div>}

    {((counts.dns_checked ?? 0) > 0 || checkBusy || checkProgress) && <div className="panel" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <button onClick={checkBusy ? () => { checkStop.current = true; } : () => void runRegistryCheck()} style={primaryBtn}>
        {checkBusy ? <Square size={13} /> : <Globe2 size={14} />}
        {checkBusy ? tr("dropsDnsStop") : tr("dropsRunCheck")}
      </button>
      {(counts.dns_checked ?? 0) > 0 && <span style={{ fontSize: 12.5, color: "var(--color-text-secondary)" }}>
        <b style={{ color: "var(--color-text-primary)" }}>{(counts.dns_checked ?? 0).toLocaleString()}</b> {tr("dropsCheckPending")}
      </span>}
      {checkBusy && <Loader2 className="spin" size={14} color="var(--color-text-tertiary)" />}
      {checkProgress && <span style={{ fontSize: 12.5, color: "var(--color-text-secondary)" }}>
        {checkProgress.checked.toLocaleString()} → <b style={{ color: "var(--color-accent-green, #34c759)" }}>{checkProgress.available.toLocaleString()}</b> {tr("dropsCheckFree")}
        {" · "}<b style={{ color: "var(--color-text-tertiary)" }}>{checkProgress.taken.toLocaleString()}</b> {tr("dropsCheckTaken")}
        {checkProgress.deferred > 0 && <> · <b style={{ color: "var(--color-accent-orange, #ff9f0a)" }}>{checkProgress.deferred.toLocaleString()}</b> {tr("dropsCheckDeferred")}</>}
        {checkProgress.uncheckable > 0 && <> · <b style={{ color: "var(--color-text-tertiary)" }}>{checkProgress.uncheckable.toLocaleString()}</b> {tr("dropsCheckUncheckable")}</>}
      </span>}
      <span style={{ flex: 1, minWidth: 200, fontSize: 12, color: "var(--color-text-tertiary)" }}>{tr("dropsCheckHint")}</span>
    </div>}

    {/* The funnel. Each chip is also the filter for its stage, because "show me those 1 910"
        is the only thing anyone wants to do after reading the number. */}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {STAGES.filter(s => (counts[s.value] ?? 0) > 0).map(s => {
        const active = stage === s.value;
        return <button key={s.value} onClick={() => setStage(active ? "" : s.value)} style={{
          display: "flex", alignItems: "center", gap: 7, padding: "7px 13px", borderRadius: 9,
          border: `1px solid ${active ? s.color : "var(--color-border)"}`,
          background: active ? "var(--color-card-hover)" : "var(--color-card)",
          color: "var(--color-text-secondary)", fontSize: 12, cursor: "pointer",
        }}>
          {tr(s.key)}
          <b style={{ color: s.color, fontWeight: 800 }}>{counts[s.value]}</b>
        </button>;
      })}
    </div>

    <div className="panel" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <Search size={16} color="var(--color-text-tertiary)" />
      <input className="tool-input" style={{ flex: 1, minWidth: 180 }} value={q}
        onChange={e => setQ(e.target.value)} placeholder={tr("dropsSearch")} />
      <select className="tool-input" style={{ width: 190 }} value={runId} onChange={e => setRunId(e.target.value)}>
        <option value="">{tr("dropsAllRuns")}</option>
        {runs.map(r => <option key={r.id} value={r.id}>
          {r.label || new Date(r.createdAt).toLocaleDateString()} · {r.total}
        </option>)}
      </select>
      <select className="tool-input" style={{ width: 150 }} value={tld} onChange={e => setTld(e.target.value)}>
        <option value="">{tr("dropsAllZones")}</option>
        {zones.map(z => <option key={z} value={z}>.{z}</option>)}
      </select>
    </div>

    {/* Enrichment. Every source states its cost up front: DR and Wayback are free, refdomains
        bill Ahrefs units and asks first. Acts on the selection, or on the visible page. */}
    {(rows.length > 0 || enrichBusy) && <div className="panel" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
      <span style={{ color: "var(--color-text-tertiary)" }}>{tr("dropsEnrichLabel")}</span>
      <button onClick={enrichDr} disabled={enrichBusy !== ""} style={ghostBtn}>
        {enrichBusy === "dr" ? <Loader2 className="spin" size={13} /> : <Star size={13} />}
        {enrichBusy === "dr" ? tr("dropsEnrichDrBusy") : tr("dropsEnrichDr")}
      </button>
      <button onClick={enrichWayback} disabled={enrichBusy !== ""} style={ghostBtn}>
        {enrichBusy === "wayback" ? <Loader2 className="spin" size={13} /> : <History size={13} />}
        {enrichBusy === "wayback" ? tr("dropsEnrichWaybackBusy") : tr("dropsEnrichWayback")}
      </button>
      <button onClick={enrichRefs} disabled={enrichBusy !== ""} style={ghostBtn}>
        {enrichBusy === "refs" ? <Loader2 className="spin" size={13} /> : <Database size={13} />}
        {enrichBusy === "refs" ? tr("dropsEnrichRefsBusy") : tr("dropsEnrichRefs")}
      </button>
      {enrichBusy && enrichProgress && <span style={{ color: "var(--color-text-secondary)" }}>
        {enrichProgress.done.toLocaleString()} / {enrichProgress.total.toLocaleString()} · <b>{enrichProgress.updated.toLocaleString()}</b> {tr("dropsEnrichUpdated")}
      </span>}
      <span style={{ flex: 1, minWidth: 160, color: "var(--color-text-tertiary)", fontSize: 12 }}>
        {tr("dropsAttribution")}
      </span>
    </div>}

    <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderBottom: "1px solid var(--color-border)", fontSize: 13, flexWrap: "wrap" }}>
        <b>{tr("dropsFiltered")}: {total.toLocaleString()}</b>
        {totalAll > 0 && <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
          {tr("dropsOfAll").replace("{n}", totalAll.toLocaleString())}
        </span>}
        {loading && <Loader2 className="spin" size={14} color="var(--color-text-tertiary)" />}
        <span style={{ flex: 1 }} />
        <button onClick={() => setSelectAllFilter(true)} disabled={total === 0} style={pagerBtn(total === 0)}>
          {tr("dropsSelectAllFilter").replace("{n}", total.toLocaleString())}
        </button>
        {selectedCount > 0 && <>
          <span style={{ fontSize: 12.5, color: "var(--color-text-primary)", fontWeight: 700 }}>
            {tr("dropsSelected").replace("{n}", selectedCount.toLocaleString())}
          </span>
          <button onClick={() => void bulk("delete")} style={pagerBtn(false)}>{tr("dropsBulkDelete")}</button>
          <button onClick={() => void bulk("star")} style={pagerBtn(false)}>{tr("dropsBulkStar")}</button>
          <button onClick={() => {
            const targets = selectAllFilter ? undefined : [...selectedIds];
            void runRegistryCheck(targets);
          }} style={pagerBtn(false)}>{tr("dropsBulkCheck")}</button>
          <button onClick={clearSelection} style={pagerBtn(false)}>{tr("dropsClearSelection")}</button>
        </>}
      </div>

      {!loading && rows.length === 0 && <div style={{ padding: 34, textAlign: "center", fontSize: 13, color: "var(--color-text-secondary)" }}>
        {tr("dropsEmpty")}
      </div>}

      {rows.length > 0 && <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: "var(--color-text-tertiary)", textAlign: "left" }}>
              <th style={{ ...th, width: 34 }}>
                <input type="checkbox" checked={pageAllSelected} onChange={togglePage}
                  aria-label={tr("dropsSelectPage")} style={{ cursor: "pointer" }} />
              </th>
              {COLUMNS.map(c => c.field
                ? <th key={c.field} onClick={() => sortClick(c.field!)}
                    title={tr("dropsSortHint")}
                    style={{ ...(c.num ? thNum : th), cursor: "pointer", userSelect: "none" }}>
                    {tr(c.key)}{arrowFor(c.field)}
                  </th>
                : <th key={c.key} style={c.num ? thNum : th}>{tr(c.key)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const s = STAGES.find(x => x.value === r.stage);
              const checked = selectAllFilter || selectedIds.has(r.id);
              return <tr key={r.id} style={{ borderTop: "1px solid var(--color-border)" }}>
                <td style={td}>
                  <input type="checkbox" checked={checked} onChange={() => toggleRow(r.id)}
                    aria-label={r.domain} style={{ cursor: "pointer" }} />
                </td>
                <td style={{ ...td, fontWeight: 600, color: "var(--color-text-primary)" }}>{r.domain}</td>
                <td style={td}>
                  <span style={{ color: s?.color ?? "var(--color-text-secondary)" }}>{s ? tr(s.key) : r.stage}</span>
                  {/* An `available` seen by one source only is not shown as free — it is shown as
                      needing another look. Everything downstream depends on that distinction. */}
                  {r.stage === "available" && !r.corroborated &&
                    <span title={tr("dropsUncorroborated")} style={{ marginLeft: 6, color: "var(--color-accent-orange, #ff9f0a)" }}>?</span>}
                  {r.lastError === "zone_uncheckable" &&
                    <span title={tr("dropsZoneUncheckable")} style={{ marginLeft: 6, color: "var(--color-text-tertiary)", cursor: "help" }}>⚖</span>}
                </td>
                <td style={tdNum}>{r.dr ?? "—"}</td>
                <td style={tdNum}>{r.refdomainsDofollow ?? r.refdomains ?? "—"}</td>
                <td style={tdNum} title={tr("dropsSnapshotsHint")}>{r.waybackSnapshots ?? "—"}</td>
                <td style={{ ...tdNum, fontWeight: 800, color: r.score != null ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}>
                  {r.score != null ? Math.round(r.score) : "—"}
                </td>
                <td style={{ ...td, color: "var(--color-text-tertiary)" }}>
                  {r.lastCheckedAt ? new Date(r.lastCheckedAt).toLocaleDateString() : tr("dropsNever")}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 14px", borderTop: "1px solid var(--color-border)", fontSize: 12, color: "var(--color-text-secondary)", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => setOffset(Math.max(0, offset - pageSize))} disabled={offset === 0} style={pagerBtn(offset === 0)}>
            ← {tr("dropsPrev")}
          </button>
          <span>{pageFrom.toLocaleString()}–{pageTo.toLocaleString()} / {total.toLocaleString()}</span>
          <button onClick={() => setOffset(offset + pageSize)} disabled={lastPage} style={pagerBtn(lastPage)}>
            {tr("dropsNext")} →
          </button>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 7 }}>
          {tr("dropsPerPage")}
          <select className="tool-input" style={{ width: 74 }} value={pageSize}
            onChange={e => setPageSize(Number(e.target.value))}>
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
    </div>
  </div>;
}

const primaryBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 7, padding: "8px 16px", borderRadius: 9,
  border: "none", background: "var(--color-accent-blue)", color: "#fff",
  fontSize: 13, fontWeight: 600, cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8,
  border: "1px solid var(--color-border)", background: "transparent",
  color: "var(--color-text-secondary)", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
};

const th: React.CSSProperties = { padding: "9px 14px", fontWeight: 600, whiteSpace: "nowrap" };
const thNum: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "9px 14px", color: "var(--color-text-secondary)", whiteSpace: "nowrap" };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

function pagerBtn(disabled: boolean): React.CSSProperties {
  return {
    border: "1px solid var(--color-border)", borderRadius: 7, background: "transparent",
    color: disabled ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
    padding: "5px 12px", fontSize: 12, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
  };
}
