"use client";

// Storms tab — each done run's median volatility against the project's OWN background. The
// baseline band is computed client-side from the same run series with the pure functions from
// lib/serpmon/volatility (median + MAD), thresholded exactly like stormVerdict does:
// median + STORM_Z × (1.4826·MAD + 0.005). Until STORM_MIN_BASELINE done runs exist the verdict
// says "calibrating" — the chart still draws, it just must not be read as a verdict.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { ALGO_UPDATE_COLORS, type AlgoUpdate, type AlgoUpdateType } from "@/lib/algoUpdates";
// Pure functions and constants only — volatility.ts has no server dependencies, so the band the
// user sees is computed with the exact same math the server's stormVerdict uses.
import { mad, median } from "@/lib/serpmon/volatility";
import { STORM_BASELINE_RUNS, STORM_MIN_BASELINE, STORM_Z, type RunSummary } from "@/lib/serpmon/types";
import { ErrorLine, fmtDateTime, fmtShare, getJson, trOf, VolBar } from "./shared";

interface StormPoint {
  i: number;
  label: string;
  full: string;
  volatility: number;
  volTop10: number | null;
  storm: boolean;
  calibrating: boolean;
  /** [low, high] of the project's own background — a recharts range Area. */
  band: [number, number] | null;
}

interface ShakenRow { keywordId: string; keyword: string; volatility: number | null; changes: number }

export default function StormsTab({ projectId, runs, version }: {
  projectId: string;
  /** Newest first, as /runs returns them. */
  runs: RunSummary[];
  version: number;
}) {
  const { t } = useLanguage();
  const tr = trOf(t);

  const [updates, setUpdates] = useState<AlgoUpdate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [shaken, setShaken] = useState<ShakenRow[] | null>(null);
  const [error, setError] = useState("");

  const done = useMemo(() => runs.filter(r => r.status === "done" && r.volatility != null), [runs]);
  const calibrating = done.length < STORM_MIN_BASELINE;

  // Oldest first for the chart; each point carries the band the runs BEFORE it imply, so the
  // band on day N is exactly what the verdict for run N was measured against.
  const points: StormPoint[] = useMemo(() => {
    const oldestFirst = [...done].reverse();
    return oldestFirst.map((r, i) => {
      const before = oldestFirst.slice(0, i).map(p => p.volatility as number).slice(-STORM_BASELINE_RUNS);
      let band: [number, number] | null = null;
      if (before.length >= 2) {
        const med = median(before);
        const spread = STORM_Z * (1.4826 * mad(before) + 0.005);
        band = [Math.max(0, med - spread), Math.min(1, med + spread)];
      }
      return {
        i,
        label: new Date(r.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        full: fmtDateTime(r.startedAt),
        volatility: r.volatility as number,
        volTop10: r.volTop10,
        storm: r.storm,
        calibrating: r.calibrating,
        band,
      };
    });
  }, [done]);

  // Rolling baseline band, drawn as a range area. Volatility and the band share the 0..1 axis.
  const bandData = useMemo(() => points.map(p => ({ ...p, band: p.band ?? undefined })), [points]);

  // A finished run replaces the runs list; an old selection would then point at a run the
  // "most shaken" panel cannot describe. Corrected during render, before any effect fires.
  const [lastVersion, setLastVersion] = useState(version);
  if (version !== lastVersion) {
    setLastVersion(version);
    if (selected !== null) {
      setSelected(null);
      setShaken(null);
    }
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/gsc/algo-updates", { cache: "no-store" });
        const body = await res.json();
        if (alive && Array.isArray(body)) setUpdates(body as AlgoUpdate[]);
      } catch { /* decorative overlay; the chart works without it */ }
    })();
    return () => { alive = false; };
  }, []);

  // "Most shaken" is only answerable for the LATEST done run: market?sort=volatility reads the
  // current market, not a historical one. For older runs the API has no per-run keyword
  // volatility listing (see T5 report — candidate API), so the panel only opens on the latest.
  const latestDoneId = done.length ? done[0].id : null;

  const selectRun = useCallback((id: string) => {
    setSelected(prev => (prev === id ? null : id));
    setShaken(null);
    if (id !== latestDoneId) return;
    void (async () => {
      try {
        const { status, body } = await getJson(`/api/serp-monitor/projects/${projectId}/market?sort=volatility&page=1&pageSize=10`);
        if (status >= 400) { setError(String(body.error ?? status)); return; }
        const rows = (Array.isArray(body.rows) ? body.rows : []) as {
          keywordId: string; keyword: string; volatility: number | null; changes: { hidden: boolean }[];
        }[];
        setShaken(rows.map(r => ({
          keywordId: r.keywordId, keyword: r.keyword, volatility: r.volatility,
          changes: Array.isArray(r.changes) ? r.changes.filter(c => !c.hidden).length : 0,
        })));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [latestDoneId, projectId]);

  // Algo-update bands → index ranges on the numeric x axis. An update whose window does not
  // overlap any run is simply not drawn.
  const updateBands = useMemo(() => {
    if (!points.length) return [];
    const dateOf = (idx: number) => done[done.length - 1 - idx]?.startedAt.slice(0, 10) ?? "";
    const out: { key: string; name: string; type: AlgoUpdateType; x1: number; x2: number }[] = [];
    for (const u of updates) {
      const end = u.end ?? u.date;
      let x1 = -1, x2 = -1;
      for (let i = 0; i < points.length; i++) {
        const d = dateOf(i);
        if (x1 === -1 && d >= u.date) x1 = i;
        if (d <= end) x2 = i;
      }
      if (x1 === -1 || x2 < x1) continue;
      out.push({ key: `${u.name}-${u.date}`, name: u.name, type: u.type, x1, x2 });
    }
    return out;
  }, [updates, points, done]);

  if (runs.length === 0) {
    // No checks yet (or still loading): the calibrating sentence is the honest placeholder.
    return (
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", padding: "18px 0" }}>
        {tr("serpmonStormsCalibrating").replace("{n}", String(done.length)).replace("{min}", String(STORM_MIN_BASELINE))}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {calibrating && (
        <div className="panel" style={{ fontSize: 12.5, color: "var(--color-accent-orange)" }}>
          {tr("serpmonStormsCalibrating").replace("{n}", String(done.length)).replace("{min}", String(STORM_MIN_BASELINE))}
        </div>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}

      {/* Volatility chart */}
      <div className="panel" style={{ padding: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
          <b style={{ fontSize: 13, color: "var(--color-text-primary)" }}>{tr("serpmonBaseline")}</b>
          <span style={{ fontSize: 11, display: "inline-flex", alignItems: "center", gap: 5, color: "var(--color-text-secondary)" }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(41,151,255,0.25)", display: "inline-block" }} />
            {tr("serpmonGoogleUpdates")}
          </span>
        </div>
        {points.length >= 2 ? (
          <div style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={bandData} margin={{ top: 8, right: 10, bottom: 0, left: -14 }}>
                <CartesianGrid stroke="var(--color-border-soft)" />
                <XAxis dataKey="i" type="number" domain={[0, Math.max(points.length - 1, 1)]} allowDecimals={false}
                  tickFormatter={(i: number) => points[i]?.label ?? ""}
                  tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }} tickLine={false}
                  axisLine={{ stroke: "var(--color-border)" }} />
                <YAxis domain={[0, 1]} tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }}
                  tickLine={false} axisLine={false} />
                <Tooltip labelFormatter={(i: unknown) => points[Number(i)]?.full ?? ""}
                  contentStyle={{
                    background: "var(--color-card)", border: "1px solid var(--color-border)",
                    borderRadius: 8, fontSize: 12,
                  }} />
                <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
                {updateBands.map(b => (
                  <ReferenceArea key={b.key} x1={b.x1} x2={b.x2} y1={0} y2={1}
                    fill={ALGO_UPDATE_COLORS[b.type]} fillOpacity={0.08} stroke="none"
                    ifOverflow="extendDomain" />
                ))}
                <Area dataKey="band" name={tr("serpmonBaseline")} stroke="none"
                  fill="var(--color-accent-blue)" fillOpacity={0.12} isAnimationActive={false}
                  connectNulls={false} />
                <Line dataKey="volatility" name={tr("serpmonColVolatility")} stroke="var(--color-accent-blue)"
                  strokeWidth={2} isAnimationActive={false}
                  dot={(props: { cx?: number; cy?: number; payload?: StormPoint }) => {
                    const p = props.payload;
                    if (props.cx == null || props.cy == null || !p) return <g key="d" />;
                    return p.storm ? (
                      <circle key={p.i} cx={props.cx} cy={props.cy} r={4.5} fill="var(--color-danger)" stroke="none" />
                    ) : (
                      <circle key={p.i} cx={props.cx} cy={props.cy} r={2} fill="var(--color-accent-blue)" stroke="none" />
                    );
                  }} />
                <Line dataKey="volTop10" name="Top 10" stroke="var(--color-accent-blue)" strokeOpacity={0.45}
                  strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", padding: "14px 0" }}>
            {tr("serpmonStormsCalibrating").replace("{n}", String(done.length)).replace("{min}", String(STORM_MIN_BASELINE))}
          </div>
        )}
      </div>

      {/* Most shaken — latest done run only (API gap for older runs, see report). */}
      {selected && selected === latestDoneId && shaken !== null && (
        <div className="panel" style={{ padding: 12 }}>
          <b style={{ fontSize: 13, color: "var(--color-text-primary)" }}>{tr("serpmonTopShaken")}</b>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
            {shaken.map(r => (
              <div key={r.keywordId} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
                <span style={{ flex: 1, minWidth: 140, overflowWrap: "anywhere", color: "var(--color-text-primary)" }}>{r.keyword}</span>
                <VolBar v={r.volatility} width={80} />
                <span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)", width: 70, textAlign: "right" }}>
                  {r.changes > 0 ? `${tr("serpmonColChanges")}: ${r.changes}` : ""}
                </span>
              </div>
            ))}
            {shaken.length === 0 && <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>—</span>}
          </div>
        </div>
      )}
      {/* Runs table */}
      <div className="panel">
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-border)" }}>
          <b style={{ fontSize: 13, color: "var(--color-text-primary)" }}>{tr("serpmonRunsTable")}</b>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 11.5, color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)" }}>{tr("serpmonLastRun")}</th>
                <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 11.5, color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)" }}>#</th>
                <th style={{ padding: "8px 12px", textAlign: "right", fontSize: 11.5, color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)" }}>OK / ▲ / ✕</th>
                <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 11.5, color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)" }}>{tr("serpmonColVolatility")}</th>
                <th style={{ padding: "8px 12px", textAlign: "right", fontSize: 11.5, color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)" }}>{tr("serpmonShareHigh")}</th>
                <th style={{ padding: "8px 12px", textAlign: "right", fontSize: 11.5, color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)" }}>{tr("serpmonStormScore")}</th>
                <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 11.5, color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)" }}></th>
              </tr>
            </thead>
            <tbody>
              {runs.map(r => (
                <tr key={r.id} onClick={() => r.status === "done" && r.volatility != null && selectRun(r.id)}
                  style={{ cursor: r.status === "done" && r.volatility != null ? "pointer" : "default" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--color-card-hover)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
                  <td style={{ padding: "8px 12px", color: "var(--color-text-primary)", whiteSpace: "nowrap" }}>
                    {fmtDateTime(r.startedAt)}
                    {r.trigger === "manual" && <span style={{ color: "var(--color-text-tertiary)", marginLeft: 6 }}>· {r.trigger}</span>}
                  </td>
                  <td style={{ padding: "8px 12px", color: "var(--color-text-secondary)", whiteSpace: "nowrap", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {r.ok}/{r.partial}/{r.failed}
                  </td>
                  <td style={{ padding: "8px 12px", color: "var(--color-text-secondary)", whiteSpace: "nowrap", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {r.ok + r.partial + r.failed}/{r.planned}
                  </td>
                  <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}><VolBar v={r.volatility} width={60} /></td>
                  <td style={{ padding: "8px 12px", color: "var(--color-text-secondary)", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                    {fmtShare(r.shareHigh)}
                  </td>
                  <td style={{
                    padding: "8px 12px", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
                    color: r.storm ? "var(--color-danger)" : "var(--color-text-secondary)",
                    fontWeight: r.storm ? 700 : 400,
                  }}>
                    {r.stormScore == null ? "—" : r.stormScore.toFixed(1)}
                  </td>
                  <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                    {r.storm && (
                      <span style={{ fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 6, background: "rgba(255,69,58,0.12)", color: "var(--color-danger)" }}>
                        {tr("serpmonStormBadge")}
                      </span>
                    )}
                    {r.calibrating && !r.storm && (
                      <span style={{ fontSize: 10.5, padding: "1px 7px", borderRadius: 6, color: "var(--color-text-tertiary)" }}>
                        · {tr("serpmonBaseline")}
                      </span>
                    )}
                    {r.error === "all_failed" && (
                      <span style={{ fontSize: 11.5, color: "var(--color-danger)" }}>{tr("serpmonRunAllFailed")}</span>
                    )}
                    {r.error && r.error !== "all_failed" && (
                      // e.g. an aborted mass failure — the raw provider error is the only useful
                      // thing about such a run, so show it (truncated, full text on hover).
                      <span title={r.error} style={{ fontSize: 11, color: "var(--color-danger)" }}>
                        {r.error.length > 64 ? `${r.error.slice(0, 64)}…` : r.error}
                      </span>
                    )}
                    {r.status === "running" && <Loader2 size={12} className="spin" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
