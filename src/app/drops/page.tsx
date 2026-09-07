"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Boxes, Globe2, Loader2, Plus, Radar, Search, Square, Upload } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import type { DropSource, DropStage } from "@/lib/drops/types";

type Run = {
  id: string; label: string | null; source: string; sourceRef: string | null;
  total: number; skipped: number; createdAt: string;
};
type Candidate = {
  id: string; domain: string; tld: string; stage: DropStage;
  dr: number | null; refdomains: number | null; refdomainsDofollow: number | null;
  waybackSnapshots: number | null; score: number | null; lastCheckedAt: string | null;
  corroborated: boolean;
};
type ImportSummary = {
  accepted: number; inserted: number; reattached: number;
  skipped: number; skipReport: Record<string, number>;
};

const PAGE_SIZE = 100;

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
  const [orderBy, setOrderBy] = useState<"score" | "domain" | "createdAt">("score");
  const [offset, setOffset] = useState(0);

  const [showImport, setShowImport] = useState(false);
  const [raw, setRaw] = useState("");
  const [label, setLabel] = useState("");
  const [source, setSource] = useState<DropSource>("csv");
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState("");

  // DNS pre-filter progress. `dnsStop` is a ref, not state: the loop below reads it between
  // batches, and a state read there would be the value captured when the loop started.
  const [dnsBusy, setDnsBusy] = useState(false);
  const [dnsProgress, setDnsProgress] = useState<{ checked: number; retired: number; advanced: number; remaining: number } | null>(null);
  const dnsStop = useRef(false);

  // The registry stage. Same shape as the DNS loop and, deliberately, a separate control: it is
  // orders of magnitude slower and it is the one that talks to somebody else's servers.
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkProgress, setCheckProgress] = useState<{ checked: number; available: number; taken: number; deferred: number; remaining: number } | null>(null);
  const checkStop = useRef(false);

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
      const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), orderBy });
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
  }, [runId, stage, tld, q, orderBy, offset]);

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
  const filterKey = `${runId}|${stage}|${tld.trim()}|${q.trim()}|${orderBy}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    if (offset !== 0) setOffset(0);
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
   * Walk the pre-filter one batch at a time until the server says nothing is left.
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

  async function runRegistryCheck() {
    if (checkBusy) return;
    checkStop.current = false;
    setCheckBusy(true); setError("");
    const totals = { checked: 0, available: 0, taken: 0, deferred: 0, remaining: 0 };
    try {
      for (;;) {
        const res = await fetch("/api/drops/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: runId || undefined }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || "check_failed");
        totals.checked += body.checked ?? 0;
        totals.available += body.available ?? 0;
        totals.taken += body.taken ?? 0;
        totals.deferred += body.deferred ?? 0;
        totals.remaining = body.remaining ?? 0;
        setCheckProgress({ ...totals });
        // `done` also comes back when a whole batch was deferred — every zone in it is
        // throttled, and hammering them again in the same second would only deepen the backoff.
        if (body.done || body.checked === 0 || checkStop.current) break;
        await loadRows();
      }
      await loadRows();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckBusy(false);
    }
  }

  const zones = useMemo(() => [...new Set(rows.map(r => r.tld))].sort(), [rows]);
  const pageFrom = total === 0 ? 0 : offset + 1;
  const pageTo = Math.min(offset + PAGE_SIZE, total);

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
      {error && <div style={{ fontSize: 12, color: "#ff6b62" }}>{error}</div>}

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
      <button onClick={checkBusy ? () => { checkStop.current = true; } : runRegistryCheck} style={primaryBtn}>
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
      <select className="tool-input" style={{ width: 170 }} value={orderBy}
        onChange={e => setOrderBy(e.target.value as typeof orderBy)}>
        <option value="score">{tr("dropsSortScore")}</option>
        <option value="domain">{tr("dropsSortDomain")}</option>
        <option value="createdAt">{tr("dropsSortNew")}</option>
      </select>
    </div>

    <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid var(--color-border)", fontSize: 13 }}>
        <b>{tr("dropsFiltered")}: {total.toLocaleString()}</b>
        {loading && <Loader2 className="spin" size={14} color="var(--color-text-tertiary)" />}
      </div>

      {!loading && rows.length === 0 && <div style={{ padding: 34, textAlign: "center", fontSize: 13, color: "var(--color-text-secondary)" }}>
        {tr("dropsEmpty")}
      </div>}

      {rows.length > 0 && <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: "var(--color-text-tertiary)", textAlign: "left" }}>
              <th style={th}>{tr("dropsColDomain")}</th>
              <th style={th}>{tr("dropsStage")}</th>
              <th style={thNum}>DR</th>
              <th style={thNum}>{tr("dropsColRefdomains")}</th>
              <th style={thNum}>{tr("dropsColSnapshots")}</th>
              <th style={thNum}>{tr("dropsColScore")}</th>
              <th style={th}>{tr("dropsColChecked")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const s = STAGES.find(x => x.value === r.stage);
              return <tr key={r.id} style={{ borderTop: "1px solid var(--color-border)" }}>
                <td style={{ ...td, fontWeight: 600, color: "var(--color-text-primary)" }}>{r.domain}</td>
                <td style={td}>
                  <span style={{ color: s?.color ?? "var(--color-text-secondary)" }}>{s ? tr(s.key) : r.stage}</span>
                  {/* An `available` seen by one source only is not shown as free — it is shown as
                      needing another look. Everything downstream depends on that distinction. */}
                  {r.stage === "available" && !r.corroborated &&
                    <span title={tr("dropsUncorroborated")} style={{ marginLeft: 6, color: "var(--color-accent-orange, #ff9f0a)" }}>?</span>}
                </td>
                <td style={tdNum}>{r.dr ?? "—"}</td>
                <td style={tdNum}>{r.refdomainsDofollow ?? r.refdomains ?? "—"}</td>
                <td style={tdNum}>{r.waybackSnapshots ?? "—"}</td>
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

      {total > PAGE_SIZE && <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderTop: "1px solid var(--color-border)", fontSize: 12, color: "var(--color-text-secondary)" }}>
        <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0} style={pagerBtn(offset === 0)}>
          ← {tr("dropsPrev")}
        </button>
        <span>{pageFrom.toLocaleString()}–{pageTo.toLocaleString()} / {total.toLocaleString()}</span>
        <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={pageTo >= total} style={pagerBtn(pageTo >= total)}>
          {tr("dropsNext")} →
        </button>
      </div>}
    </div>
  </div>;
}

const primaryBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 7, padding: "8px 16px", borderRadius: 9,
  border: "none", background: "var(--color-accent-blue)", color: "#fff",
  fontSize: 13, fontWeight: 600, cursor: "pointer",
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
