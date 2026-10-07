"use client";

// Local → Geo-grid (wave G): one keyword checked at N×N coordinate points around the business,
// rendered as a coloured grid heatmap — where the map pack actually reaches (Local-Falcon-style,
// but orchestrated over the rank-check path this app already owns). No AI, no new services: the
// cost is gridSize² SERP queries on the workspace's configured provider (free on a personal
// A-Parser, metered elsewhere), and the estimate line says so BEFORE the run starts.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Grid3x3, Loader2, Play } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getSerpCreds } from "@/lib/seo/keys";
import type { LocalProfileData } from "@/lib/local/types";
import { estimateQueryCount, generateGridPoints } from "@/lib/localGrid/math";
import { pointRank, summarizePoints, type GridScanData, type GridScanPoint } from "@/lib/localGrid/run";
import { btnDisabled, btnPrimary, fieldLabel, inputStyle, sendJson, statusPill } from "./shared";

// Theme tokens, never hex: the three heatmap colours ARE the legend's three states.
const CELL_TOP3 = "var(--color-success)";
const CELL_4_10 = "var(--color-warning)";
const CELL_MISS = "var(--color-danger)";
const CELL_PENDING = "transparent"; // not answered yet — dashed border, no fill that could read as a verdict

type ScanStatus = GridScanData["status"];

const STATUS_TONE: Record<ScanStatus, "good" | "warn" | "bad" | "mute"> = {
  queued: "mute",
  running: "warn",
  done: "good",
  error: "bad",
};

const STATUS_KEY: Record<ScanStatus, string> = {
  queued: "gridStatusQueued",
  running: "gridStatusRunning",
  done: "gridStatusDone",
  error: "gridStatusError",
};

function cellColor(p: GridScanPoint | undefined): string {
  if (!p) return CELL_PENDING;
  if (p.error) return CELL_MISS;
  const rank = pointRank(p);
  if (rank === null) return CELL_MISS; // not found
  if (rank <= 3) return CELL_TOP3;
  if (rank <= 10) return CELL_4_10;
  return CELL_MISS; // found but beyond 10 — the number in the cell keeps it distinct from "not found"
}

/** The N×N heatmap of one scan. Pure props, no fetch — history rows just hand it a scan. */
function GridHeatmap({ scan, t }: { scan: GridScanData; t: ReturnType<typeof useLanguage>["t"] }) {
  // The answered points arrive progressively (the runner persists after every point), so the FULL
  // geometry comes from the row's own params and the map only fills in what has been answered.
  const geometry = useMemo(
    () => generateGridPoints({ centerLat: scan.centerLat, centerLng: scan.centerLng, gridSize: scan.gridSize, radiusKm: scan.radiusKm }),
    [scan.centerLat, scan.centerLng, scan.gridSize, scan.radiusKm],
  );
  const answered = new Map(scan.points.map(p => [`${p.row}:${p.col}`, p]));
  const summary = summarizePoints(scan.points);

  return (
    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: `repeat(${scan.gridSize}, minmax(0, 1fr))`,
        gap: 3, width: "min(320px, 100%)",
      }}>
        {geometry.map(g => {
          const p = answered.get(`${g.row}:${g.col}`);
          const rank = p ? pointRank(p) : null;
          const label = p
            ? (p.error ? "!" : rank === null ? "–" : String(rank))
            : "";
          const title = p
            ? [
                p.error ? p.error : p.businessName ? `${p.businessName} (${p.localPack})` : rank === null ? t("gridLegendNotFound") : `${t("gridLegend410")} / ${rank}`,
                `${g.lat.toFixed(4)}, ${g.lng.toFixed(4)}`,
              ].join(" · ")
            : undefined;
          return (
            <div key={`${g.row}:${g.col}`} title={title} style={{
              aspectRatio: "1", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, fontWeight: 600, color: "#fff",
              background: cellColor(p),
              border: p ? "none" : "1px dashed var(--color-border)",
            }}>{label}</div>
          );
        })}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12, color: "var(--color-text-secondary)", minWidth: 180 }}>
        {/* Legend — colour is never the only carrier: the cell prints its own number. */}
        {([["gridLegendTop3", CELL_TOP3], ["gridLegend410", CELL_4_10], ["gridLegendNotFound", CELL_MISS]] as const).map(([key, color]) => (
          <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: color, flexShrink: 0 }} />
            {t(key)}
          </span>
        ))}
        <div style={{ height: 1, background: "var(--color-border-soft)" }} />
        {/* t() has no interpolation — the numbers are composed here, per the i18n convention. */}
        <span>{t("gridAvgPosition")}: {summary.avgPosition === null ? "—" : summary.avgPosition}</span>
        <span>{t("gridInPack" as never)}: {summary.inPackShare === null ? "—" : `${Math.round(summary.inPackShare * 100)}%`}</span>
        {summary.errored > 0 && <span style={{ color: "var(--color-danger)" }}>{summary.errored} / {summary.total} !</span>}
        {scan.error && <span style={{ color: "var(--color-danger)" }} title={scan.error}>{scan.error.slice(0, 140)}</span>}
      </div>
    </div>
  );
}

export default function GridCard({ siteId, profile }: { siteId: string; profile: LocalProfileData | null }) {
  const { t, language } = useLanguage();
  const [keyword, setKeyword] = useState("");
  const [gridSize, setGridSize] = useState(5);
  const [radiusKm, setRadiusKm] = useState("2");
  const [useProfile, setUseProfile] = useState(true);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [provider, setProvider] = useState("");
  const [scans, setScans] = useState<GridScanData[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ error: string; hint?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/local/grid?siteId=${encodeURIComponent(siteId)}`).then(r => r.json());
      if (d.notMigrated) { setScans([]); return; }
      setScans((d.scans ?? []) as GridScanData[]);
    } catch { setScans([]); }
  }, [siteId]);

  // Initial load defers one tick (the set-state-in-effect lint rule every local card follows).
  useEffect(() => {
    const id = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(id);
  }, [load]);

  // Poll while a scan is in flight — the runner persists after every point, so partial grids
  // appear live. Stops the moment nothing is queued/running.
  const active = scans?.some(s => s.status === "queued" || s.status === "running") ?? false;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(id);
  }, [active, load]);

  // The provider chip reads the browser's mirrored setting; the row's own `provider` (what the
  // server actually resolved, rank override included) is the authority shown in history.
  // localStorage is client-only, so the read defers one tick after mount.
  useEffect(() => {
    const id = setTimeout(() => setProvider(getSerpCreds().provider), 0);
    return () => clearTimeout(id);
  }, []);

  const selected = useMemo(
    () => scans?.find(s => s.id === selectedId) ?? scans?.[0] ?? null,
    [scans, selectedId],
  );

  const queryCount = estimateQueryCount(gridSize);
  const canRun = !busy && keyword.trim() !== "" && (useProfile || (lat.trim() !== "" && lng.trim() !== ""));

  async function run() {
    setBusy(true);
    setProblem(null);
    const body: Record<string, unknown> = {
      siteId, keyword: keyword.trim(), gridSize, radiusKm: Number(radiusKm),
      ...(useProfile ? {} : { centerLat: Number(lat), centerLng: Number(lng) }),
    };
    const { ok, data } = await sendJson("/api/local/grid", "POST", body);
    setBusy(false);
    if (!ok) {
      // Route codes + hints travel verbatim — a refused run names the field that is wrong.
      setProblem({ error: String(data.error ?? "grid_create_failed"), hint: typeof data.hint === "string" ? data.hint : undefined });
      return;
    }
    setSelectedId(String((data.scan as GridScanData).id));
    await load();
  }

  return (
    <div className="panel" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", gap: 7 }}>
          <Grid3x3 size={15} /> {t("gridTitle")}
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 3 }}>{t("gridDesc")}</div>
      </div>

      {/* Form */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 560 }}>
        <div>
          <span style={fieldLabel}>{t("gridKeyword")}</span>
          <input style={{ ...inputStyle, width: "100%" }} value={keyword} onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && canRun) void run(); }} />
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div style={{ minWidth: 120 }}>
            <span style={fieldLabel}>{t("gridSize")}</span>
            <select style={{ ...inputStyle, width: "100%" }} value={gridSize} onChange={e => setGridSize(Number(e.target.value))}>
              <option value={3}>3×3</option>
              <option value={5}>5×5</option>
              <option value={7}>7×7</option>
            </select>
          </div>
          <div style={{ minWidth: 120 }}>
            <span style={fieldLabel}>{t("gridRadiusKm")}</span>
            <input style={{ ...inputStyle, width: "100%" }} type="number" min={0.1} max={100} step={0.1}
              value={radiusKm} onChange={e => setRadiusKm(e.target.value)} />
          </div>
          <div style={{ minWidth: 140 }}>
            <span style={fieldLabel}>{t("gridProvider")}</span>
            {/* Read-only chip: the provider is workspace config, not a per-scan choice. */}
            <div style={{ ...inputStyle, width: "100%", display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
              <span className="pill" style={{ fontSize: 11, padding: "2px 8px" }}>{provider || "—"}</span>
            </div>
          </div>
        </div>

        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--color-text-secondary)", cursor: "pointer" }}>
          <input type="checkbox" checked={useProfile} onChange={e => setUseProfile(e.target.checked)} />
          {t("gridUseProfile")}
          {useProfile && profile && profile.lat != null && profile.lng != null && (
            <span style={{ color: "var(--color-text-tertiary)" }}>({profile.lat.toFixed(4)}, {profile.lng.toFixed(4)})</span>
          )}
        </label>
        {!useProfile && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <div style={{ minWidth: 120 }}>
              <span style={fieldLabel}>lat</span>
              <input style={{ ...inputStyle, width: "100%" }} type="number" step={0.0001} value={lat} onChange={e => setLat(e.target.value)} />
            </div>
            <div style={{ minWidth: 120 }}>
              <span style={fieldLabel}>lng</span>
              <input style={{ ...inputStyle, width: "100%" }} type="number" step={0.0001} value={lng} onChange={e => setLng(e.target.value)} />
            </div>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button type="button" onClick={run} disabled={!canRun} style={{ ...btnPrimary, ...btnDisabled(!canRun) }}>
            {busy ? <Loader2 size={14} className="spin" /> : <Play size={13} />} {t("gridRun")}
          </button>
          {/* The cost statement BEFORE the run: N queries on the configured provider. */}
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            {queryCount} {t("gridEstimateQueries")} · {provider || "—"}
          </span>
        </div>

        {problem && (
          <div style={{ fontSize: 12, color: "var(--color-danger)" }}>
            {problem.error}{problem.hint ? ` — ${problem.hint}` : ""}
          </div>
        )}
      </div>

      {/* Result */}
      {selected && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            <strong style={{ color: "var(--color-text-primary)" }}>{selected.keyword}</strong> · {selected.gridSize}×{selected.gridSize} · {selected.radiusKm} km · {selected.provider}
            {selected.status === "running" && <Loader2 size={11} className="spin" style={{ marginLeft: 6, verticalAlign: "-1px" }} />}
          </div>
          <GridHeatmap scan={selected} t={t} />
        </div>
      )}

      {/* History — rows, not a table: the status pill carries its own text, so no header labels
          are needed (none exist for "status"/"date" among the pre-added keys). */}
      <div>
        <span style={fieldLabel}>{t("gridHistory")}</span>
        {scans === null ? (
          <div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>…</div>
        ) : scans.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{t("gridNoScans")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {scans.map(s => (
              <button key={s.id} type="button" onClick={() => setSelectedId(s.id)} style={{
                display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                padding: "7px 10px", borderRadius: 8, cursor: "pointer", textAlign: "left",
                border: selected?.id === s.id ? "1px solid var(--color-accent-blue)" : "1px solid var(--color-border-soft)",
                background: selected?.id === s.id ? "color-mix(in srgb, var(--color-accent-blue) 7%, transparent)" : "transparent",
              }}>
                <span style={statusPill(t(STATUS_KEY[s.status] as never), STATUS_TONE[s.status])}>
                  {s.status === "running" && <Loader2 size={10} className="spin" />}
                  {t(STATUS_KEY[s.status] as never)}
                </span>
                <span style={{ fontSize: 12.5, color: "var(--color-text-primary)", fontWeight: 600 }}>{s.keyword}</span>
                <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{s.gridSize}×{s.gridSize} · {s.radiusKm} km · {s.provider}</span>
                <span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)", marginLeft: "auto" }}>
                  {new Date(s.createdAt).toLocaleString(language, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
