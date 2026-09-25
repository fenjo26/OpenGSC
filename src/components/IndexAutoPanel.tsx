"use client";

// Automatic index checks (site → Indexing tab, wave-oct T4). The scheduler spends Google's free
// URL Inspection quota (2,000/day per property, reset at midnight Pacific) over a priority
// queue; this panel is its cockpit: on/off and budget, today's quota, the four queue numbers,
// 90-day coverage, why-not-indexed reasons, recent losses and a run-now button.
//
// The chart is hand-rolled SVG stacked area (DrSparkline approach — no chart dependency), with
// token colours plus the same status colours the Indexing tab's counter chips already use, and
// text labels so colour is never the only carrier of meaning.
//
// wave-nov N6 adds the site: section: Google's quota reaches only verified properties, so for
// URLs it could not inspect (or a site with no Google connection at all) the same table gets a
// second opinion from a `site:` SERP query — labelled as an ESTIMATE from the SERP, never as
// Google's verdict, priced before it runs (CONTRACT.md §0.5).

import { useEffect, useState } from "react";
import { Loader2, Play, RefreshCw, Save, Search } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { formatUsd } from "@/lib/seo/metricsClient";
import type { IndexAutoStatus, IndexInspectSettings } from "@/lib/indexing/types";

type Status = IndexAutoStatus & { noGoogle?: boolean };

type SerpIndexStatus = "indexed" | "not_indexed" | "error";

interface SerpRow {
  url: string;
  googleChecked: string | null;
  googleStatus: string | null;
  serpIndexStatus: SerpIndexStatus | null;
  serpIndexChecked: string | null;
  serpIndexProvider: string | null;
}

interface SerpEstimate {
  provider: string;
  queries: number;
  costUsd: number | null;
  free: boolean;
  unknownPrice: boolean;
}

const inputS: React.CSSProperties = {
  padding: "6px 9px", borderRadius: "8px", border: "1px solid var(--color-border)",
  background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "12px",
  outline: "none", width: "90px", boxSizing: "border-box",
};
const btn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 12px", borderRadius: "8px",
  border: "1px solid var(--color-border)", background: "var(--color-bg)",
  color: "var(--color-text-primary)", fontSize: "12px", fontWeight: 600, cursor: "pointer",
};
const labelS: React.CSSProperties = {
  fontSize: "11px", color: "var(--color-text-secondary)", display: "flex",
  alignItems: "center", gap: "8px", flexWrap: "wrap",
};
const sectionTitle: React.CSSProperties = {
  fontSize: "12px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0,
};

const SERIES = [
  { key: "indexed", color: "#4ADE80" },
  { key: "notIndexed", color: "#F87171" },
  { key: "unknown", color: "#FBBF24" },
] as const;

/** Stacked-area coverage chart: indexed at the base, not-indexed on top of it, unknown on top. */
function CoverageChart({ days, t }: { days: IndexAutoStatus["coverage"]; t: (k: never) => string }) {
  if (!days || days.length < 2) return null;
  const W = 620, H = 120, PAD = 3;
  const maxTotal = Math.max(1, ...days.map(d => d.total || d.indexed + d.notIndexed + d.unknown));
  const x = (i: number) => PAD + (i / (days.length - 1)) * (W - PAD * 2);
  const h = (v: number) => (v / maxTotal) * (H - PAD * 2);

  // Cumulative boundaries bottom-up; each band is the polygon between two of them.
  const cum = days.map(d => {
    let acc = 0;
    return SERIES.map(s => {
      acc += (d[s.key] as number) ?? 0;
      return acc;
    });
  });
  const boundary = (k: number) => cum.map((c, i) => `${x(i).toFixed(1)},${(H - PAD - h(c[k])).toFixed(1)}`);
  const base = days.map((_, i) => `${x(i).toFixed(1)},${(H - PAD).toFixed(1)}`);

  const last = days[days.length - 1];
  const labels: Record<string, string> = {
    indexed: t("idxAutoIndexed" as never), notIndexed: t("idxAutoNotIndexed" as never), unknown: t("idxAutoUnknown" as never),
  };
  const aria = `${t("idxAutoCoverage" as never)}: ${labels.indexed} ${last.indexed}, ${labels.notIndexed} ${last.notIndexed}, ${labels.unknown} ${last.unknown} (${last.day})`;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img" aria-label={aria}>
        {SERIES.map((s, k) => {
          const top = boundary(k);
          const bottom = [...(k === 0 ? base : boundary(k - 1))].reverse();
          return <polygon key={s.key} points={[...top, ...bottom].join(" ")} fill={s.color} opacity={0.75}>
            <title>{`${labels[s.key]}: ${last[s.key] as number}`}</title>
          </polygon>;
        })}
      </svg>
      <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", marginTop: "4px" }}>
        {SERIES.map(s => (
          <span key={s.key} style={{ fontSize: "11px", color: "var(--color-text-secondary)", display: "inline-flex", alignItems: "center", gap: "5px" }}>
            <span aria-hidden style={{ width: 9, height: 9, borderRadius: "2px", background: s.color, display: "inline-block" }} />
            {labels[s.key]} · {last[s.key] as number}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function IndexAutoPanel({ siteDbId, domain }: { siteDbId: string; domain: string }) {
  const { t } = useLanguage();
  const [status, setStatus] = useState<Status | null>(null);
  const [form, setForm] = useState<IndexInspectSettings | null>(null);
  const [noGoogle, setNoGoogle] = useState(false);
  const [notMigrated, setNotMigrated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState("");

  // ── site: index estimate (wave-nov N6) ──
  const [serpRows, setSerpRows] = useState<SerpRow[]>([]);
  const [serpPending, setSerpPending] = useState<string[]>([]);
  const [serpEst, setSerpEst] = useState<SerpEstimate | null>(null);
  const [serpBusy, setSerpBusy] = useState(false);
  const [serpMsg, setSerpMsg] = useState("");
  const [serpNoKey, setSerpNoKey] = useState(false);

  const loadSerpRows = async () => {
    try {
      const d = await fetch(`/api/indexing/serp-check?siteId=${encodeURIComponent(siteDbId)}`).then(r => r.json());
      if (d.notMigrated) return; // the Google half of the panel already shows the migration hint
      if (d.error) return;
      setSerpRows(d.rows ?? []);
      setSerpPending(d.pendingUrls ?? []);
    } catch { /* the site: section simply stays empty */ }
  };

  const load = async () => {
    try {
      const d = await fetch(`/api/indexing/auto?siteId=${encodeURIComponent(siteDbId)}`).then(r => r.json());
      if (d.notMigrated) { setNotMigrated(true); return; }
      if (d.error) { setMsg(String(d.error)); return; }
      setStatus(d as Status);
      setNoGoogle(!!(d as Status).noGoogle);
      setForm((d as Status).settings);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Initial load defers one tick: the react-hooks/set-state-in-effect rule this repo lints
  // with flags a fetch-then-setState helper called straight from the effect body (the whole
  // repo's older data panels carry that error as debt; new files are held to zero). A timeout
  // callback is a genuine async boundary, and the cleanup keeps a fast unmount from setting
  // state on a dead component.
  useEffect(() => {
    const id = setTimeout(() => { void load(); void loadSerpRows(); }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!form) return;
    setSaving(true); setSaved(false); setMsg("");
    try {
      const d = await fetch("/api/indexing/auto", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, settings: form }),
      }).then(r => r.json());
      if (d.error) setMsg(String(d.error));
      else {
        setStatus(prev => (prev ? { ...prev, ...d } : (d as Status)));
        setForm(d.settings);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    setSaving(false);
  };

  const runNow = async () => {
    setRunning(true); setMsg("");
    try {
      const d = await fetch("/api/indexing/auto/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // 30, not 50+: the loop paces itself at 1 s/URL, and a default proxy timeout of 60 s
        // would cut the response (the inspections still complete server-side) below that.
        body: JSON.stringify({ siteId: siteDbId, limit: 30 }),
      }).then(r => r.json());
      if (d.notMigrated) { setNotMigrated(true); return; }
      if (d.error) { setMsg(String(d.error)); return; }
      if (d.reason === "quota_exhausted") setMsg(`⚠ ${t("idxAutoExhausted")}`);
      else if (d.reason === "budget_spent") setMsg(`· ${t("idxAutoBudget")}: 0`);
      else setMsg(`✓ ${t("idxAutoRunDone").replace("{n}", String(d.inspected)).replace("{indexed}", String(d.indexed)).replace("{not}", String(d.notIndexed))}`);
      await load();
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    setRunning(false);
  };

  const num = (v: string, fallback: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : fallback; };

  // ── site: estimate (wave-nov N6) ──
  // Two-click discipline: the first click only prices the pending URLs (no SERP query), the
  // second runs them with confirm. The pending set is the honest "unknown" half — URLs Google's
  // own quota has not inspected — which is exactly where a site: answer adds information.
  const serpCostStr = (est: SerpEstimate): string =>
    est.free ? t("aparserNoCost") : est.costUsd != null ? formatUsd(est.costUsd) : "—";

  const serpCheck = async () => {
    if (serpBusy) return;
    if (!serpPending.length) return;
    setSerpBusy(true); setSerpMsg("");
    try {
      const res = await fetch("/api/indexing/serp-check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(serpEst ? { urls: serpPending, confirm: true } : { urls: serpPending }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.notMigrated) { setNotMigrated(true); setSerpBusy(false); return; }
      if (!serpEst) {
        // Price step. no_serp_key is a state, not a glitch: the section says what to configure.
        if (d.error === "no_serp_key") setSerpNoKey(true);
        else if (d.error) setSerpMsg(`✗ ${d.error}`);
        else { setSerpNoKey(false); setSerpEst({ provider: d.provider, queries: d.queries, costUsd: d.costUsd, free: d.free, unknownPrice: d.unknownPrice }); }
        setSerpBusy(false);
        return;
      }
      // Run step.
      if (!res.ok || d.error) {
        setSerpMsg(`✗ ${d.error === "no_serp_key" ? t("seoErrNoSerpKey") : d.error === "cap_exceeded" ? t("dmCapExceeded") : `${d.error}${d.detail ? `: ${d.detail}` : ""}`}`);
        setSerpEst(null);
        setSerpBusy(false);
        return;
      }
      const counts = d.counts ?? {};
      setSerpMsg(
        `✓ ${t("idxAutoRunDone").replace("{n}", String(d.queries ?? 0)).replace("{indexed}", String(counts.indexed ?? 0)).replace("{not}", String(counts.not_indexed ?? 0))}` +
        (d.errors ? ` · ${d.errors} ${t("idxSerp_error")}` : "") +
        (typeof d.costUsd === "number" && d.costUsd > 0 ? ` · ${formatUsd(d.costUsd)}` : ""),
      );
      setSerpEst(null);
      await loadSerpRows();
    } catch (e) {
      setSerpMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
    setSerpBusy(false);
  };

  const SERP_STATUS_COLOR: Record<SerpIndexStatus, string> = {
    indexed: "#4ADE80", not_indexed: "#F87171", error: "#FBBF24",
  };

  if (loading) {
    return (
      <div className="card" style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-text-secondary)", fontSize: "13px" }}>
        <Loader2 size={14} className="spin" /> {t("idxAutoTitle")}
      </div>
    );
  }

  if (notMigrated) {
    return (
      <div className="card" style={{ color: "var(--color-accent-orange)", fontSize: "13px" }}>
        {t("autoSyncNotMigrated")}
      </div>
    );
  }

  if (!status || !form) {
    return (
      <div className="card" style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
        {t("idxAutoTitle")}{msg ? ` — ${msg}` : ""}
      </div>
    );
  }

  const quotaPct = Math.min(100, Math.round((status.quota.used / Math.max(1, status.quota.limit)) * 100));

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("idxAutoTitle")}</span>
        <span style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "999px", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}>{t("idxAutoFree")}</span>
        <span style={{ flex: 1 }} />
        <button onClick={runNow} disabled={running || noGoogle} style={{ ...btn, opacity: running || noGoogle ? 0.5 : 1 }} title={domain}>
          {running ? <Loader2 size={12} className="spin" /> : <Play size={12} />} {t("idxAutoRunNow")}
        </button>
        <button onClick={load} style={btn} aria-label="refresh">
          <RefreshCw size={12} />
        </button>
      </div>
      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("idxAutoHint")}</div>

      {msg && (
        <div style={{ fontSize: "12px", color: msg.startsWith("✓") ? "var(--color-accent-green)" : msg.startsWith("⚠") ? "var(--color-accent-orange)" : "var(--color-accent-red)", wordBreak: "break-word" }}>
          {msg}
        </div>
      )}

      {/* site: estimate (wave-nov N6) — Google's quota cannot reach everything; the SERP can.
          Always labelled as an estimate from the search results, never as Google's verdict. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <h4 style={sectionTitle}>
          {t("idxSerpColumn")}
          <span style={{ fontWeight: 400, color: "var(--color-text-secondary)" }} title={t("idxSerpHint")}> — {t("idxSerpHint")}</span>
        </h4>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <button
            onClick={() => void serpCheck()}
            disabled={serpBusy || !serpPending.length}
            style={{ ...btn, opacity: serpBusy || !serpPending.length ? 0.5 : 1 }}
            title={serpPending.length ? `${serpPending.length} URL` : t("idxSerpHint")}
          >
            {serpBusy ? <Loader2 size={12} className="spin" /> : <Search size={12} />}
            {t("idxSerpCheck")}
            {serpEst ? ` · ${serpCostStr(serpEst)}` : ""}
          </button>
          {serpEst && (
            <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>
              {t("plgEstimate").replace("{n}", String(serpEst.queries)).replace("{provider}", serpEst.provider).replace("{cost}", serpCostStr(serpEst))}
            </span>
          )}
          {serpNoKey && <span style={{ fontSize: "12px", color: "var(--color-accent-red)" }}>{t("seoErrNoSerpKey")}</span>}
          {serpMsg && (
            <span style={{ fontSize: "12px", color: serpMsg.startsWith("✓") ? "var(--color-accent-green)" : "var(--color-accent-red)", wordBreak: "break-word" }}>
              {serpMsg}
            </span>
          )}
        </div>
        {serpRows.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", fontWeight: 600, color: "var(--color-text-secondary)", padding: "4px 8px 4px 0", fontSize: "11px" }}>URL</th>
                  <th style={{ textAlign: "left", fontWeight: 600, color: "var(--color-text-secondary)", padding: "4px 8px", fontSize: "11px" }} title={t("idxSerpHint")}>{t("idxSerpColumn")}</th>
                </tr>
              </thead>
              <tbody>
                {serpRows.slice(0, 10).map(r => (
                  <tr key={r.url}>
                    <td style={{ padding: "3px 8px 3px 0", maxWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.url}>
                      {r.url}
                    </td>
                    <td style={{ padding: "3px 8px", whiteSpace: "nowrap" }}>
                      {r.serpIndexStatus ? (
                        <span
                          style={{ color: SERP_STATUS_COLOR[r.serpIndexStatus], fontWeight: 600 }}
                          title={`${t("idxSerpHint")} · ${r.serpIndexProvider ?? ""} · ${r.serpIndexChecked ?? ""}`}
                          aria-label={`${t(`idxSerp_${r.serpIndexStatus}`)} (${t("idxSerpHint")})`}
                        >
                          {t(`idxSerp_${r.serpIndexStatus}`)}
                        </span>
                      ) : (
                        <span style={{ color: "var(--color-text-secondary)" }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {noGoogle ? (
        <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("idxAutoNoGoogle")}</div>
      ) : (
        <>
          {/* settings */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <label style={labelS}>
              <input type="checkbox" checked={form.on} onChange={e => setForm({ ...form, on: e.target.checked })} />
              {t("idxAutoOn")}
            </label>
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
              <label style={labelS}>
                {t("idxAutoBudget")}
                <input type="number" min={0} max={1800} step={50} value={form.dailyBudget}
                  onChange={e => setForm({ ...form, dailyBudget: num(e.target.value, form.dailyBudget) })} style={inputS} />
              </label>
              <label style={labelS}>
                {t("idxAutoRecheckIndexed")}
                <input type="number" min={1} max={365} value={form.recheckIndexedDays}
                  onChange={e => setForm({ ...form, recheckIndexedDays: num(e.target.value, form.recheckIndexedDays) })} style={inputS} />
              </label>
              <label style={labelS}>
                {t("idxAutoRecheckNot")}
                <input type="number" min={1} max={365} value={form.recheckNotIndexedDays}
                  onChange={e => setForm({ ...form, recheckNotIndexedDays: num(e.target.value, form.recheckNotIndexedDays) })} style={inputS} />
              </label>
            </div>
            <div style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
              <label style={labelS}>
                <input type="checkbox" checked={form.alertOnLoss} onChange={e => setForm({ ...form, alertOnLoss: e.target.checked })} />
                {t("idxAutoAlertLoss")}
              </label>
              <button onClick={save} disabled={saving} style={{ ...btn, marginLeft: "auto" }}>
                {saving ? <Loader2 size={12} className="spin" /> : saved ? <span>✓</span> : <Save size={12} />}
                {saved ? t("apiKeySaved") : t("setSave")}
              </button>
            </div>
          </div>

          {/* quota */}
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            <span style={{ fontSize: "12px", color: "var(--color-text-primary)" }}>
              {t("idxAutoQuota").replace("{used}", String(status.quota.used)).replace("{limit}", String(status.quota.limit)).replace("{auto}", String(status.quota.auto))}
            </span>
            <div style={{ height: "6px", borderRadius: "3px", background: "var(--color-border)", overflow: "hidden" }} role="progressbar"
              aria-valuemin={0} aria-valuemax={status.quota.limit} aria-valuenow={status.quota.used} aria-label={t("idxAutoQuota").replace("{used}", String(status.quota.used)).replace("{limit}", String(status.quota.limit)).replace("{auto}", String(status.quota.auto))}>
              <div style={{ width: `${quotaPct}%`, height: "100%", background: status.quota.exhausted ? "var(--color-accent-red)" : "var(--color-accent-blue)" }} />
            </div>
            {status.quota.exhausted && (
              <span style={{ fontSize: "12px", color: "var(--color-accent-red)" }}>⚠ {t("idxAutoExhausted")}</span>
            )}
          </div>

          {/* queue */}
          <div>
            <h4 style={sectionTitle}>{t("idxAutoQueue")}</h4>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "6px" }}>
              {(["new", "changed", "not_indexed", "stale_indexed"] as const).map(p => (
                <span key={p} title={t(`idxAutoPri_${p}`)}
                  style={{ fontSize: "11px", padding: "3px 10px", borderRadius: "999px", border: "1px solid var(--color-border)", display: "inline-flex", gap: "6px", alignItems: "center" }}>
                  {t(`idxAutoPri_${p}`)}
                  <b style={{ color: "var(--color-text-primary)" }}>{status.queue[p]}</b>
                </span>
              ))}
            </div>
          </div>

          {/* coverage */}
          {status.coverage.length >= 2 && (
            <div>
              <h4 style={sectionTitle}>{t("idxAutoCoverage")}</h4>
              <div style={{ marginTop: "6px" }}>
                <CoverageChart days={status.coverage} t={t} />
              </div>
            </div>
          )}

          {/* reasons */}
          {status.reasons.length > 0 && (
            <div>
              <h4 style={sectionTitle}>{t("idxAutoReasons")}</h4>
              <div style={{ marginTop: "6px", display: "flex", flexDirection: "column", gap: "3px", maxHeight: "180px", overflowY: "auto" }}>
                {status.reasons.map(r => (
                  <div key={r.coverageState} style={{ display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "12px" }}>
                    <span style={{ color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.coverageState}>{r.coverageState}</span>
                    <b style={{ color: "var(--color-text-primary)" }}>{r.count}</b>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* recent losses */}
          {status.recentLosses.length > 0 && (
            <div>
              <h4 style={sectionTitle}>{t("idxAutoLosses")}</h4>
              <div style={{ marginTop: "6px", display: "flex", flexDirection: "column", gap: "3px" }}>
                {status.recentLosses.map(l => (
                  <div key={l.url} style={{ display: "flex", gap: "8px", fontSize: "12px", alignItems: "baseline", flexWrap: "wrap" }}>
                    <span style={{ color: "var(--color-accent-red)" }} aria-hidden>▼</span>
                    <span style={{ color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }} title={l.url}>{l.url}</span>
                    <span style={{ color: "var(--color-text-secondary)", fontSize: "11px" }}>{l.coverageState ?? ""}</span>
                    <b style={{ color: "var(--color-text-primary)", marginLeft: "auto" }}>{l.clicks28d}</b>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
