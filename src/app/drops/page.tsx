"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BadgeCheck, Boxes, ChevronDown, ChevronRight, CircleHelp, Database, Globe2, History, Link2, Loader2, Pencil, Plus, Radar, RefreshCw, Search, ShieldAlert, Sparkles, Square, Star, Upload, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import type { DropSource, DropStage } from "@/lib/drops/types";
// Pure parsing, no server imports — the same function the route uses, so the columns the preview
// promises are the columns the import reads. Two implementations would drift within a week.
import { parseDomainRows } from "@/lib/drops/ingest";
import { usePersistedState } from "@/lib/usePersistedState";
import { getMetricsCreds } from "@/lib/seo/metricsClient";
import { DrSparkline, drSeriesText, type DrPoint } from "@/components/DrSparkline";
import BacklinkProfile from "@/components/BacklinkProfile";

type Run = {
  id: string; label: string | null; source: string; sourceRef: string | null;
  total: number; skipped: number; createdAt: string;
};
type Group = { id: string; name: string; count: number; createdAt: string };
type Candidate = {
  id: string; domain: string; tld: string; stage: DropStage;
  dr: number | null; refdomains: number | null; refdomainsDofollow: number | null;
  majesticTf: number | null; majesticCf: number | null;
  waybackSnapshots: number | null; score: number | null; lastCheckedAt: string | null;
  corroborated: boolean; watched: boolean; lastError?: string | null;
  historyVerdict?: string | null; historyNote?: string | null;
  groupId?: string | null; groupName?: string | null;
};
type ImportSummary = {
  runId: string;
  accepted: number; inserted: number; reattached: number;
  skipped: number; skipReport: Record<string, number>;
  /** Rows whose DR / refdomains rode in from the file instead of being bought again. */
  metricsFromFile?: number;
};

type StoredProxy = {
  id: string; kind: "http" | "socks5"; host: string; port: number;
  username: string | null; enabled: boolean; label: string;
  lastOkAt: string | null; lastCheckedAt: string | null; lastError: string | null; failures: number;
};

type SortField = "score" | "domain" | "createdAt" | "dr" | "refdomains" | "snapshots" | "checkedAt" | "tf";
const PAGE_SIZES = [25, 50, 100, 200];

/**
 * The AI history verdict, as the row badge shows it. The note travels in the tooltip: a verdict
 * without its "was a school site, parked since 2019" is just a coloured dot.
 */
const HISTORY_VERDICTS: Record<string, { key: string; color: string; Icon: typeof History }> = {
  clean: { key: "dropsHistoryVerdictClean", color: "var(--color-accent-green, #34c759)", Icon: BadgeCheck },
  topic_shift: { key: "dropsHistoryVerdictTopicShift", color: "var(--color-accent-orange, #ff9f0a)", Icon: RefreshCw },
  spam_period: { key: "dropsHistoryVerdictSpam", color: "#ff6b62", Icon: ShieldAlert },
  unknown: { key: "dropsHistoryVerdictUnknown", color: "var(--color-text-tertiary)", Icon: CircleHelp },
};

/** Row-level failure codes the AI history route reports, mapped to words. Unknown codes show raw. */
const HISTORY_ERRORS: Record<string, string> = {
  wayback_throttled: "dropsHistoryErrThrottled",
  wayback_unreachable: "dropsHistoryErrWayback",
  deadline: "dropsHistoryErrDeadline",
  not_a_domain: "dropsHistoryErrNotDomain",
};

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
  { value: "no_registry", key: "dropsStageNoRegistry", color: "var(--color-accent-orange, #ff9f0a)" },
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
  { field: "tf", key: "dropsColTf", num: true },
  { field: "snapshots", key: "dropsColSnapshots", num: true },
  { field: "score", key: "dropsColScore", num: true },
  { field: "checkedAt", key: "dropsColChecked" },
];

const DEFAULT_DIR: Record<SortField, "asc" | "desc"> = {
  score: "desc", domain: "asc", createdAt: "desc", dr: "desc",
  refdomains: "desc", snapshots: "desc", checkedAt: "desc", tf: "desc",
};

const isPageSize = (v: unknown): boolean => typeof v === "number" && PAGE_SIZES.includes(v);

/** One rendered table fragment: either a group's header row or a candidate row. */
type Segment = { kind: "group"; id: string; name: string; pageRows: number; pageSelected: number } | { kind: "row"; r: Candidate; stripe: number };

/** Mirrors EXCLUDE_MAX in lib/drops/store: the server refuses a longer exclusion list. */
const EXCLUDE_MAX = 500;

export default function DropsPage() {
  const { t } = useLanguage();
  const tr = (k: string) => t(k as never) as string;

  const [runs, setRuns] = useState<Run[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [rows, setRows] = useState<Candidate[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [notMigrated, setNotMigrated] = useState(false);
  const [loading, setLoading] = useState(true);

  const [runId, setRunId] = useState("");
  const [stage, setStage] = useState<"" | DropStage>("");
  const [tld, setTld] = useState("");
  const [q, setQ] = useState("");
  const [watched, setWatchedFilter] = useState<"" | "1">("");
  // Numeric ranges. Empty input = no bound on that side; "нет DR" is deliberately its own
  // checkbox rather than the bottom of the DR range, because "—" means never enriched and a
  // deletion sweep must not eat rows that were simply never asked. These travel verbatim to
  // the list query and to every "выбрать все по фильтру" bulk action.
  const [drMin, setDrMin] = useState("");
  const [drMax, setDrMax] = useState("");
  const [drNullOnly, setDrNullOnly] = useState(false);
  const [refMin, setRefMin] = useState("");
  const [refMax, setRefMax] = useState("");
  const [tfMin, setTfMin] = useState("");
  const [tfMax, setTfMax] = useState("");
  const [groupId, setGroupId] = useState("");
  const [orderBy, setOrderBy] = useState<SortField>("score");
  const [orderDir, setOrderDir] = useState<"asc" | "desc">("desc");
  const [pageSize, setPageSize] = usePersistedState<number>("dropsPageSize", 50, isPageSize);
  const [offset, setOffset] = useState(0);

  // Selection is ONE flat set of row ids, and every control adds to or removes from it:
  // a row checkbox its own row, a group checkbox exactly its group's rows (fetched by id, so
  // rows on other pages select too), the header tri-state the page and then the whole filter.
  // No scope ever clears another — "check the group" must not uncheck anything else, which the
  // previous mutually-exclusive design did and the user rightly called a data trap.
  //
  // `selectAllFilter` is the one special scope ("every row matching the filter", server-side,
  // pagination-independent). `fullGroups` remembers groups whose ENTIRE membership was pulled
  // into the set (gid → total at selection time), so the checkbox can show checked even for
  // rows it cannot see; the marker self-heals when a group's size changes.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllFilter, setSelectAllFilter] = useState(false);
  const [fullGroups, setFullGroups] = useState<Record<string, number>>({});
  /**
   * The holes in "выделить всё": with `selectAllFilter` on, these ids are the rows the user
   * unchecked afterwards. Unchecking used to collapse the scope to whatever rows happened to be
   * on screen, silently dropping the selection on every other page; the scope now survives and
   * the exclusions travel to the server with the filter. Capped to match the API's own cap —
   * beyond it the request would be refused, so the click is refused first, with a reason.
   */
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());

  /** Every id of a group, from the server — a group checkbox owns the whole group, all pages. */
  const fetchGroupIds = async (gid: string): Promise<string[]> => {
    const res = await fetch(`/api/drops/candidates?groupId=${encodeURIComponent(gid)}&limit=500&orderBy=domain&order=asc`, { cache: "no-store" });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || "group_failed");
    if ((body.total ?? 0) > 500) throw new Error(tr("dropsGroupTooBig"));
    return ((body.rows ?? []) as { id: string }[]).map(r => r.id);
  };

  // Which row's donor profile is expanded under the table.
  const [openLinks, setOpenLinks] = useState<string | null>(null);

  const [showImport, setShowImport] = useState(false);
  const [raw, setRaw] = useState("");
  /** Name of the dropped file, purely so the user can see WHICH export is in the box. */
  const [fileName, setFileName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  /** Hand-picked column indexes, when the detected header was wrong or absent. */
  const [colOverride, setColOverride] = useState<{ domain?: number; dr?: number; refdomains?: number }>({});
  const [showHow, setShowHow] = useState(false);
  const [showProxies, setShowProxies] = useState(false);
  const [proxies, setProxies] = useState<StoredProxy[]>([]);
  const [proxyRaw, setProxyRaw] = useState("");
  const [proxyBusy, setProxyBusy] = useState<"add" | "check" | null>(null);
  const [proxyNote, setProxyNote] = useState("");
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

  // Enrichment (DR / Wayback / TF/CF / refdomains). One busy-flag family and one progress
  // line — they are free, free, cheap and paid respectively, but they share the shape "walk
  // the target list in bounded batches until it is done". `enrichStop` is a ref, not state:
  // the walkers read it between batches, and a state read there would be the value captured
  // when the loop started.
  const [enrichBusy, setEnrichBusy] = useState<"" | "dr" | "wayback" | "refs" | "history" | "tf">("");
  const [enrichProgress, setEnrichProgress] = useState<{ done: number; total: number; updated: number } | null>(null);
  const enrichStop = useRef(false);

  // DR also moves without being asked, dashboard-style: the visible page's unrated domains go
  // out in the background, and a fresh import starts a run-wide sweep. Two one-way guards keep
  // that polite — a domain is auto-attempted once per session, and one "no key anywhere" answer
  // mutes auto attempts for the session (the manual button still says "настроить ключ" out loud
  // when actually pressed).
  const autoDrTried = useRef<Set<string>>(new Set());
  const autoDrNoKey = useRef(false);
  const [drKeyMissing, setDrKeyMissing] = useState(false);

  // The panel's own monthly DR series per domain (DrSnapshot), read for the visible page. It
  // turns the bare DR number into the veto signal: 22→8 over months is a filter, not decay.
  // Like auto-DR above, each domain is asked once per session and the answer only ever adds.
  const [drHist, setDrHist] = useState<Record<string, DrPoint[]>>({});
  const drHistTried = useRef<Set<string>>(new Set());

  /** Collapsed group headers. Session-only on purpose: a stray click on "+/−" must heal on
   * refresh, not survive it — a persisted collapse once read as "the table lost its rows". */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleCollapsed = (id: string) => setCollapsed(prev => ({ ...prev, [id]: !prev[id] }));

  /** The group whose id list is in flight. One click at a time: a second click landing before
   * the fetch resolves would apply a stale `full` and undo the first. */
  const [groupBusy, setGroupBusy] = useState<string | null>(null);

  // The group checkbox owns EXACTLY its group's domains: clicking it merges every id of the
  // group into the selection (fetched server-side, so rows on other pages are covered) or
  // removes exactly those ids again — whatever else was selected, inside or outside other
  // groups, stays exactly as it was. When "everything by filter" is on, removing one group
  // converts that scope to an explicit selection of the visible rows outside the group, since
  // "everything minus one group" cannot ride the matchAll payload.
  const toggleGroupSelection = async (gid: string, full: boolean, totalIn: number) => {
    if (groupBusy) return;
    setGroupBusy(gid);
    try {
      // Every id first, THEN one batched state transition. The old order dropped the
      // "whole group" marker before awaiting the fetch, so the box rendered a partial state
      // mid-click and the clear looked like it needed an extra click to take.
      const ids = await fetchGroupIds(gid);
      if (!full) {
        // Under "выделить всё" a group reads as unchecked only because its rows are holes;
        // ticking it fills them back in rather than starting a second, competing selection.
        if (selectAllFilter) {
          setExcludedIds(prev => {
            const n = new Set(prev);
            for (const i of ids) n.delete(i);
            return n;
          });
          return;
        }
        setSelectedIds(prev => {
          const n = new Set(prev);
          for (const i of ids) n.add(i);
          return n;
        });
        setFullGroups(prev => ({ ...prev, [gid]: totalIn }));
        return;
      }
      if (selectAllFilter) {
        // Punch the group out of the filter-wide scope and stay in it. Collapsing to the
        // visible page here is what used to lose every selected row on the other pages.
        if (excludedIds.size + ids.length > EXCLUDE_MAX) {
          setError(tr("dropsTooManyExclusions").replace("{n}", String(EXCLUDE_MAX)));
          return;
        }
        setExcludedIds(prev => {
          const n = new Set(prev);
          for (const i of ids) n.add(i);
          return n;
        });
        return;
      }
      setFullGroups(prev => {
        if (!(gid in prev)) return prev;
        const n = { ...prev };
        delete n[gid];
        return n;
      });
      setSelectedIds(prev => {
        const n = new Set(prev);
        for (const i of ids) n.delete(i);
        return n;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGroupBusy(null);
    }
  };

  const loadProxies = useCallback(async () => {
    try {
      const res = await fetch("/api/drops/proxies", { cache: "no-store" });
      const body = await res.json();
      if (Array.isArray(body?.proxies)) setProxies(body.proxies);
    } catch { /* the pool is an optimisation; its absence must not break the page */ }
  }, []);

  /** One shape for every pool action: they all answer with the refreshed list. */
  async function proxyAction(init: RequestInit, busy: "add" | "check" | null = null) {
    if (proxyBusy) return null;
    setProxyBusy(busy); setError(""); setProxyNote("");
    try {
      const res = await fetch("/api/drops/proxies", {
        headers: { "Content-Type": "application/json" }, ...init,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error === "no_proxies" ? tr("dropsProxyNoneParsed") : (body?.error || "proxy_failed"));
      if (Array.isArray(body?.proxies)) setProxies(body.proxies);
      return body;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setProxyBusy(null);
    }
  }

  async function addProxies() {
    if (!proxyRaw.trim()) return;
    const body = await proxyAction({ method: "POST", body: JSON.stringify({ action: "add", raw: proxyRaw }) }, "add");
    if (!body) return;
    setProxyRaw("");
    const skipped = Array.isArray(body.skipped) ? body.skipped.length : 0;
    setProxyNote(tr("dropsProxyAdded")
      .replace("{n}", String(body.added ?? 0))
      .replace("{u}", String(body.updated ?? 0))
      .replace("{s}", String(skipped)));
  }

  async function checkProxies() {
    const body = await proxyAction({ method: "POST", body: JSON.stringify({ action: "check" }) }, "check");
    if (!body) return;
    setProxyNote(tr("dropsProxyChecked")
      .replace("{alive}", String(body.alive ?? 0))
      .replace("{n}", String(body.checked ?? 0)));
  }

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/drops/runs", { cache: "no-store" });
      const body = await res.json();
      if (body?.notMigrated) { setNotMigrated(true); return; }
      setRuns(Array.isArray(body) ? body : []);
    } catch { /* the run filter is a convenience; its failure must not blank the table */ }
  }, []);

  const loadGroups = useCallback(async () => {
    try {
      const res = await fetch("/api/drops/groups", { cache: "no-store" });
      const body = await res.json();
      if (Array.isArray(body)) setGroups(body);
    } catch { /* the group filter is a convenience; its failure must not blank the table */ }
  }, []);

  /**
   * The numeric/group filter fields, as the API speaks them. One object feeds the list query,
   * every "выбрать все по фильтру" bulk action and the bulk registry check — the set the table
   * shows and the set a bulk action touches can then never disagree.
   */
  const numericFilterParams = useMemo(() => ({
    ...(drMin.trim() !== "" ? { drMin: drMin.trim() } : {}),
    ...(drMax.trim() !== "" ? { drMax: drMax.trim() } : {}),
    ...(drNullOnly ? { drNull: "1" } : {}),
    ...(refMin.trim() !== "" ? { refMin: refMin.trim() } : {}),
    ...(refMax.trim() !== "" ? { refMax: refMax.trim() } : {}),
    ...(tfMin.trim() !== "" ? { tfMin: tfMin.trim() } : {}),
    ...(tfMax.trim() !== "" ? { tfMax: tfMax.trim() } : {}),
    ...(groupId && groupId !== "none" ? { groupId } : {}),
    ...(groupId === "none" ? { ungrouped: "1" } : {}),
  }), [drMin, drMax, drNullOnly, refMin, refMax, tfMin, tfMax, groupId]);

  const loadRows = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ limit: String(pageSize), offset: String(offset), orderBy, order: orderDir });
      if (runId) p.set("runId", runId);
      if (stage) p.set("stage", stage);
      if (tld.trim()) p.set("tld", tld.trim());
      if (q.trim()) p.set("q", q.trim());
      if (watched) p.set("watched", watched);
      for (const [k, v] of Object.entries(numericFilterParams)) p.set(k, v);
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
  }, [runId, stage, tld, q, watched, numericFilterParams, orderBy, orderDir, pageSize, offset]);

  // The rule guards against a setState that cascades a second render before paint. This one
  // cannot: every state write inside `loadRuns` happens after an awaited fetch, several ticks
  // later. The linter cannot see across the await, so the suppression is narrow and local.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadRuns(); void loadGroups(); void loadProxies(); }, [loadRuns, loadGroups, loadProxies]);
  // Debounced so typing in the search box does not fire a query per keystroke against a table
  // that can hold 50 000 rows.
  useEffect(() => {
    const id = setTimeout(() => { void loadRows(); }, 250);
    return () => clearTimeout(id);
  }, [loadRows]);

  // Dashboard parity for the DR column: whatever the table is showing gets filled in by itself,
  // the same way /api/dr fills the dashboard cards — silently, from DrCache where possible, in
  // 60-domain batches. It only ever touches the visible page; sweeping a whole run is the
  // import sweep's job, and while any enrichment is running the walkers own the pipeline.
  // The setRows inside fires only after an awaited fetch, so it cannot cascade a second render
  // before paint — the shape the set-state-in-effect rule actually worries about.
  useEffect(() => {
    if (notMigrated || enrichBusy || autoDrNoKey.current) return;
    const targets = rows
      .filter(r => r.dr == null && !autoDrTried.current.has(r.domain))
      .map(r => r.domain);
    if (!targets.length) return;
    targets.forEach(d => autoDrTried.current.add(d));
    let cancelled = false;
    (async () => {
      for (let i = 0; i < targets.length; i += 60) {
        if (cancelled) return;
        try {
          const res = await fetch("/api/drops/dr", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domains: targets.slice(i, i + 60) }),
          });
          const body = await res.json();
          if (!res.ok) return;
          if (body.keyFound === false) { autoDrNoKey.current = true; setDrKeyMissing(true); return; }
          const ratings = (body?.ratings ?? {}) as Record<string, number>;
          if (Object.keys(ratings).length && !cancelled) {
            setRows(prev => prev.map(r => (ratings[r.domain] != null ? { ...r, dr: ratings[r.domain] } : r)));
          }
        } catch { return; }
      }
    })();
    return () => { cancelled = true; };
  }, [rows, enrichBusy, notMigrated]);

  // DR history for the visible page — same one-ask-per-session batch shape as auto-DR. The
  // route is a pure local read (DrSnapshot), so it neither spends anything nor needs a key;
  // domains with no stored series are simply absent from the response.
  useEffect(() => {
    if (notMigrated) return;
    const targets = [...new Set(rows.map(r => r.domain))].filter(d => !drHistTried.current.has(d));
    if (!targets.length) return;
    targets.forEach(d => drHistTried.current.add(d));
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/dr/history?domains=${encodeURIComponent(targets.join(","))}`);
        if (!res.ok) return;
        const body = await res.json();
        const hist = (body?.history ?? {}) as Record<string, DrPoint[]>;
        if (!cancelled && Object.keys(hist).length) setDrHist(prev => ({ ...prev, ...hist }));
      } catch { /* decorative until it exists */ }
    })();
    return () => { cancelled = true; };
  }, [rows, notMigrated]);

  // Any filter change invalidates the current page number — page 4 of the old result set is not
  // page 4 of the new one, and staying there shows an empty table for a filter that has matches.
  //
  // Reset during render rather than in an effect: an effect would let one render commit with the
  // new filter and the old offset, which is a real request for a page that may not exist, and it
  // trips react-hooks/set-state-in-effect besides.
  const filterKey = `${runId}|${stage}|${tld.trim()}|${q.trim()}|${watched}|${JSON.stringify(numericFilterParams)}|${orderBy}|${orderDir}|${pageSize}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    if (offset !== 0) setOffset(0);
  }

  // "Выделить всё" is a filter, not a list of rows: leaving it on across a filter change would
  // silently re-point the selection at a different set, and the next Delete would take rows the
  // user never saw. Explicit ids name concrete rows and survive; the filter-wide scope does not.
  // Sorting and page size are deliberately outside this key — they reorder, they do not reselect.
  const scopeKey = `${runId}|${stage}|${tld.trim()}|${q.trim()}|${watched}|${JSON.stringify(numericFilterParams)}`;
  const [lastScopeKey, setLastScopeKey] = useState(scopeKey);
  if (scopeKey !== lastScopeKey) {
    setLastScopeKey(scopeKey);
    if (selectAllFilter) {
      setSelectAllFilter(false);
      setExcludedIds(new Set());
      setFullGroups({});
    }
  }

  const sortClick = (field: SortField) => {
    if (orderBy === field) {
      setOrderDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setOrderBy(field);
      setOrderDir(DEFAULT_DIR[field]);
    }
  };

  /**
   * The current table filter, as a bulk-action body speaks it. `matchAll` actions and the bulk
   * registry check both send this, so "выбрать все по фильтру" always means the same rows the
   * table is showing — whichever filters are set.
   */
  const filterPayload = () => ({
    ...(runId ? { runId } : {}),
    ...(stage ? { stage } : {}),
    ...(tld.trim() ? { tld: tld.trim() } : {}),
    ...(q.trim() ? { q: q.trim() } : {}),
    ...(watched ? { watched } : {}),
    ...numericFilterParams,
  });

  // The selection a bulk action will touch, and its exact size: unique ids, or the whole
  // filter count. Enrichment never runs in the filter-wide pass — a "free DR" sweep over
  // 50 000 rows takes forever and a paid one bills for it, so it walks the selection or the
  // visible page.
  const selectedCount = selectAllFilter ? Math.max(0, total - excludedIds.size) : selectedIds.size;
  /** The one truth about a row's checkbox, used by the table, the group headers and the counter. */
  const isRowSelected = useCallback(
    (id: string) => (selectAllFilter ? !excludedIds.has(id) : selectedIds.has(id)),
    [selectAllFilter, excludedIds, selectedIds],
  );
  const enrichTargets = () => {
    const base = selectAllFilter || selectedIds.size
      ? rows.filter(r => isRowSelected(r.id)).map(r => r.domain)
      : rows.map(r => r.domain);
    return [...new Set(base)];
  };

  function toggleRow(id: string) {
    if (selectAllFilter) {
      // "Everything" survives an unchecked row — it just grows a hole. The scope stays
      // filter-wide, so the rows selected on pages the user never opened stay selected.
      if (!excludedIds.has(id) && excludedIds.size >= EXCLUDE_MAX) {
        setError(tr("dropsTooManyExclusions").replace("{n}", String(EXCLUDE_MAX)));
        return;
      }
      setExcludedIds(prev => {
        const n = new Set(prev);
        if (n.has(id)) n.delete(id); else n.add(id);
        return n;
      });
      return;
    }
    const wasChecked = selectedIds.has(id);
    const groupId = rows.find(r => r.id === id)?.groupId ?? null;
    setSelectedIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
    // Unchecking one member breaks the "whole group selected" marker — the checkbox must not
    // keep claiming full coverage it no longer has.
    if (wasChecked && groupId) {
      setFullGroups(prev => (groupId in prev ? (() => { const n = { ...prev }; delete n[groupId]; return n; })() : prev));
    }
  }

  function clearSelection() {
    setSelectAllFilter(false);
    setSelectedIds(new Set());
    setFullGroups({});
    setExcludedIds(new Set());
  }

  /** Everything the current filter matches, across every page. Explicit ids, group markers and
   *  holes all go — the filter-wide scope subsumes them. */
  function selectAll() {
    setSelectAllFilter(true);
    setSelectedIds(new Set());
    setFullGroups({});
    setExcludedIds(new Set());
  }

  /**
   * Read a dropped export as text, guessing the encoding rather than assuming UTF-8.
   *
   * Ahrefs writes UTF-16LE with a BOM by default. `readAsText` at UTF-8 turns that into a wall
   * of NUL-separated characters, every row is rejected as bad_characters, and the file looks
   * broken. The BOM is three bytes of certainty — read it before deciding.
   */
  async function readExport(file: File): Promise<string> {
    const buf = new Uint8Array(await file.arrayBuffer());
    const encoding =
      buf[0] === 0xff && buf[1] === 0xfe ? "utf-16le"
        : buf[0] === 0xfe && buf[1] === 0xff ? "utf-16be"
          : "utf-8";
    return new TextDecoder(encoding).decode(buf).replace(/^\uFEFF/, "");
  }

  async function acceptFile(file: File | null | undefined) {
    if (!file) return;
    setError("");
    try {
      const text = await readExport(file);
      setRaw(text);
      setFileName(file.name);
      setColOverride({});
      setSummary(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * What the import is about to do, computed in the browser from the same parser the server runs.
   * Shown BEFORE the button, because the failure this guards against is silent: pick the wrong
   * column on an Outgoing-links export and the whole file collapses into the donor domain.
   */
  const preview = useMemo(() => {
    if (!raw.trim()) return null;
    const parsed = parseDomainRows(raw, colOverride);
    return {
      columns: parsed.columns,
      rows: parsed.rows.length,
      skipped: parsed.skipped.length,
      withDr: parsed.rows.filter(r => r.dr != null).length,
      sample: parsed.rows.slice(0, 5).map(r => r.domain),
    };
  }, [raw, colOverride]);

  async function runImport() {
    if (!raw.trim() || importing) return;
    setImporting(true); setError(""); setSummary(null);
    try {
      const res = await fetch("/api/drops/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw, label: label.trim() || null, source,
          ...(Object.keys(colOverride).length ? { columns: colOverride } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "import_failed");
      setSummary(body);
      setRaw("");
      setFileName("");
      setColOverride({});
      await loadRuns();
      await loadRows();
      // The import's own DR pass, in the background: reattached rows keep their old rating, so
      // only what actually lacks one gets asked. Fire-and-forget — the sweep owns the same
      // progress line as the manual buttons and stops the same way.
      const expected = Number(body.inserted ?? 0) + Number(body.reattached ?? 0);
      if (expected > 0 && typeof body.runId === "string") void sweepDr(body.runId, expected);
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

  async function runRegistryCheck(domains?: string[], filter?: Record<string, string>, exclude?: string[]) {
    if (checkBusy) return;
    checkStop.current = false;
    setCheckBusy(true); setError(""); setNotice("");
    const totals = { checked: 0, available: 0, taken: 0, deferred: 0, uncheckable: 0, remaining: 0 };
    try {
      for (;;) {
        const res = await fetch("/api/drops/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: runId || undefined, domains, filter, exclude }),
        });
        const body = await res.json();
        if (!res.ok) {
          if (body?.error === "too_many_exclusions") {
            throw new Error(tr("dropsTooManyExclusions").replace("{n}", String(body?.max ?? EXCLUDE_MAX)));
          }
          throw new Error(body?.error || "check_failed");
        }
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

  /** Shared walker for the enrichment buttons: bounded slices until the list is done. */
  async function walkEnrichment(
    kind: "dr" | "wayback" | "refs" | "tf",
    targets: string[],
    sliceSize: number,
    step: (slice: string[]) => Promise<number>,
  ) {
    enrichStop.current = false;
    setEnrichBusy(kind); setError(""); setNotice("");
    setEnrichProgress({ done: 0, total: targets.length, updated: 0 });
    let done = 0, updated = 0;
    try {
      for (let i = 0; i < targets.length; i += sliceSize) {
        if (enrichStop.current) break;
        const slice = targets.slice(i, i + sliceSize);
        updated += await step(slice);
        done += slice.length;
        setEnrichProgress({ done, total: targets.length, updated });
      }
      setNotice(enrichStop.current
        ? tr("dropsEnrichStopped").replace("{n}", String(updated))
        : tr("dropsEnrichDone").replace("{n}", String(updated)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnrichBusy("");
      await loadRows();
    }
  }

  async function persistMetrics(entries: { domain: string; dr?: number; refdomains?: number; backlinks?: number; tf?: number; cf?: number }[]) {
    if (!entries.length) return 0;
    const res = await fetch("/api/drops/metrics", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || "persist_failed");
    return body.updated ?? 0;
  }

  // Free DR via /api/drops/dr: the server resolves the key itself (free DR key, paid Ahrefs
  // key as fallback) and writes both its DrCache and the candidates — so the button works in
  // any browser, and says "настроить ключ" out loud when no key exists anywhere.
  const enrichDr = () => walkEnrichment("dr", enrichTargets(), 60, async slice => {
    const res = await fetch("/api/drops/dr", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains: slice }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || "dr_failed");
    if (body.keyFound === false) throw new Error(tr("dropsEnrichNoDrKey"));
    const ratings = (body?.ratings ?? {}) as Record<string, number>;
    return persistMetrics(Object.entries(ratings).map(([domain, dr]) => ({ domain, dr })));
  });

  /**
   * The run-wide DR sweep an import starts by itself. Same loop shape as the DNS and registry
   * walkers, but the server names each batch: the client keeps asking until `done`, until a
   * batch rates nothing, or until the user hits Stop. A zero-rated batch is the honest ending —
   * the rest of the run is names Ahrefs has no number for (or the endpoint just refused), and
   * looping further would only hammer it.
   */
  async function sweepDr(sweepRunId: string, expected: number) {
    if (enrichBusy) return;
    enrichStop.current = false;
    setEnrichBusy("dr"); setError("");
    setNotice(tr("dropsEnrichSweepStarted").replace("{n}", expected.toLocaleString()));
    setEnrichProgress({ done: 0, total: Math.max(expected, 1), updated: 0 });
    let updated = 0;
    try {
      for (;;) {
        const res = await fetch("/api/drops/dr", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: sweepRunId }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || "dr_failed");
        if (body.keyFound === false) throw new Error(tr("dropsEnrichNoDrKey"));
        updated += body.updated ?? 0;
        const remaining = Number(body.remaining ?? 0);
        setEnrichProgress({
          done: Math.max(expected - remaining, 0),
          total: Math.max(expected, 1),
          updated,
        });
        const stalled = body.updated === 0 && !body.done;
        if (body.done || stalled || enrichStop.current) {
          if (stalled) setNotice(tr("dropsEnrichSweepStalled").replace("{n}", remaining.toLocaleString()));
          else if (enrichStop.current) setNotice(tr("dropsEnrichStopped").replace("{n}", String(updated)));
          else setNotice(tr("dropsEnrichDone").replace("{n}", String(updated)));
          break;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnrichBusy("");
      await loadRows();
    }
  }

  // Wayback is served by the app itself in bounded 12-domain slices (see the wayback route).
  const enrichWayback = () => walkEnrichment("wayback", enrichTargets(), 12, async slice => {
    const res = await fetch("/api/drops/wayback", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains: slice }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || "wayback_failed");
    // A slice where the archive refused every domain is an answer, not a zero: saying
    // "updated 12" hides it, and staying silent hides the throttle the user cannot otherwise see.
    if (body.updated === 0 && Number(body.throttled ?? 0) >= slice.length) {
      throw new Error(tr("dropsHistoryErrThrottled"));
    }
    return body.updated ?? 0;
  });

  // The AI history pass: the reference tool's "Пересчитать данные + AI". Runs on hand-picked
  // rows only — it spends LLM credits, so five at a time behind a confirm, never on a list.
  async function enrichHistory() {
    if (enrichBusy) return;
    // Selected rows on this page, whichever way the selection is expressed. The ≤5 guard below
    // is what keeps a filter-wide selection from turning into a credit-burning sweep.
    const targets = rows.filter(r => isRowSelected(r.id));
    if (!targets.length || targets.length > 5) { setNotice(tr("dropsEnrichHistoryPick")); return; }
    if (!window.confirm(tr("dropsEnrichHistoryConfirm").replace("{n}", String(targets.length)))) { setNotice(tr("dropsEnrichCancelled")); return; }
    setEnrichBusy("history"); setError(""); setNotice("");
    setEnrichProgress({ done: 0, total: targets.length, updated: 0 });
    try {
      const res = await fetch("/api/drops/history", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: targets.map(r => r.id) }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body?.error === "no_ai_creds") throw new Error(tr("dropsHistoryNoCreds"));
        throw new Error(body?.error || "history_failed");
      }
      const done = (body.results as { domain?: string; verdict?: string; error?: string }[] | undefined) ?? [];
      const decided = done.filter(r => r.verdict).length;
      // The route reports a per-row reason for every row that came back without a verdict —
      // a bare "0/1" with the reason still in the response is what made this notice exist.
      const failed = done.filter(r => !r.verdict);
      const failPart = failed.length
        ? " — " + failed.map(r => {
            const code = r.error ?? "";
            const reason = HISTORY_ERRORS[code] ? tr(HISTORY_ERRORS[code]) : (code || "?");
            return `${r.domain ?? "?"}: ${reason}`;
          }).join("; ")
        : "";
      setNotice(tr("dropsEnrichHistoryDone").replace("{n}", `${decided}/${done.length}`) + failPart);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnrichBusy("");
      await loadRows();
    }
  }

  // Refdomains go through the existing paid metrics route, which owns the unit reservation and
  // the cap. Explicit creds, same pattern as the dashboard's DR chip: keys live in this browser.
  const enrichRefs = () => {
    const creds = getMetricsCreds();
    if (!creds.apiKey) { setError(tr("dropsEnrichNoKey")); return; }
    const n = enrichTargets().length;
    if (!window.confirm(tr("dropsEnrichRefsConfirm").replace("{n}", String(n)))) { setNotice(tr("dropsEnrichCancelled")); return; }
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
      // Same 200-with-refused-batch shape the TF path guards: fetched 0 + an error field is a
      // gateway refusal, not an empty answer.
      if (body.fetched === 0 && body.error) throw new Error(body.error);
      const metrics = (body?.metrics ?? {}) as Record<string, { refDomains?: number | null; backlinks?: number | null }>;
      return persistMetrics(Object.entries(metrics).map(([domain, m]) => ({
        domain, refdomains: m?.refDomains ?? undefined, backlinks: m?.backlinks ?? undefined,
      })));
    });
  };

  // TF/CF via Majestic: the cheapest meaningful enrichment on the page (one index-item unit
  // per domain), and the read the DR number cannot replace — TF catches a PBN-heavy profile
  // DR is happy with. Always speaks Majestic explicitly, whatever the active provider is;
  // the route batches 100 domains into one GetIndexItemInfo call. Works on any catalogue
  // domain — nothing here is tied to owned sites.
  const enrichTf = () => {
    const creds = getMetricsCreds("majestic");
    if (!creds.apiKey) { setError(tr("dropsEnrichNoTfKey")); return; }
    const n = enrichTargets().length;
    // A refused (or browser-suppressed — "never show more dialogs") confirm must never be
    // silent: it reads as a dead button, which is exactly the report this guard answers.
    if (!window.confirm(tr("dropsEnrichTfConfirm").replace("{n}", String(n)))) { setNotice(tr("dropsEnrichCancelled")); return; }
    return walkEnrichment("tf", enrichTargets(), 100, async slice => {
      const res = await fetch("/api/metrics/domain", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domains: slice, fetch: true, provider: "majestic",
          apiKey: creds.apiKey, baseUrl: creds.baseUrl, cap: creds.cap,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "tf_failed");
      // The route answers HTTP 200 even when the gateway refused the whole batch (fetched: 0
      // + an error field); throwing beats a silent "updated 0" with all dashes still showing.
      if (body.fetched === 0 && body.error) throw new Error(body.error);
      const metrics = (body?.metrics ?? {}) as Record<string, { tf?: number | null; cf?: number | null }>;
      return persistMetrics(Object.entries(metrics).map(([domain, m]) => ({
        domain, tf: m?.tf ?? undefined, cf: m?.cf ?? undefined,
      })));
    });
  };

  /** Bulk delete / star / watch / group over the flat selection, or the whole filter. */
  async function bulk(action: "delete" | "star" | "unstar" | "watch" | "unwatch" | "group" | "ungroup", targetGroupId?: string) {
    if (action === "delete" && !window.confirm(tr("dropsConfirmDelete").replace("{n}", String(selectedCount)))) return;
    const payload: Record<string, unknown> = selectAllFilter
      ? { matchAll: true, action, filter: filterPayload(), ...(excludedIds.size ? { exclude: [...excludedIds] } : {}) }
      : { ids: [...selectedIds], action };
    if (action === "group") payload.groupId = targetGroupId;
    try {
      const res = await fetch("/api/drops/candidates", {
        method: action === "delete" ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        // The cap is enforced on both sides; the server's word is final, and its code has to
        // arrive as a sentence rather than as "too_many_exclusions".
        if (body?.error === "too_many_exclusions") {
          throw new Error(tr("dropsTooManyExclusions").replace("{n}", String(body?.max ?? EXCLUDE_MAX)));
        }
        throw new Error(body?.error || "bulk_failed");
      }
      const touched = action === "delete" ? (body.deleted ?? 0) : (body.updated ?? 0);
      setNotice(action === "delete"
        ? tr("dropsDeleted").replace("{n}", String(touched))
        : action === "watch" || action === "unwatch"
          ? tr("dropsWatchUpdated").replace("{n}", String(touched))
          : action === "group" || action === "ungroup"
            ? tr("dropsGroupUpdated").replace("{n}", String(touched))
            : tr("dropsStarred").replace("{n}", String(touched)));
      clearSelection();
      if (action === "group" || action === "ungroup") await loadGroups();
      await Promise.all([loadRows(), loadRuns()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Assign the selection to a group, creating one first when the user picked "новая". */
  async function assignGroup(pick: string) {
    let gid = pick;
    try {
      if (pick === "__new") {
        const name = window.prompt(tr("dropsGroupNamePrompt"))?.trim();
        if (!name) return;
        const res = await fetch("/api/drops/groups", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || "group_failed");
        gid = body.id;
      }
      await bulk("group", gid);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function renameGroup(id: string, current: string) {
    const name = window.prompt(tr("dropsGroupNamePrompt"), current)?.trim();
    if (!name || name === current) return;
    try {
      const res = await fetch("/api/drops/groups", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "group_failed");
      await loadGroups();
      await loadRows();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteGroup(id: string, name: string) {
    if (!window.confirm(tr("dropsGroupDeleteConfirm").replace("{name}", name))) return;
    try {
      const res = await fetch(`/api/drops/groups?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "group_failed");
      if (groupId === id) setGroupId("");
      setFullGroups(prev => {
        if (!(id in prev)) return prev;
        const n = { ...prev };
        delete n[id];
        return n;
      });
      await loadGroups();
      await loadRows();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** One-row watch toggle — optimistic, like a star: the flag is the whole change. */
  async function toggleWatch(r: Candidate) {
    const next = !r.watched;
    setRows(prev => prev.map(x => (x.id === r.id ? { ...x, watched: next } : x)));
    try {
      const res = await fetch("/api/drops/candidates", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [r.id], action: next ? "watch" : "unwatch" }),
      });
      if (!res.ok) throw new Error("watch_failed");
    } catch {
      setRows(prev => prev.map(x => (x.id === r.id ? { ...x, watched: !next } : x)));
      setError(tr("dropsWatchFailed"));
    }
  }

  // The header checkbox has exactly two states, Sheets-style: checked means "everything is
  // selected", unchecked means it is not. One click selects every row the current filter
  // matches (all pages, all groups); one click on a checked box clears the lot. No
  // `indeterminate` third state — a dash that had to be clicked through to get back to empty
  // is precisely what this replaces.
  const allSelected = selectAllFilter
    ? excludedIds.size === 0
    : rows.length > 0 && rows.every(r => selectedIds.has(r.id));
  const togglePage = () => {
    if (allSelected) clearSelection(); else selectAll();
  };
  const headerSelectLabel = allSelected
    ? tr("dropsClearSelection")
    : tr("dropsSelectAllFilter").replace("{n}", total.toLocaleString());

  /**
   * Where the catalogue actually is, read off the funnel counts rather than off what the user
   * last clicked. The page used to be a flat row of buttons with no order in it: nothing said
   * that DNS comes before the registry, or why, and a first-time user pressed whichever button
   * looked most promising. The strip below is that order, made visible.
   */
  const stepState = useMemo(() => {
    const ingested = counts.ingested ?? 0;
    const dnsChecked = counts.dns_checked ?? 0;
    const decided = (counts.available ?? 0) + (counts.confirmed ?? 0);
    const anything = Object.values(counts).reduce((a, b) => a + b, 0);
    // The first step that still has work waiting is the current one. A catalogue with rows in
    // several stages at once is normal — the earliest unfinished stage is what to press next.
    const current = anything === 0 ? 1 : ingested > 0 ? 3 : dnsChecked > 0 ? 4 : 5;
    return { ingested, dnsChecked, decided, anything, current };
  }, [counts]);

  // WHOIS rides only on SOCKS5; an HTTP-only pool silently means "RDAP through proxies, WHOIS
  // from this server", which changes both the speed and the corroboration rate.
  const hasSocksProxy = proxies.some(p => p.enabled && p.kind === "socks5");

  const zones = useMemo(() => [...new Set(rows.map(r => r.tld))].sort(), [rows]);
  const totalAll = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts]);
  const pageFrom = total === 0 ? 0 : offset + 1;
  const pageTo = Math.min(offset + pageSize, total);
  const lastPage = offset + pageSize >= total;

  const arrowFor = (field: SortField) =>
    orderBy === field ? (orderDir === "asc" ? "▲" : "▼") : "";

  /**
   * The page, grouped Sheets-style: every group represented on this page gets a header row and
   * its rows collected under it (in the sort's own order), and the ungrouped rows follow without
   * a header. Purely presentational — pagination and sorting stay server-side, so a group can
   * span pages and each page shows its slice under the same header. A collapsed group keeps its
   * header and hides its rows.
   */
  const segments = useMemo<Segment[]>(() => {
    const byGroup = new Map<string, Candidate[]>();
    const loose: Candidate[] = [];
    for (const r of rows) {
      if (r.groupId) {
        const list = byGroup.get(r.groupId);
        if (list) list.push(r); else byGroup.set(r.groupId, [r]);
      } else {
        loose.push(r);
      }
    }
    const orderOf = (gid: string) => {
      const i = groups.findIndex(g => g.id === gid);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const segs: Segment[] = [];
    let stripe = 0;
    for (const [gid, rs] of [...byGroup.entries()].sort((a, b) => orderOf(a[0]) - orderOf(b[0]))) {
      segs.push({
        kind: "group", id: gid,
        name: rs[0]?.groupName || groups.find(g => g.id === gid)?.name || gid,
        pageRows: rs.length,
        pageSelected: rs.filter(r => isRowSelected(r.id)).length,
      });
      if (!collapsed[gid]) for (const r of rs) segs.push({ kind: "row", r, stripe: stripe++ });
    }
    for (const r of loose) segs.push({ kind: "row", r, stripe: stripe++ });
    return segs;
  }, [rows, groups, collapsed, isRowSelected]);

  return <div className="main-content" style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 20, paddingBottom: 40 }}>
    <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 22, margin: 0, color: "var(--color-text-primary)" }}>
          <Boxes size={20} /> {tr("dropsTitle")}
        </h1>
        <p style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 6, maxWidth: 820 }}>{tr("dropsSubtitle")}</p>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => setShowProxies(v => !v)} style={pagerBtn(false)}>
          {tr("dropsProxies")}{proxies.length > 0 ? ` · ${proxies.filter(p => p.enabled).length}` : ""}
        </button>
        <button onClick={() => setShowImport(v => !v)} style={primaryBtn}>
          <Plus size={14} /> {tr("dropsImport")}
        </button>
      </div>
    </div>

    {notMigrated && <div className="panel" style={{ color: "var(--color-accent-orange, #ff9f0a)", fontSize: 13 }}>
      <AlertTriangle size={15} style={{ verticalAlign: -2, marginRight: 6 }} />{tr("dropsNotMigrated")}
    </div>}

    {(error || notice) && <div className="panel" style={{ fontSize: 12.5, lineHeight: 1.6, display: "flex", flexDirection: "column", gap: 4 }}>
      {error && <div style={{ color: "#ff6b62" }}><AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />{error}</div>}
      {notice && <div style={{ color: "var(--color-accent-orange, #ff9f0a)" }}>{notice}</div>}
    </div>}

    {/* The conveyor: what the stages are, which one is live, and what to do next. Nothing here
        performs work — the buttons stay where their own state lives. This panel exists because
        the order and the reasons were invisible, not because the buttons were hard to find. */}
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "stretch" }}>
        {([
          { n: 1, name: tr("dropsStepImportName"), state: stepState.anything > 0 ? tr("dropsStepDone").replace("{n}", stepState.anything.toLocaleString()) : tr("dropsStepWaiting") },
          { n: 2, name: tr("dropsStepProxyName"), state: proxies.filter(p => p.enabled).length > 0 ? tr("dropsStepProxyOn").replace("{n}", String(proxies.filter(p => p.enabled).length)) : tr("dropsStepProxyOff") },
          { n: 3, name: tr("dropsStepDnsName"), state: stepState.ingested > 0 ? tr("dropsStepQueued").replace("{n}", stepState.ingested.toLocaleString()) : tr("dropsStepClear") },
          { n: 4, name: tr("dropsStepRegistryName"), state: stepState.dnsChecked > 0 ? tr("dropsStepQueued").replace("{n}", stepState.dnsChecked.toLocaleString()) : tr("dropsStepClear") },
          { n: 5, name: tr("dropsStepResultName"), state: tr("dropsStepFound").replace("{n}", stepState.decided.toLocaleString()) },
        ]).map(step => {
          const live = step.n === stepState.current;
          // Step 2 is never "current": the pool is optional and out of the sequence.
          const dim = step.n === 2 && proxies.length === 0;
          return <div key={step.n} style={{
            flex: "1 1 150px", minWidth: 140, padding: "8px 10px", borderRadius: 9,
            border: `1px solid ${live ? "var(--color-accent-blue)" : "var(--color-border)"}`,
            background: live ? "rgba(10,132,255,0.06)" : "transparent",
            opacity: dim ? 0.6 : 1,
          }}>
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{step.n}</div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-text-primary)" }}>{step.name}</div>
            <div style={{ fontSize: 11.5, color: live ? "var(--color-accent-blue)" : "var(--color-text-secondary)" }}>{step.state}</div>
          </div>;
        })}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 12.5 }}>
        <span style={{ color: "var(--color-text-secondary)" }}>
          {stepState.current === 1 ? tr("dropsNextImport")
            : stepState.current === 3 ? tr("dropsNextDns")
              : stepState.current === 4 ? tr("dropsNextRegistry")
                : tr("dropsNextResult")}
        </span>
        <button onClick={() => setShowHow(v => !v)} style={groupBtn}>
          <CircleHelp size={13} /> {showHow ? tr("dropsHowHide") : tr("dropsHowShow")}
        </button>
      </div>

      {showHow && <div style={{ fontSize: 12.5, lineHeight: 1.65, color: "var(--color-text-secondary)", display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Where the file comes from. Without this the page starts one step too late: the user
            has no list, and nothing on screen says how anyone gets one. */}
        <div>
          <b style={{ color: "var(--color-text-primary)" }}>{tr("dropsRecipeTitle")}</b>
          <div style={{ marginTop: 4 }}><b>{tr("dropsRecipe1Title")}</b> — {tr("dropsRecipe1Body")}</div>
          <div style={{ marginTop: 4 }}><b>{tr("dropsRecipe2Title")}</b> — {tr("dropsRecipe2Body")}</div>
        </div>
        <div>
          <b style={{ color: "var(--color-text-primary)" }}>{tr("dropsWhyTitle")}</b>
          <div style={{ marginTop: 4 }}>{tr("dropsWhyDns")}</div>
          <div style={{ marginTop: 4 }}>{tr("dropsWhyCorroborated")}</div>
          <div style={{ marginTop: 4 }}>{tr("dropsWhyProxy")}</div>
          <div style={{ marginTop: 4 }}>{tr("dropsWhyNoRegistry")}</div>
        </div>
      </div>}
    </div>

    {showImport && <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input className="tool-input" style={{ flex: 1, minWidth: 200 }} value={label}
          onChange={e => setLabel(e.target.value)} placeholder={tr("dropsLabelField")} />
        <select className="tool-input" style={{ width: 220 }} value={source}
          onChange={e => setSource(e.target.value as DropSource)}>
          {SOURCES.map(s => <option key={s.value} value={s.value}>{tr(s.key)}</option>)}
        </select>
      </div>
      {/* A drop target, not just a textarea: the file this page is built around is a 30 000-row
          Ahrefs export, and nobody pastes one of those. The textarea stays for a quick list. */}
      <label
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); void acceptFile(e.dataTransfer.files?.[0]); }}
        style={{
          display: "block", padding: "22px 16px", textAlign: "center", cursor: "pointer",
          border: `1px dashed ${dragOver ? "var(--color-accent-blue)" : "var(--color-border)"}`,
          borderRadius: 10, fontSize: 13,
          color: dragOver ? "var(--color-accent-blue)" : "var(--color-text-secondary)",
          background: dragOver ? "rgba(10,132,255,0.06)" : "transparent",
        }}>
        <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" style={{ display: "none" }}
          onChange={e => { void acceptFile(e.target.files?.[0]); e.target.value = ""; }} />
        {fileName
          ? <><b style={{ color: "var(--color-text-primary)" }}>{fileName}</b>
              {" · "}{tr("dropsFileLoaded").replace("{n}", raw.split(/\r?\n/).filter(Boolean).length.toLocaleString())}</>
          : tr("dropsDropzone")}
      </label>
      <textarea className="tool-input" rows={6} value={raw}
        onChange={e => { setRaw(e.target.value); setFileName(""); setColOverride({}); }}
        placeholder={tr("dropsImportPlaceholder")} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }} />

      {/* Which column the import is about to read. On an Outgoing-links export the source column
          comes BEFORE the target one, so getting this wrong imports the donor and nothing else —
          it has to be visible before the button is pressed, and overridable when it is wrong. */}
      {preview && preview.columns.header.length > 0 && <div style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {([
            ["domain", tr("dropsColDomain")],
            ["dr", tr("dropsColDr")],
            ["refdomains", tr("dropsColRef")],
          ] as const).map(([key, label_]) => <label key={key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            {label_}
            <select className="tool-input" style={{ width: 190, fontSize: 12, padding: "3px 6px" }}
              value={String(preview.columns[key] ?? -1)}
              onChange={e => {
                const v = Number(e.target.value);
                setColOverride(prev => {
                  const n = { ...prev };
                  if (v < 0) delete n[key]; else n[key] = v;
                  return n;
                });
              }}>
              <option value="-1">{tr("dropsColNone")}</option>
              {preview.columns.header.map((h, i) => <option key={i} value={i}>{h || `#${i + 1}`}</option>)}
            </select>
          </label>)}
        </div>
        <div style={{ color: preview.columns.detected ? "var(--color-text-tertiary)" : "var(--color-accent-orange, #ff9f0a)" }}>
          {preview.columns.detected
            ? tr("dropsColDetected")
                .replace("{n}", preview.rows.toLocaleString())
                .replace("{dr}", preview.withDr.toLocaleString())
            : tr("dropsColUndetected")}
        </div>
      </div>}
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
        {Number(summary.metricsFromFile ?? 0) > 0 && <div style={{ color: "var(--color-accent-green, #34c759)" }}>
          {tr("dropsMetricsFromFile").replace("{n}", Number(summary.metricsFromFile).toLocaleString())}
        </div>}
        {summary.skipped > 0 && <div style={{ color: "var(--color-text-tertiary)" }}>
          {Object.entries(summary.skipReport)
            .sort((a, b) => b[1] - a[1])
            .map(([reason, n]) => `${n} — ${SKIP_KEYS[reason] ? tr(SKIP_KEYS[reason]) : reason}`)
            .join(" · ")}
        </div>}
      </div>}
    </div>}

    {/* The pool. Optional on purpose — DropHunter refuses to start without proxies, but the
        check here works from one IP too, just slowly, and pretending otherwise would be a lie. */}
    {showProxies && <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        {tr("dropsProxyWhy")}
        <div style={{ color: hasSocksProxy ? "var(--color-text-tertiary)" : "var(--color-accent-orange, #ff9f0a)", marginTop: 4 }}>
          {hasSocksProxy ? tr("dropsProxySocksOk") : tr("dropsProxySocksMissing")}
        </div>
      </div>
      <textarea className="tool-input" rows={4} value={proxyRaw} onChange={e => setProxyRaw(e.target.value)}
        placeholder={tr("dropsProxyPlaceholder")}
        style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }} />
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={() => void addProxies()} disabled={!!proxyBusy || !proxyRaw.trim()} style={primaryBtn}>
          {proxyBusy === "add" ? <Loader2 className="spin" size={14} /> : <Plus size={14} />} {tr("dropsProxyAdd")}
        </button>
        <button onClick={() => void checkProxies()} disabled={!!proxyBusy || !proxies.length} style={pagerBtn(!proxies.length)}>
          {proxyBusy === "check" ? <Loader2 className="spin" size={13} /> : null} {tr("dropsProxyCheck")}
        </button>
        {proxyNote && <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{proxyNote}</span>}
      </div>

      {proxies.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
        {proxies.map(p => {
          // Green means "the last live check tunnelled through it", not "it is configured".
          const alive = !!p.lastOkAt && (!p.lastError || (p.lastCheckedAt ?? "") <= (p.lastOkAt ?? ""));
          return <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input type="checkbox" checked={p.enabled} title={tr("dropsProxyEnabled")}
              onChange={() => void proxyAction({ method: "POST", body: JSON.stringify({ action: "toggle", id: p.id, enabled: !p.enabled }) })}
              style={{ cursor: "pointer" }} />
            <span style={{
              fontFamily: "ui-monospace, monospace",
              color: p.enabled ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
            }}>{p.label}</span>
            {p.lastCheckedAt && <span style={{ color: alive ? "var(--color-accent-green, #34c759)" : "#ff6b62" }}>
              {alive ? tr("dropsProxyAlive") : (p.lastError || tr("dropsProxyDead"))}
            </span>}
            <button onClick={() => void proxyAction({ method: "DELETE", body: JSON.stringify({ id: p.id }) })}
              aria-label={tr("dropsBulkDelete")} style={groupBtn}><X size={12} /></button>
          </div>;
        })}
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
      <select className="tool-input" style={{ width: 160 }} value={groupId} onChange={e => setGroupId(e.target.value)}>
        <option value="">{tr("dropsGroupAll")}</option>
        <option value="none">{tr("dropsGroupNone")}</option>
        {groups.map(g => <option key={g.id} value={g.id}>{g.name} ({g.count})</option>)}
      </select>
      <select className="tool-input" style={{ width: 170 }} value={watched}
        onChange={e => setWatchedFilter(e.target.value as "" | "1")}>
        <option value="">{tr("dropsWatchFilterAll")}</option>
        <option value="1">{tr("dropsWatchFilterWatched")}</option>
      </select>
    </div>

    {/* Numeric ranges — the "выделить всё с DR < 10 и удалить" flow. Empty field = no bound on
        that side; every range also answers to "выбрать все по фильтру" bulk actions. */}
    <div className="panel" style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", fontSize: 12.5 }}
      title={tr("dropsRangeHint")}>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <b style={{ color: "var(--color-text-secondary)" }}>DR</b>
        <input className="tool-input" style={{ width: 64 }} type="number" inputMode="numeric" placeholder={tr("dropsRangeFrom")}
          value={drMin} onChange={e => setDrMin(e.target.value)} />
        <span style={{ color: "var(--color-text-tertiary)" }}>–</span>
        <input className="tool-input" style={{ width: 64 }} type="number" inputMode="numeric" placeholder={tr("dropsRangeTo")}
          value={drMax} onChange={e => setDrMax(e.target.value)} />
        <label style={{ display: "flex", alignItems: "center", gap: 5, marginLeft: 6, color: "var(--color-text-secondary)", cursor: "pointer" }}
          title={tr("dropsDrNoneHint")}>
          <input type="checkbox" checked={drNullOnly} onChange={e => setDrNullOnly(e.target.checked)} />
          {tr("dropsDrNone")}
        </label>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <b style={{ color: "var(--color-text-secondary)" }}>{tr("dropsColRefdomains")}</b>
        <input className="tool-input" style={{ width: 76 }} type="number" inputMode="numeric" placeholder={tr("dropsRangeFrom")}
          value={refMin} onChange={e => setRefMin(e.target.value)} />
        <span style={{ color: "var(--color-text-tertiary)" }}>–</span>
        <input className="tool-input" style={{ width: 76 }} type="number" inputMode="numeric" placeholder={tr("dropsRangeTo")}
          value={refMax} onChange={e => setRefMax(e.target.value)} />
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <b style={{ color: "var(--color-text-secondary)" }} title={tr("dropsTfHint")}>TF</b>
        <input className="tool-input" style={{ width: 64 }} type="number" inputMode="numeric" placeholder={tr("dropsRangeFrom")}
          value={tfMin} onChange={e => setTfMin(e.target.value)} />
        <span style={{ color: "var(--color-text-tertiary)" }}>–</span>
        <input className="tool-input" style={{ width: 64 }} type="number" inputMode="numeric" placeholder={tr("dropsRangeTo")}
          value={tfMax} onChange={e => setTfMax(e.target.value)} />
      </span>
      {(drMin || drMax || drNullOnly || refMin || refMax || tfMin || tfMax) && <button
        onClick={() => { setDrMin(""); setDrMax(""); setDrNullOnly(false); setRefMin(""); setRefMax(""); setTfMin(""); setTfMax(""); }}
        style={pagerBtn(false)}>
        {tr("dropsRangeClear")}
      </button>}
    </div>

    {/* Enrichment. Every source states its cost up front: DR and Wayback are free, TF/CF bills
        Majestic units (about as cheap as enrichment gets), refdomains bill Ahrefs units and ask
        first. Acts on the selection, or on the visible page. */}
    {(rows.length > 0 || enrichBusy) && <div className="panel" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
      <span style={{ color: "var(--color-text-tertiary)" }}>{tr("dropsEnrichLabel")}</span>
      {/* While a DR pass is running this is its Stop button — same pattern as the DNS and
          registry stages, because a run-wide sweep can legitimately run for a while. */}
      <button onClick={enrichBusy === "dr" ? () => { enrichStop.current = true; } : enrichDr}
        disabled={enrichBusy !== "" && enrichBusy !== "dr"} style={ghostBtnDisabled(enrichBusy !== "" && enrichBusy !== "dr")}>
        {enrichBusy === "dr" ? <Square size={13} /> : <Star size={13} />}
        {enrichBusy === "dr" ? tr("dropsDnsStop") : tr("dropsEnrichDr")}
      </button>
      <button onClick={enrichWayback} disabled={enrichBusy !== ""} style={ghostBtnDisabled(enrichBusy !== "")}>
        {enrichBusy === "wayback" ? <Loader2 className="spin" size={13} /> : <History size={13} />}
        {enrichBusy === "wayback" ? tr("dropsEnrichWaybackBusy") : tr("dropsEnrichWayback")}
      </button>
      <button onClick={enrichTf} disabled={enrichBusy !== ""} style={ghostBtnDisabled(enrichBusy !== "")}>
        {enrichBusy === "tf" ? <Loader2 className="spin" size={13} /> : <Sparkles size={13} />}
        {enrichBusy === "tf" ? tr("dropsEnrichTfBusy") : tr("dropsEnrichTf")}
      </button>
      <button onClick={enrichRefs} disabled={enrichBusy !== ""} style={ghostBtnDisabled(enrichBusy !== "")}>
        {enrichBusy === "refs" ? <Loader2 className="spin" size={13} /> : <Database size={13} />}
        {enrichBusy === "refs" ? tr("dropsEnrichRefsBusy") : tr("dropsEnrichRefs")}
      </button>
      <button onClick={() => void enrichHistory()} disabled={enrichBusy !== ""} style={ghostBtnDisabled(enrichBusy !== "")}
        title={tr("dropsEnrichHistoryPick")}>
        {enrichBusy === "history" ? <Loader2 className="spin" size={13} /> : <Sparkles size={13} />}
        {enrichBusy === "history" ? tr("dropsEnrichHistoryBusy") : tr("dropsEnrichHistory")}
      </button>
      {enrichBusy && enrichProgress && <span style={{ color: "var(--color-text-secondary)" }}>
        {enrichProgress.done.toLocaleString()} / {enrichProgress.total.toLocaleString()} · <b>{enrichProgress.updated.toLocaleString()}</b> {tr("dropsEnrichUpdated")}
      </span>}
      {drKeyMissing && <span style={{ color: "var(--color-accent-orange, #ff9f0a)" }}>{tr("dropsEnrichAutoNoKey")}</span>}
      {/* The "why" behind the DR sparkline in the table: the series is the veto signal, and it
          is free — this panel accumulates it as a side effect of the checks it already makes. */}
      <span title={tr("drHistCalloutDesc")} style={{ color: "var(--color-text-secondary)", cursor: "help" }}>
        💡 {tr("drHistCallout")}
      </span>
      <span style={{ flex: 1, minWidth: 160, color: "var(--color-text-tertiary)", fontSize: 12 }}>
        {tr("dropsEnrichAutoHint")} {tr("dropsAttribution")}
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
        {/* The loop closes here: an export goes back out the way it came in. Server-side under
            the current filter, not "whatever the table is holding" — the table has one page. */}
        <button onClick={() => {
          const qs = new URLSearchParams({
            ...Object.fromEntries(Object.entries(filterPayload()).map(([k, v]) => [k, String(v)])),
            orderBy, order: orderDir,
          });
          window.location.href = `/api/drops/export?${qs.toString()}`;
        }} disabled={total === 0} style={pagerBtn(total === 0)}>
          {tr("dropsExportCsv")}
        </button>
        <button onClick={selectAll}
          disabled={total === 0} style={pagerBtn(total === 0)}>
          {tr("dropsSelectAllFilter").replace("{n}", total.toLocaleString())}
        </button>
        {selectedCount > 0 && <>
          <span style={{ fontSize: 12.5, color: "var(--color-text-primary)", fontWeight: 700 }}>
            {tr("dropsSelected").replace("{n}", selectedCount.toLocaleString())}
          </span>
          <button onClick={() => void bulk("delete")} style={pagerBtn(false)}>{tr("dropsBulkDelete")}</button>
          <button onClick={() => void bulk("star")} style={pagerBtn(false)}>{tr("dropsBulkStar")}</button>
          <button onClick={() => void bulk("watch")} style={pagerBtn(false)}>{tr("dropsBulkWatch")}</button>
          <button onClick={() => void bulk("unwatch")} style={pagerBtn(false)}>{tr("dropsBulkUnwatch")}</button>
          <select value="" onChange={e => { const v = e.target.value; if (v) void assignGroup(v); }}
            aria-label={tr("dropsAssignGroup")} style={{ ...pagerSelect }}>
            <option value="">{tr("dropsAssignGroup")}</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            <option value="__new">{tr("dropsGroupNew")}</option>
          </select>
          <button onClick={() => void bulk("ungroup")} style={pagerBtn(false)}>{tr("dropsUngroup")}</button>
          <button onClick={() => {
            if (selectAllFilter) void runRegistryCheck(undefined, filterPayload(), excludedIds.size ? [...excludedIds] : undefined);
            else void runRegistryCheck([...selectedIds]);
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
                <input type="checkbox" checked={allSelected}
                  onChange={togglePage} aria-label={headerSelectLabel} title={headerSelectLabel}
                  style={{ cursor: "pointer" }} />
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
            {segments.map(seg => seg.kind === "group" ? (() => {
              const totalIn = groups.find(g => g.id === seg.id)?.count ?? seg.pageRows;
              const isCollapsed = !!collapsed[seg.id];
              // Truth first. Under "выделить всё" the group is full unless one of its rows is
              // a hole — and only this page's rows can be inspected, so a hole punched on
              // another page reads as full here; the row's own checkbox stays truthful either
              // way. Otherwise: full when the group's entire membership was pulled in via this
              // very checkbox (marker matches the current size), or when every row of the group
              // is on this page and checked.
              const full = selectAllFilter
                ? seg.pageRows > 0 && seg.pageSelected === seg.pageRows
                : fullGroups[seg.id] === totalIn && totalIn > 0
                  || (seg.pageRows > 0 && seg.pageRows >= totalIn && seg.pageSelected === seg.pageRows);
              const partial = !full && seg.pageSelected > 0;
              const hint = full ? tr("dropsGroupUnselectHint")
                : tr("dropsGroupSelectHint").replace("{n}", String(totalIn));
              return <tr key={`group-${seg.id}`} style={{ background: "var(--color-bg)" }}>
                <td colSpan={COLUMNS.length + 1} style={{ padding: "6px 14px", borderBottom: "1px solid var(--color-border)" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={full}
                      onChange={() => void toggleGroupSelection(seg.id, full, totalIn)}
                      aria-label={hint} title={partial ? `${hint} (${tr("dropsGroupPartial").replace("{n}", String(seg.pageSelected))})` : hint}
                      style={{ cursor: "pointer" }} />
                    <button onClick={() => toggleCollapsed(seg.id)}
                      aria-label={isCollapsed ? tr("dropsGroupExpand") : tr("dropsGroupCollapse")}
                      style={groupBtn}>
                      {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    </button>
                    <b style={{ color: "var(--color-text-primary)" }}>{seg.name}</b>
                    <span style={{ color: "var(--color-text-tertiary)", fontSize: 12 }} title={tr("dropsGroupCountHint")}>
                      {totalIn.toLocaleString()}
                    </span>
                    {partial && <span style={{ color: "var(--color-accent-orange, #ff9f0a)", fontSize: 12 }}>
                      {tr("dropsGroupPartial").replace("{n}", String(seg.pageSelected))}
                    </span>}
                    <button onClick={() => void renameGroup(seg.id, seg.name)} aria-label={tr("dropsGroupRename")} style={groupBtn}>
                      <Pencil size={12} />
                    </button>
                    <button onClick={() => void deleteGroup(seg.id, seg.name)} aria-label={tr("dropsBulkDelete")} style={groupBtn}>
                      <X size={13} />
                    </button>
                  </span>
                </td>
              </tr>;
            })() : (() => {
              const r = seg.r;
              const s = STAGES.find(x => x.value === r.stage);
              const checked = isRowSelected(r.id);
              // Zebra. A translucent grey survives both themes; the tier-1 way to read a wide
              // table is "which cells belong to this row".
              const stripe = seg.stripe % 2 === 1 ? { background: "var(--color-row-alt, rgba(127,127,127,0.055))" } : undefined;
              return <Fragment key={r.id}>
                <tr style={{ borderTop: "1px solid var(--color-border)", ...stripe }}>
                  <td style={td}>
                    <input type="checkbox" checked={checked} onChange={() => toggleRow(r.id)}
                      aria-label={r.domain} style={{ cursor: "pointer" }} />
                  </td>
                  <td style={{ ...td, fontWeight: 600, color: "var(--color-text-primary)" }}>
                    {r.domain}
                    {/* The domain's Wayback timeline, one click away — always, not only after the
                        Wayback pass has filled the snapshots column. */}
                    <a href={`https://web.archive.org/web/*/${r.domain}*`} target="_blank" rel="noreferrer"
                      title={tr("dropsWaybackLink")}
                      style={{ marginLeft: 6, color: "var(--color-accent-blue)", display: "inline-flex", verticalAlign: "-2px" }}>
                      <History size={12} />
                    </a>
                    {/* The referring-domain profile, same one-click access — the drawer reuses
                        the dashboard's Backlinks tab, providers and all. */}
                    <button onClick={() => setOpenLinks(cur => (cur === r.domain ? null : r.domain))}
                      title={tr("dropsBacklinksShow")} aria-label={tr("dropsBacklinksShow")}
                      style={{
                        marginLeft: 4, display: "inline-flex", verticalAlign: "-2px", cursor: "pointer",
                        background: "none", border: "none", padding: 0,
                        color: openLinks === r.domain ? "var(--color-accent-blue)" : "var(--color-text-tertiary)",
                      }}>
                      <Link2 size={12} />
                    </button>
                    {/* The AI history verdict next to the name it is about — the pass is no use
                        if its answer only exists in the database. The note rides in the tooltip. */}
                    {(() => {
                      const v = r.historyVerdict ? HISTORY_VERDICTS[r.historyVerdict] : undefined;
                      if (!v) return null;
                      return <span title={`${tr(v.key)}${r.historyNote ? ` — ${r.historyNote}` : ""}`}
                        style={{ marginLeft: 5, color: v.color, display: "inline-flex", verticalAlign: "-2px" }}>
                        <v.Icon size={12} />
                      </span>;
                    })()}
                    {/* The watch toggle. Lit means the scheduler is polling this domain and will
                        notify once it frees; the funnel stages stay the source of truth about the
                        row, the watch only decides whether the row keeps being re-asked. */}
                    <button onClick={() => void toggleWatch(r)}
                      title={r.watched ? tr("dropsWatchHintOff") : tr("dropsWatchHint")}
                      aria-label={r.watched ? tr("dropsWatchHintOff") : tr("dropsWatch")}
                      style={{
                        marginLeft: 4, display: "inline-flex", verticalAlign: "-2px", cursor: "pointer",
                        background: "none", border: "none", padding: 0,
                        color: r.watched ? "var(--color-accent-green, #34c759)" : "var(--color-text-tertiary)",
                      }}>
                      <Radar size={12} />
                    </button>
                  </td>
                  <td style={td}>
                    <span style={{ color: s?.color ?? "var(--color-text-secondary)" }}>{s ? tr(s.key) : r.stage}</span>
                    {/* An `available` seen by one source only is not shown as free — it is shown as
                        needing another look. Everything downstream depends on that distinction. */}
                    {r.stage === "available" && !r.corroborated &&
                      <span title={tr("dropsUncorroborated")} style={{ marginLeft: 6, color: "var(--color-accent-orange, #ff9f0a)" }}>?</span>}
                    {r.lastError === "zone_uncheckable" &&
                      <span title={tr("dropsZoneUncheckable")} style={{ marginLeft: 6, color: "var(--color-text-tertiary)", cursor: "help" }}>⚖</span>}
                  </td>
                  <td style={tdNum}>
                    {r.dr ?? "—"}
                    {/* The stored monthly series, next to the number it qualifies — and the veto
                        flag when the window shows a ≥5-point fall. Nothing stored, nothing drawn:
                        the series appears as the panel accumulates it. */}
                    {(() => {
                      const hist = drHist[r.domain];
                      if (!hist || hist.length < 2) return null;
                      const drop = hist[hist.length - 1].dr - hist[0].dr;
                      const title = `${tr("drHistHint")}\n\n${drSeriesText(hist)}`
                        + (drop <= -5 ? `\n\n${tr("drHistFlag").replace("{n}", String(Math.abs(drop)))}` : "");
                      return <span title={title} style={{ marginLeft: 6, display: "inline-flex", verticalAlign: "-4px", alignItems: "center", gap: 3 }}>
                        <DrSparkline points={hist} />
                        {drop <= -5 && <AlertTriangle size={12} color="#ff6b62" style={{ flexShrink: 0 }} />}
                      </span>;
                    })()}
                  </td>
                  <td style={tdNum}>{r.refdomainsDofollow ?? r.refdomains ?? "—"}</td>
                  <td style={tdNum} title={tr("dropsTfHint")}>
                    {r.majesticTf != null
                      ? <>{Math.round(r.majesticTf)}{r.majesticCf != null && <span style={{ color: "var(--color-text-tertiary)", fontWeight: 400 }}>/{Math.round(r.majesticCf)}</span>}</>
                      : "—"}
                  </td>
                  <td style={tdNum} title={tr("dropsSnapshotsHint")}>
                    {/* The number is the summary; the link is the archive itself. The starred
                        wildcard form is Wayback's own timeline view for the whole domain. */}
                    {r.waybackSnapshots != null
                      ? <a href={`https://web.archive.org/web/*/${r.domain}*`} target="_blank" rel="noreferrer"
                          style={{ color: "var(--color-accent-blue)", textDecoration: "none" }}>
                          {r.waybackSnapshots}
                        </a>
                      : "—"}
                  </td>
                  <td style={{ ...tdNum, fontWeight: 800, color: r.score != null ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}>
                    {r.score != null ? Math.round(r.score) : "—"}
                  </td>
                  <td style={{ ...td, color: "var(--color-text-tertiary)" }}>
                    {r.lastCheckedAt ? new Date(r.lastCheckedAt).toLocaleDateString() : tr("dropsNever")}
                  </td>
                </tr>
                {openLinks === r.domain && <tr style={{ borderTop: "1px solid var(--color-border)", background: "var(--color-bg)" }}>
                  <td colSpan={COLUMNS.length + 1} style={{ padding: 14 }}>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <button onClick={() => setOpenLinks(null)} style={pagerBtn(false)}>
                        {tr("dropsBacklinksHide")}
                      </button>
                    </div>
                    <BacklinkProfile dropDomain={r.domain} />
                  </td>
                </tr>}
              </Fragment>;
            })())}
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

/** A disabled enrichment button must look disabled — a greyed-out-looking normal button is
 * exactly how "I pressed it and nothing happened" reports are born. */
const ghostBtnDisabled = (disabled: boolean): React.CSSProperties =>
  disabled ? { ...ghostBtn, opacity: 0.45, cursor: "default" } : ghostBtn;

const th: React.CSSProperties = { padding: "9px 14px", fontWeight: 600, whiteSpace: "nowrap" };
const thNum: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "9px 14px", color: "var(--color-text-secondary)", whiteSpace: "nowrap" };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

/** The small icon buttons inside a group header row. */
const groupBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", padding: 3, borderRadius: 6,
  background: "none", border: "none", cursor: "pointer",
  color: "var(--color-text-tertiary)",
};

/** The bulk-bar group picker — native select, so it matches the pager select. */
const pagerSelect: React.CSSProperties = {
  border: "1px solid var(--color-border)", borderRadius: 7, background: "transparent",
  color: "var(--color-text-secondary)", padding: "5px 8px", fontSize: 12, cursor: "pointer",
};

function pagerBtn(disabled: boolean): React.CSSProperties {
  return {
    border: "1px solid var(--color-border)", borderRadius: 7, background: "transparent",
    color: disabled ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
    padding: "5px 12px", fontSize: 12, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
  };
}
