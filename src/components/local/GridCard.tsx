"use client";

// Local → Geo-grid (wave G): one keyword checked at N×N coordinate points around the business,
// rendered as a coloured grid heatmap — where the map pack actually reaches (Local-Falcon-style,
// but orchestrated over the rank-check path this app already owns). No AI, no new services: the
// cost is gridSize² SERP queries on the workspace's configured provider (free on a personal
// A-Parser, metered elsewhere), and the estimate line says so BEFORE the run starts.
//
// R+: the scan became REPEATABLE — saved presets ("SKG airport", "Thessaloniki centre",
// "Halkidiki resort zone") with point + radius + grid + answer language + a cron schedule the
// scheduler fires; each preset carries its own DYNAMICS series (avg position and in-pack share
// across its scans). The schedule control compiles human choices into cron — free-text cron
// never reaches the operator.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Grid3x3, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getSerpCreds } from "@/lib/seo/keys";
import { LANGUAGES, defaultLanguageFor } from "@/lib/seo/regions";
import type { LocalProfileData } from "@/lib/local/types";
import { estimateQueryCount, generateGridPoints } from "@/lib/localGrid/math";
import { pointRank, summarizePoints, type GridScanData, type GridScanPoint } from "@/lib/localGrid/summary";
import type { GridPresetData } from "@/lib/localGrid/preset";
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

// ─── R+ preset helpers ─────────────────────────────────────────────────────────

/** Language display label; the raw code is its own honest fallback for codes not in the list. */
function langLabel(code: string): string {
  return LANGUAGES.find(l => l.code === code)?.label ?? code;
}

/**
 * The language select both forms share: "" = the profile-country default (the option shows
 * WHICH language that resolves to today, so the default is never a mystery), or an explicit
 * 2-letter override for the tourist markets. The hint line under it explains the default.
 */
function LangSelect({ value, onChange, defaultHl }: { value: string; onChange: (v: string) => void; defaultHl: string }) {
  return (
    <select style={{ ...inputStyle, width: "100%" }} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">auto · {langLabel(defaultHl)}</option>
      {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
    </select>
  );
}

type SchedMode = "manual" | "days" | "weekly";

/** "HH" / "HH:MM" → parts; null = not a valid time (the field is refused, not guessed at). */
function parseHhMm(v: string): { h: number; m: number } | null {
  const mm = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!mm) return null;
  const h = Number(mm[1]), m = Number(mm[2]);
  return h <= 23 && m <= 59 ? { h, m } : null;
}

/**
 * Compile the human schedule into the 5-field cron the scheduler reads (UTC — the cron
 * matcher is UTC, and the time field says so). null = invalid inputs (bad time, N out of
 * range): the Create button stays disabled rather than firing a guessed schedule.
 *
 *   days   N + HH:MM → "M H star/N star star"  (vixie day-of-month stepping — "every N days")
 *   weekly D + HH:MM → "M H star star D"       (0 = Sunday, the matcher's own convention)
 */
function compileSchedule(mode: SchedMode, days: number, weekday: number, time: string): string | null {
  if (mode === "manual") return "";
  const t = parseHhMm(time);
  if (!t) return null;
  if (mode === "days") {
    if (!Number.isFinite(days) || days < 1 || days > 365) return null;
    return `${t.m} ${t.h} */${Math.round(days)} * *`;
  }
  if (!Number.isFinite(weekday) || weekday < 0 || weekday > 6) return null;
  return `${t.m} ${t.h} * * ${Math.round(weekday)}`;
}

/** Short weekday names straight from Intl — no locale keys needed for 7 words. */
function weekdayLabels(language: string): string[] {
  // 2024-01-07 is a Sunday; +d walks the week in the matcher's 0=Sunday convention.
  return Array.from({ length: 7 }, (_, d) =>
    new Date(2024, 0, 7 + d).toLocaleDateString(language, { weekday: "short" }));
}

/** The dynamics of one preset: avg position (up = better, both axes reversed) + in-pack share. */
function PresetDynamics({ preset, t, language }: {
  preset: GridPresetData;
  t: ReturnType<typeof useLanguage>["t"];
  language: string;
}) {
  const series = preset.scans.map(s => ({
    label: new Date(s.createdAt).toLocaleDateString(language, { month: "short", day: "numeric" }),
    // t() has no interpolation — the tooltip names are composed from existing keys.
    avg: s.summary.avgPosition,
    pack: s.summary.inPackShare === null ? null : Math.round(s.summary.inPackShare * 100),
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
      {series.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{t("gridNoScans")}</div>
      ) : (
        <>
          <div style={{ width: "100%", height: 130 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 6, right: 30, left: 0, bottom: 0 }}>
                {/* Rank axes are reversed everywhere in this app: rank 1 sits at the top. */}
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }} />
                <YAxis yAxisId="pos" reversed domain={[1, "dataMax"]} allowDecimals={false} axisLine={false} tickLine={false}
                  tick={{ fontSize: 10, fill: "#3B82F6" }} width={28} />
                <YAxis yAxisId="pack" orientation="right" domain={[0, 100]} axisLine={false} tickLine={false}
                  tick={{ fontSize: 10, fill: "#8B5CF6" }} width={34} tickFormatter={(v: number) => `${v}%`} />
                <Tooltip contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "8px", fontSize: "12px" }} />
                <Line yAxisId="pos" name={t("gridAvgPosition")} type="monotone" dataKey="avg" stroke="#3B82F6"
                  strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
                <Line yAxisId="pack" name={t("gridInPack")} type="monotone" dataKey="pack" stroke="#8B5CF6"
                  strokeWidth={1.5} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {/* The inline list under the sparkline — the chart's numbers, readable as text. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {preset.scans.slice().reverse().map(s => (
              <span key={s.id} style={{ fontSize: 11.5, color: "var(--color-text-secondary)", display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span style={{ color: "var(--color-text-tertiary)" }}>
                  {new Date(s.createdAt).toLocaleString(language, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
                <span>{t("gridAvgPosition")}: {s.summary.avgPosition === null ? "—" : s.summary.avgPosition}</span>
                <span>{t("gridInPack")}: {s.summary.inPackShare === null ? "—" : `${Math.round(s.summary.inPackShare * 100)}%`}</span>
                <span style={{ color: "var(--color-text-tertiary)" }}>hl: {s.hl || "—"}</span>
                {s.summary.errored > 0 && <span style={{ color: "var(--color-danger)" }}>{s.summary.errored} / {s.summary.total} !</span>}
              </span>
            ))}
          </div>
        </>
      )}
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
  const [hl, setHl] = useState("");
  const [provider, setProvider] = useState("");
  const [scans, setScans] = useState<GridScanData[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ error: string; hint?: string } | null>(null);

  // ── presets (R+) ──
  const [presets, setPresets] = useState<GridPresetData[] | null>(null);
  const [showPresetForm, setShowPresetForm] = useState(false);
  const [presetBusy, setPresetBusy] = useState(false);
  const [presetProblem, setPresetProblem] = useState<{ error: string; hint?: string } | null>(null);
  const [expandedPresetId, setExpandedPresetId] = useState("");
  // The preset form mirrors the manual one, plus a name and the compiled schedule.
  const [pName, setPName] = useState("");
  const [pKeyword, setPKeyword] = useState("");
  const [pGridSize, setPGridSize] = useState(5);
  const [pRadiusKm, setPRadiusKm] = useState("2");
  const [pUseProfile, setPUseProfile] = useState(true);
  const [pLat, setPLat] = useState("");
  const [pLng, setPLng] = useState("");
  const [pHl, setPHl] = useState("");
  const [pSchedMode, setPSchedMode] = useState<SchedMode>("manual");
  const [pSchedDays, setPSchedDays] = useState("7");
  const [pSchedWeekday, setPSchedWeekday] = useState(1);
  const [pSchedTime, setPSchedTime] = useState("06:00");

  // What "" resolves to today — the auto option's label, and the honest answer for "which
  // language will this run in": the profile's country, "us" when the profile states none.
  const defaultHl = useMemo(
    () => defaultLanguageFor(profile && /^[a-z]{2}$/i.test(profile.country) ? profile.country.toLowerCase() : "us"),
    [profile],
  );

  const load = useCallback(async () => {
    try {
      const sid = encodeURIComponent(siteId);
      const [d, p] = await Promise.all([
        fetch(`/api/local/grid?siteId=${sid}`).then(r => r.json()),
        fetch(`/api/local/grid/presets?siteId=${sid}`).then(r => r.json()),
      ]);
      if (d.notMigrated || p.notMigrated) { setScans([]); setPresets([]); return; }
      setScans((d.scans ?? []) as GridScanData[]);
      setPresets((p.presets ?? []) as GridPresetData[]);
    } catch { setScans([]); setPresets([]); }
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
      siteId, keyword: keyword.trim(), gridSize, radiusKm: Number(radiusKm), hl,
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

  // ── preset handlers (R+) ──

  const compiledSchedule = compileSchedule(pSchedMode, Number(pSchedDays), pSchedWeekday, pSchedTime);
  const presetCenterOk = pUseProfile
    ? profile != null && profile.lat != null && profile.lng != null
    : pLat.trim() !== "" && pLng.trim() !== "";
  const canCreatePreset = !presetBusy && pName.trim() !== "" && pKeyword.trim() !== ""
    && compiledSchedule !== null && presetCenterOk && Number.isFinite(Number(pRadiusKm));

  async function createPreset() {
    // compileSchedule returned null → the button is disabled; the guard keeps TS honest too.
    if (compiledSchedule === null) return;
    setPresetBusy(true);
    setPresetProblem(null);
    const body: Record<string, unknown> = {
      siteId, name: pName.trim(), keyword: pKeyword.trim(),
      gridSize: pGridSize, radiusKm: Number(pRadiusKm), hl: pHl, schedule: compiledSchedule,
      ...(pUseProfile
        ? { centerLat: profile?.lat, centerLng: profile?.lng }
        : { centerLat: Number(pLat), centerLng: Number(pLng) }),
    };
    const { ok, data } = await sendJson("/api/local/grid/presets", "POST", body);
    setPresetBusy(false);
    if (!ok) {
      setPresetProblem({ error: String(data.error ?? "grid_preset_create_failed"), hint: typeof data.hint === "string" ? data.hint : undefined });
      return;
    }
    setShowPresetForm(false);
    await load();
  }

  async function runPreset(id: string) {
    setPresetBusy(true);
    setPresetProblem(null);
    const { ok, data } = await sendJson("/api/local/grid/presets/run", "POST", { id });
    setPresetBusy(false);
    if (!ok) {
      setPresetProblem({ error: String(data.error ?? "grid_preset_run_failed"), hint: typeof data.hint === "string" ? data.hint : undefined });
      return;
    }
    setSelectedId(String((data.scan as GridScanData).id)); // show the fired scan in the result pane
    await load();
  }

  async function deletePreset(id: string) {
    setPresetBusy(true);
    setPresetProblem(null);
    const { ok, data } = await sendJson("/api/local/grid/presets", "DELETE", { id });
    setPresetBusy(false);
    if (!ok) {
      setPresetProblem({ error: String(data.error ?? "grid_preset_delete_failed"), hint: typeof data.hint === "string" ? data.hint : undefined });
      return;
    }
    if (expandedPresetId === id) setExpandedPresetId("");
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

        {/* Answer language (R+ §7.6-5): the profile country's language by default, overridable —
            tourists search in EN/RU/DE while the business stays in GR. */}
        <div style={{ maxWidth: 280 }}>
          <span style={fieldLabel}>{t("gridLang")}</span>
          <LangSelect value={hl} onChange={setHl} defaultHl={defaultHl} />
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 3 }}>{t("gridLangHint")}</div>
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

      {/* ── Saved presets (R+): the repeatable scans — point + radius + grid + language +
          schedule; each row expands into its dynamics series. The cron is displayed back
          verbatim (the contract the scheduler reads), never edited as free text. ── */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={fieldLabel}>{t("gridPresets")}</span>
          <button type="button" onClick={() => setShowPresetForm(v => !v)}
            style={{ ...btnPrimary, fontSize: 12, padding: "3px 10px", ...btnDisabled(presetBusy) }} disabled={presetBusy}>
            <Plus size={12} /> {t("gridNewPreset")}
          </button>
        </div>

        {showPresetForm && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 560, marginTop: 10,
            padding: 12, border: "1px solid var(--color-border-soft)", borderRadius: 10 }}>
            <div>
              <span style={fieldLabel}>{t("gridPresetName")}</span>
              <input style={{ ...inputStyle, width: "100%" }} value={pName} onChange={e => setPName(e.target.value)} />
            </div>
            <div>
              <span style={fieldLabel}>{t("gridKeyword")}</span>
              <input style={{ ...inputStyle, width: "100%" }} value={pKeyword} onChange={e => setPKeyword(e.target.value)} />
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <div style={{ minWidth: 110 }}>
                <span style={fieldLabel}>{t("gridSize")}</span>
                <select style={{ ...inputStyle, width: "100%" }} value={pGridSize} onChange={e => setPGridSize(Number(e.target.value))}>
                  <option value={3}>3×3</option>
                  <option value={5}>5×5</option>
                  <option value={7}>7×7</option>
                </select>
              </div>
              <div style={{ minWidth: 110 }}>
                <span style={fieldLabel}>{t("gridRadiusKm")}</span>
                <input style={{ ...inputStyle, width: "100%" }} type="number" min={0.1} max={100} step={0.1}
                  value={pRadiusKm} onChange={e => setPRadiusKm(e.target.value)} />
              </div>
              <div style={{ minWidth: 200 }}>
                <span style={fieldLabel}>{t("gridLang")}</span>
                <LangSelect value={pHl} onChange={setPHl} defaultHl={defaultHl} />
              </div>
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{t("gridLangHint")}</div>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--color-text-secondary)", cursor: "pointer" }}>
              <input type="checkbox" checked={pUseProfile} onChange={e => setPUseProfile(e.target.checked)} />
              {t("gridUseProfile")}
              {pUseProfile && profile && profile.lat != null && profile.lng != null && (
                <span style={{ color: "var(--color-text-tertiary)" }}>({profile.lat.toFixed(4)}, {profile.lng.toFixed(4)})</span>
              )}
            </label>
            {!pUseProfile && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <div style={{ minWidth: 120 }}>
                  <span style={fieldLabel}>lat</span>
                  <input style={{ ...inputStyle, width: "100%" }} type="number" step={0.0001} value={pLat} onChange={e => setPLat(e.target.value)} />
                </div>
                <div style={{ minWidth: 120 }}>
                  <span style={fieldLabel}>lng</span>
                  <input style={{ ...inputStyle, width: "100%" }} type="number" step={0.0001} value={pLng} onChange={e => setPLng(e.target.value)} />
                </div>
              </div>
            )}

            {/* Schedule: human choices compiled to cron — the field is a contract, free-text
                cron never reaches the operator. The cron matcher evaluates UTC; the time
                field says so instead of quietly firing in a local timezone. */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ minWidth: 170 }}>
                <span style={fieldLabel}>{t("gridSchedule")}</span>
                <select style={{ ...inputStyle, width: "100%" }} value={pSchedMode} onChange={e => setPSchedMode(e.target.value as SchedMode)}>
                  <option value="manual">{t("gridSchedManual")}</option>
                  <option value="days">{t("gridSchedDays")}</option>
                  <option value="weekly">{t("gridSchedWeekly")}</option>
                </select>
              </div>
              {pSchedMode === "days" && (
                <div style={{ minWidth: 90 }}>
                  <span style={fieldLabel}>N {t("gridSchedDays")}</span>
                  <input style={{ ...inputStyle, width: "100%" }} type="number" min={1} max={365}
                    value={pSchedDays} onChange={e => setPSchedDays(e.target.value)} />
                </div>
              )}
              {pSchedMode === "weekly" && (
                <div style={{ minWidth: 120 }}>
                  <span style={fieldLabel}>{t("gridSchedWeekly")}</span>
                  <select style={{ ...inputStyle, width: "100%" }} value={pSchedWeekday} onChange={e => setPSchedWeekday(Number(e.target.value))}>
                    {weekdayLabels(language).map((label, d) => <option key={d} value={d}>{label}</option>)}
                  </select>
                </div>
              )}
              {pSchedMode !== "manual" && (
                <div style={{ minWidth: 150 }}>
                  <span style={fieldLabel}>{t("gridSchedAt")} (UTC)</span>
                  <input style={{ ...inputStyle, width: "100%" }} placeholder="HH:MM"
                    value={pSchedTime} onChange={e => setPSchedTime(e.target.value)} />
                </div>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <button type="button" onClick={createPreset} disabled={!canCreatePreset}
                style={{ ...btnPrimary, ...btnDisabled(!canCreatePreset) }} title={compiledSchedule === null ? "HH:MM" : undefined}>
                {presetBusy ? <Loader2 size={14} className="spin" /> : <Plus size={13} />} {t("gridNewPreset")}
              </button>
              {/* The cost line stays visible on presets too: every fire spends gridSize² queries. */}
              <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                {estimateQueryCount(pGridSize)} {t("gridEstimateQueries")}
                {pSchedMode !== "manual" && compiledSchedule !== null && <> · {compiledSchedule}</>}
                {pSchedMode !== "manual" && compiledSchedule === null && (
                  <span style={{ color: "var(--color-danger)" }}> · HH:MM</span>
                )}
              </span>
            </div>
            {presetProblem && (
              <div style={{ fontSize: 12, color: "var(--color-danger)" }}>
                {presetProblem.error}{presetProblem.hint ? ` — ${presetProblem.hint}` : ""}
              </div>
            )}
          </div>
        )}

        {presets === null ? (
          <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginTop: 8 }}>…</div>
        ) : presets.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {presets.map(p => {
              const expanded = expandedPresetId === p.id;
              return (
                <div key={p.id} style={{
                  border: expanded ? "1px solid var(--color-accent-blue)" : "1px solid var(--color-border-soft)",
                  background: expanded ? "color-mix(in srgb, var(--color-accent-blue) 7%, transparent)" : "transparent",
                  borderRadius: 8, padding: "7px 10px", display: "flex", flexDirection: "column", gap: 4,
                }}>
                  <div role="button" tabIndex={0} onClick={() => setExpandedPresetId(expanded ? "" : p.id)}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setExpandedPresetId(expanded ? "" : p.id); }}
                    style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", cursor: "pointer" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-text-primary)" }}>{p.name}</span>
                    <span style={{ fontSize: 12, color: "var(--color-text-primary)" }}>{p.keyword}</span>
                    <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                      {p.centerLat.toFixed(4)}, {p.centerLng.toFixed(4)} · {p.gridSize}×{p.gridSize} · {p.radiusKm} km · hl: {p.hl || `auto (${defaultHl})`}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--color-text-secondary)" }} title={p.schedule || undefined}>
                      {p.schedule ? `${p.schedule} (UTC)` : t("gridSchedManual")}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)" }}>
                      {t("gridLastFire")}: {p.lastFireAt
                        ? new Date(p.lastFireAt).toLocaleString(language, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
                        : "—"}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--color-text-secondary)", marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
                      {/* Per-preset cost, always visible: N² queries per fire. */}
                      <span>{estimateQueryCount(p.gridSize)} {t("gridEstimateQueries")}</span>
                      <button type="button" onClick={e => { e.stopPropagation(); void runPreset(p.id); }}
                        disabled={presetBusy} style={{ ...btnPrimary, fontSize: 11, padding: "2px 8px", ...btnDisabled(presetBusy) }}>
                        {presetBusy ? <Loader2 size={11} className="spin" /> : <Play size={11} />} {t("gridRunNow")}
                      </button>
                      <button type="button" onClick={e => { e.stopPropagation(); void deletePreset(p.id); }}
                        disabled={presetBusy} title={t("gridDeletePreset")}
                        style={{ ...btnPrimary, fontSize: 11, padding: "2px 8px", color: "var(--color-danger)", ...btnDisabled(presetBusy) }}>
                        <Trash2 size={11} />
                      </button>
                    </span>
                  </div>
                  {expanded && (
                    <div>
                      <span style={{ ...fieldLabel, fontSize: 11 }}>{t("gridPresetDynamics")}</span>
                      <PresetDynamics preset={p} t={t} language={language} />
                    </div>
                  )}
                </div>
              );
            })}
            {presetProblem && !showPresetForm && (
              <div style={{ fontSize: 12, color: "var(--color-danger)" }}>
                {presetProblem.error}{presetProblem.hint ? ` — ${presetProblem.hint}` : ""}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
