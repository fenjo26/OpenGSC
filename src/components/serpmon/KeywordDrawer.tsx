"use client";

// Keyword drawer — the history of one SERP behind a Market row. Three stacked views:
// the position chart (Y reversed, 1 on top, nulls break the line, failed snapshots marked on
// the floor), the snapshot list (status, got/depth, volatility, changes), and a two-column
// comparison of any two snapshots with entered/exited hosts highlighted.
//
// The parent mounts this component with a fresh `key` per keyword, so every open starts from
// clean state and the load effect runs exactly once per mount.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import {
  CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePersistedState } from "@/lib/usePersistedState";
import type { KeywordHistory, SerpRow, SnapshotView } from "@/lib/serpmon/types";
import { ChangeChips } from "./ChangeChip";
import {
  ErrorLine, fmtDate, fmtDateTime, getJson, StatusChip, problemLabel, trOf, VolBar,
} from "./shared";

// Ten host series need ten distinguishable colours; chart palettes are data ink, not theme.
const SERIES_COLORS = ["#2997ff", "#ff9f0a", "#34c759", "#bf5af2", "#ff453a", "#5e5ce6", "#30b0c7", "#ffd60a", "#ff375f", "#98989d"];

const isFlag = (v: unknown): boolean => v === "" || v === "1";

export default function KeywordDrawer({ keywordId, onClose }: {
  keywordId: string;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const tr = trOf(t);

  const [history, setHistory] = useState<KeywordHistory | null>(null);
  const [error, setError] = useState("");
  const [platforms, setPlatforms] = usePersistedState<string>("serpmonPlatforms", "", isFlag);

  // Compare selection: two snapshot ids from the list below.
  const [selA, setSelA] = useState<string | null>(null);
  const [selB, setSelB] = useState<string | null>(null);
  const [compare, setCompare] = useState<SnapshotView | null>(null);
  const [cmpBusy, setCmpBusy] = useState(false);
  const [cmpError, setCmpError] = useState("");

  useEffect(() => {
    let alive = true;
    getJson(`/api/serp-monitor/keywords/${keywordId}/history?limit=30`).then(({ status, body }) => {
      if (!alive) return;
      if (status >= 400) setError(String(body.error ?? status));
      else setHistory(body as unknown as KeywordHistory);
    }).catch((e: unknown) => {
      if (alive) setError(e instanceof Error ? e.message : String(e));
    });
    return () => { alive = false; };
  }, [keywordId]);

  const maxPos = useMemo(() => {
    if (!history) return 10;
    let m = 10;
    for (const h of history.hosts) for (const v of h.series) if (v != null && v > m) m = v;
    return Math.min(Math.max(m + 2, 10), 100);
  }, [history]);

  // One row per snapshot; every host series is aligned to the same index.
  const chartData = useMemo(() => {
    if (!history) return [];
    return history.snapshots.map((s, i) => {
      const row: Record<string, string | number | null> = {
        i, label: new Date(s.takenAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      };
      for (const h of history.hosts) row[h.host] = h.series[i];
      return row;
    });
  }, [history]);

  const loadCompare = useCallback(async () => {
    if (!selA || !selB || selA === selB || !history) return;
    const sa = history.snapshots.find(s => s.id === selA);
    const sb = history.snapshots.find(s => s.id === selB);
    if (!sa || !sb) return;
    // The newer snapshot is the one being looked at; the older one is what it is compared to.
    const newer = new Date(sa.takenAt) >= new Date(sb.takenAt) ? sa : sb;
    const older = newer === sa ? sb : sa;
    setCmpBusy(true); setCmpError(""); setCompare(null);
    try {
      const { status, body } = await getJson(`/api/serp-monitor/snapshots/${newer.id}?compare=${older.id}`);
      if (status >= 400) { setCmpError(String(body.error ?? status)); return; }
      setCompare(body as unknown as SnapshotView);
    } catch (e) {
      setCmpError(e instanceof Error ? e.message : String(e));
    } finally {
      setCmpBusy(false);
    }
  }, [selA, selB, history]);

  const diff = compare?.compare?.diff ?? null;
  const prevRows: SerpRow[] = compare?.compare?.rows ?? [];
  const curRows: SerpRow[] = compare?.rows ?? [];
  const enterHosts = useMemo(() => new Set((diff?.changes ?? []).filter(c => c.kind === "enter").map(c => c.host)), [diff]);
  const exitHosts = useMemo(() => new Set((diff?.changes ?? []).filter(c => c.kind === "exit").map(c => c.host)), [diff]);
  const moves = useMemo(() => {
    const m = new Map<string, "up" | "down">();
    for (const c of diff?.changes ?? []) if (c.kind === "up" || c.kind === "down") m.set(c.host, c.kind);
    return m;
  }, [diff]);

  const pickA = (id: string) => { setSelA(id === selA ? null : id); };
  const pickB = (id: string) => { setSelB(id === selB ? null : id); };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 900, background: "rgba(0,0,0,0.45)",
    }}>
      <aside onClick={e => e.stopPropagation()} style={{
        position: "absolute", top: 0, right: 0, height: "100%", width: "min(780px, 100vw)",
        background: "var(--color-bg)", borderLeft: "1px solid var(--color-border)",
        overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14, boxSizing: "border-box",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <h2 style={{ fontSize: 15, margin: 0, color: "var(--color-text-primary)" }}>
            {tr("serpmonHistoryTitle")}
          </h2>
          <button onClick={onClose} title={tr("serpmonCancel")}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: 4 }}>
            <X size={17} />
          </button>
        </div>

        {error && <ErrorLine>{error}</ErrorLine>}
        {!history && !error && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-text-secondary)" }}>
            <Loader2 size={14} className="spin" /> …
          </div>
        )}

        {history && (
          <>
            {/* Position chart */}
            <div style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="var(--color-border-soft)" />
                  <XAxis dataKey="i" tickFormatter={(i: number) => String(chartData[i]?.label ?? "")}
                    tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }}
                    tickLine={false} axisLine={{ stroke: "var(--color-border)" }} interval="preserveStartEnd" />
                  {/* Positions read bottom-up: #1 on top, tail at the bottom. */}
                  <YAxis reversed allowDecimals={false} domain={[1, maxPos]}
                    tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }}
                    tickLine={false} axisLine={false} />
                  <Tooltip labelFormatter={(label: unknown) => {
                    const i = Number(label);
                    return history.snapshots[i] ? fmtDateTime(history.snapshots[i].takenAt) : "";
                  }}
                    contentStyle={{
                      background: "var(--color-card)", border: "1px solid var(--color-border)",
                      borderRadius: 8, fontSize: 12,
                    }} />
                  <Legend wrapperStyle={{ fontSize: 10.5 }} iconSize={8} />
                  {/* Failed takes: a thick translucent red stub over that x column — there are no
                      positions to draw (a failed snapshot never joins a comparison), but the gap
                      must be visible, not read as "the host left the SERP". */}
                  {history.snapshots.map((s, i) => s.status === "failed" ? (
                    <ReferenceLine key={s.id} x={i} stroke="var(--color-danger)" strokeOpacity={0.3} strokeWidth={6} />
                  ) : null)}
                  {history.hosts.map((h, idx) => (
                    <Line key={h.host} dataKey={h.host} name={h.host}
                      stroke={SERIES_COLORS[idx % SERIES_COLORS.length]} strokeWidth={1.6}
                      dot={false} connectNulls={false} isAnimationActive={false} />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Snapshots */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                <b style={{ fontSize: 13, color: "var(--color-text-primary)" }}>{tr("serpmonSnapshots")}</b>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--color-text-secondary)", cursor: "pointer" }}>
                  <input type="checkbox" checked={platforms === "1"} onChange={e => setPlatforms(e.target.checked ? "1" : "")} />
                  {tr("serpmonShowPlatforms")}
                </label>
                <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{tr("serpmonCompareWith")} A / B</span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <tbody>
                    {history.snapshots.map(s => (
                      <tr key={s.id}>
                        <td style={{ padding: "4px 6px", whiteSpace: "nowrap", color: "var(--color-text-secondary)" }}>
                          {fmtDateTime(s.takenAt)}
                        </td>
                        <td style={{ padding: "4px 6px" }}>
                          <StatusChip status={s.status} problem={s.problem} tr={tr} />
                          {s.detail && (
                            <div title={s.detail} style={{
                              fontSize: 10.5, color: "var(--color-text-tertiary)", marginTop: 1,
                              maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            }}>{s.detail}</div>
                          )}
                        </td>
                        <td style={{ padding: "4px 6px", whiteSpace: "nowrap", color: "var(--color-text-secondary)", textAlign: "right" }}>
                          {s.got}/{s.depth}
                        </td>
                        <td style={{ padding: "4px 6px" }}><VolBar v={s.volatility} width={40} /></td>
                        <td style={{ padding: "4px 6px", whiteSpace: "nowrap", color: "var(--color-text-secondary)", textAlign: "right" }}
                          title={s.problem ? problemLabel(s.problem, tr) : undefined}>
                          {s.changeCount > 0 ? s.changeCount : "·"}
                        </td>
                        <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>
                          {(["A", "B"] as const).map(slot => {
                            const sel = slot === "A" ? selA : selB;
                            const pick = slot === "A" ? pickA : pickB;
                            return (
                              <button key={slot} onClick={() => pick(s.id)}
                                style={{
                                  marginLeft: 3, padding: "1px 7px", borderRadius: 6, fontSize: 10.5,
                                  fontWeight: 700, cursor: "pointer",
                                  border: `1px solid ${sel === s.id ? "var(--color-accent-blue)" : "var(--color-border)"}`,
                                  color: sel === s.id ? "var(--color-accent-blue)" : "var(--color-text-tertiary)",
                                  background: "transparent",
                                }}>
                                {slot}
                              </button>
                            );
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                <button onClick={() => void loadCompare()} disabled={!selA || !selB || selA === selB || cmpBusy}
                  style={{
                    padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer",
                    background: "var(--color-accent-blue)", color: "#fff", fontSize: 12.5, fontWeight: 600,
                    opacity: !selA || !selB || selA === selB || cmpBusy ? 0.5 : 1,
                    display: "inline-flex", alignItems: "center", gap: 6,
                  }}>
                  {cmpBusy ? <Loader2 size={12} className="spin" /> : null} {tr("serpmonCompare")}
                </button>
                {cmpError && <span style={{ fontSize: 12, color: "var(--color-danger)" }}>{cmpError}</span>}
              </div>
            </div>

            {/* Comparison */}
            {compare && diff && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                  <b style={{ fontSize: 13, color: "var(--color-text-primary)" }}>{tr("serpmonCompare")}</b>
                  <span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)" }}>
                    {fmtDate(compare.compare?.takenAt)} → {fmtDate(compare.takenAt)} · {tr("serpmonPosition")} 1…{diff.comparedDepth}
                  </span>
                  <VolBar v={diff.volatility} />
                </div>
                {diff.changes.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <ChangeChips changes={diff.changes} showPlatforms={platforms === "1"} />
                  </div>
                )}
                {diff.changes.length === 0 && (
                  <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginBottom: 8 }}>{tr("serpmonNoChanges")}</div>
                )}
                <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <tbody>
                      {Array.from({ length: Math.max(curRows.length, prevRows.length) }, (_, i) => {
                        const prev = prevRows[i];
                        const cur = curRows[i];
                        return (
                          <tr key={i}>
                            <td style={{ padding: "3px 6px", color: "var(--color-text-tertiary)", width: 34, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                              {i + 1}
                            </td>
                            <td style={{
                              padding: "3px 8px",
                              background: prev && exitHosts.has(prev.host) ? "rgba(255,69,58,0.10)" : "transparent",
                              maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              color: "var(--color-text-secondary)", textDecoration: prev && exitHosts.has(prev.host) ? "line-through" : "none",
                            }} title={prev ? `${prev.host} — ${prev.title}` : undefined}>
                              {prev ? prev.host : "—"}
                            </td>
                            <td style={{
                              padding: "3px 8px",
                              background: cur && enterHosts.has(cur.host) ? "rgba(52,199,89,0.10)" : "transparent",
                              maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              color: "var(--color-text-primary)",
                            }} title={cur ? `${cur.host} — ${cur.title}` : undefined}>
                              {cur ? cur.host : "—"}
                              {cur && moves.get(cur.host) && (
                                <span style={{
                                  marginLeft: 6, fontWeight: 700,
                                  color: moves.get(cur.host) === "up" ? "var(--color-success)" : "var(--color-danger)",
                                }}>
                                  {moves.get(cur.host) === "up" ? "↑" : "↓"}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
