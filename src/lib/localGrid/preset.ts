// Saved geo-grid presets (R+ wave G): a named "point + radius + grid + answer language +
// optional cron schedule", so a scan becomes a REPEATABLE measurement instead of a one-off.
// The use case the schema was drawn from: "SKG airport", "Thessaloniki centre", "Halkidiki
// resort zone" — arbitrary centres the business profile does not know about, checked on a
// schedule so the heatmap has a DYNAMICS story, not a single snapshot.
//
// Every repeat is a fresh GridScan row chained by presetId (never a mutation of an old row —
// a scan is a finished fact); deleting a preset keeps its scans (SetNull in the schema).

import { prisma } from "@/lib/prisma";
import { validateCron } from "@/lib/cron";
import { isGridSize } from "./math";
import {
  createAndRunGridScan,
  isValidHl,
  RADIUS_MAX_KM,
  RADIUS_MIN_KM,
  summarizePoints,
  type CreateGridScanResult,
  type GridScanSummary,
} from "./run";

/** Preset names are labels an operator scans in a list — long ones only break the card. */
const NAME_MAX = 120;
/** How many of a preset's scans the dynamics view keeps per preset (oldest fall off the chart). */
const DYNAMICS_SCAN_CAP = 30;

export interface GridPresetInput {
  name: string;
  keyword: string;
  centerLat: number;
  centerLng: number;
  gridSize: number;
  radiusKm: number;
  /** "" = language of the profile country (the hl chain lives in run.ts:resolveHl). */
  hl?: string;
  /** "" = manual only (Run now button / MCP); otherwise a 5-field cron the scheduler reads. */
  schedule?: string;
}

export type GridPresetProblem =
  | "name_required"
  | "keyword_required"
  | "grid_size_invalid"
  | "radius_invalid"
  | "center_invalid"
  | "hl_invalid"
  | "schedule_invalid";

/** One scan of the dynamics series: when it ran, in what language, and what it measured. */
export interface GridPresetScanPoint {
  id: string;
  createdAt: string;
  status: "queued" | "running" | "done" | "error";
  hl: string;
  summary: GridScanSummary;
}

export interface GridPresetData {
  id: string;
  siteId: string;
  name: string;
  keyword: string;
  centerLat: number;
  centerLng: number;
  gridSize: number;
  radiusKm: number;
  hl: string;
  schedule: string;
  lastFireAt: string | null;
  createdAt: string;
  /** The preset's scans, OLDEST FIRST — the order a dynamics chart plots them in. */
  scans: GridPresetScanPoint[];
}

/**
 * Pure validation, shared verbatim by the API route and the MCP tool (and unit-tested alone):
 * both surfaces must refuse the same preset for the same reason, or the tool drifts from the
 * UI. Returns null when the input is acceptable.
 */
export function validateGridPresetInput(input: GridPresetInput): GridPresetProblem | null {
  const name = String(input.name ?? "").trim();
  if (!name) return "name_required";
  if (!String(input.keyword ?? "").trim()) return "keyword_required";
  const gridSize = Number(input.gridSize);
  if (!Number.isFinite(gridSize) || !isGridSize(gridSize)) return "grid_size_invalid";
  const radiusKm = Number(input.radiusKm);
  if (!Number.isFinite(radiusKm) || radiusKm < RADIUS_MIN_KM || radiusKm > RADIUS_MAX_KM) return "radius_invalid";
  const centerLat = Number(input.centerLat);
  const centerLng = Number(input.centerLng);
  if (!Number.isFinite(centerLat) || Math.abs(centerLat) > 90 || !Number.isFinite(centerLng) || Math.abs(centerLng) > 180) {
    return "center_invalid";
  }
  const hl = String(input.hl ?? "").trim().toLowerCase();
  if (!isValidHl(hl)) return "hl_invalid";
  const schedule = String(input.schedule ?? "").trim();
  // The cron grammar is validated by the matcher's own validator — the same authority the
  // scheduler will parse the expression with, so nothing storable can crash a tick.
  if (schedule !== "" && validateCron(schedule) !== null) return "schedule_invalid";
  return null;
}

type PresetRow = {
  id: string; siteId: string; name: string; keyword: string;
  centerLat: number; centerLng: number; gridSize: number; radiusKm: number;
  hl: string; schedule: string; lastFireAt: Date | null; createdAt: Date;
};

function toPresetData(row: PresetRow, scans: GridPresetScanPoint[]): GridPresetData {
  return {
    id: row.id, siteId: row.siteId, name: row.name, keyword: row.keyword,
    centerLat: row.centerLat, centerLng: row.centerLng, gridSize: row.gridSize, radiusKm: row.radiusKm,
    hl: row.hl, schedule: row.schedule, lastFireAt: row.lastFireAt ? row.lastFireAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    scans,
  };
}

export type CreateGridPresetResult =
  | { ok: true; preset: GridPresetData }
  | { ok: false; error: "site_not_found" | GridPresetProblem; hint?: string };

const HINTS: Partial<Record<GridPresetProblem, string>> = {
  grid_size_invalid: "Accepted grid sizes: 3, 5, 7.",
  radius_invalid: `Radius must be between ${RADIUS_MIN_KM} and ${RADIUS_MAX_KM} km.`,
  center_invalid: "centerLat must be in [-90, 90], centerLng in [-180, 180].",
  hl_invalid: 'hl must be "" (profile-country default) or a 2-letter language code, e.g. "en".',
  schedule_invalid: "schedule must be \"\" or a valid 5-field cron expression (minute hour day-of-month month day-of-week, UTC).",
};

export async function createGridPreset(userId: string, siteDbId: string, input: GridPresetInput): Promise<CreateGridPresetResult> {
  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true } });
  if (!site) return { ok: false, error: "site_not_found" };

  const problem = validateGridPresetInput(input);
  if (problem) return { ok: false, error: problem, hint: HINTS[problem] };

  const row = await prisma.gridPreset.create({
    data: {
      siteId: site.id,
      name: String(input.name).trim().slice(0, NAME_MAX),
      keyword: String(input.keyword).trim().slice(0, 200),
      centerLat: Number(input.centerLat),
      centerLng: Number(input.centerLng),
      gridSize: Number(input.gridSize),
      radiusKm: Number(input.radiusKm),
      hl: String(input.hl ?? "").trim().toLowerCase(),
      schedule: String(input.schedule ?? "").trim(),
    },
  });
  return { ok: true, preset: toPresetData(row, []) };
}

/**
 * A site's presets with their scan history (the dynamics series) summarized. One extra query
 * for all scans beats N queries per preset on local SQLite; the cap bounds the worst case of
 * a preset-heavy site with long history.
 */
export async function listGridPresets(userId: string, siteDbId: string): Promise<GridPresetData[]> {
  const presets = await prisma.gridPreset.findMany({
    where: { siteId: siteDbId, site: { userId } },
    orderBy: { createdAt: "desc" },
  });
  if (presets.length === 0) return [];

  const scanRows = await prisma.gridScan.findMany({
    where: { siteId: siteDbId, presetId: { in: presets.map(p => p.id) }, site: { userId } },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { id: true, presetId: true, createdAt: true, status: true, hl: true, points: true },
  });
  const byPreset = new Map<string, GridPresetScanPoint[]>();
  for (const s of scanRows) {
    if (!s.presetId) continue; // unreachable given the filter; the type still says nullable
    const list = byPreset.get(s.presetId) ?? [];
    if (list.length < DYNAMICS_SCAN_CAP) {
      let points: Parameters<typeof summarizePoints>[0] = [];
      try {
        const parsed = JSON.parse(s.points);
        if (Array.isArray(parsed)) points = parsed as typeof points;
      } catch { /* garbage points degrade to an empty summary, never a crashed list */ }
      list.push({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        status: (["queued", "running", "done", "error"] as const).includes(s.status as never) ? s.status as GridPresetScanPoint["status"] : "error",
        hl: s.hl,
        summary: summarizePoints(points),
      });
    }
    byPreset.set(s.presetId, list);
  }
  // scanRows arrived newest-first; each preset's series is reversed to oldest-first for plotting.
  return presets.map(p => toPresetData(p, (byPreset.get(p.id) ?? []).slice().reverse()));
}

/** Delete a preset. Its scans survive (schema: SetNull) — history is not the preset's to erase. */
export async function deleteGridPreset(userId: string, presetId: string): Promise<boolean> {
  const row = await prisma.gridPreset.findFirst({ where: { id: presetId, site: { userId } }, select: { id: true } });
  if (!row) return false;
  await prisma.gridPreset.delete({ where: { id: row.id } });
  return true;
}

/**
 * Run-now (the button, the MCP tool — and the scheduler fires through this same path so a
 * scheduled scan and a manual one are indistinguishable rows). The centre is the preset's own
 * point; the hl chain resolves preset.hl → profile country → "us" inside createAndRunGridScan.
 */
export async function runGridPreset(
  userId: string,
  presetId: string,
  opts: { kick?: boolean } = {},
): Promise<{ ok: true; result: CreateGridScanResult } | { ok: false; error: "preset_not_found" }> {
  const preset = await prisma.gridPreset.findFirst({
    where: { id: presetId, site: { userId } },
    select: { id: true, siteId: true, keyword: true, centerLat: true, centerLng: true, gridSize: true, radiusKm: true, hl: true },
  });
  if (!preset) return { ok: false, error: "preset_not_found" };

  // Validated at creation and immutable since — but a bad row (manual db edit, schema drift)
  // is refused here too rather than fired as-is: a run costs gridSize² queries.
  if (validateGridPresetInput({
    name: preset.id, // name is not re-checked on fire — only the fields the scan consumes
    keyword: preset.keyword,
    centerLat: preset.centerLat, centerLng: preset.centerLng,
    gridSize: preset.gridSize, radiusKm: preset.radiusKm, hl: preset.hl,
  })) {
    return { ok: false, error: "preset_not_found" };
  }

  const result = await createAndRunGridScan(userId, preset.siteId, {
    keyword: preset.keyword,
    gridSize: preset.gridSize,
    radiusKm: preset.radiusKm,
    centerLat: preset.centerLat,
    centerLng: preset.centerLng,
    hl: preset.hl,
    presetId: preset.id,
  }, opts);
  return { ok: true, result };
}
