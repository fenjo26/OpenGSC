// Grid-preset scheduler (R+ wave G) — fires saved geo-grid presets whose cron schedule is due.
// Member of the in-process scheduler family started from src/instrumentation.ts, and a close
// sibling of src/lib/audit/auditScheduler.ts (the pattern this file mirrors):
//   - tick every 15 min; a fire is detected by walking back at most CRON_SCAN_MINUTES from
//     "now", so a fire older than the window is DOWNTIME — deliberately missed, never
//     back-filled (a grid run costs gridSize² queries; a catch-up burst would spend them
//     on stale questions);
//   - high-water mark lastFireAt on the preset row: the FIRST sighting of a preset only
//     adopts the marker without firing, so a preset created between ticks never gets a
//     retroactive scan;
//   - one fire per expression window: latestFire <= lastFireAt means "already handled".
// A scan in flight (queued/running, and young — see INFLIGHT_MAX_AGE_MS) holds the marker
// back instead of stacking a second run on top; it catches up on a later tick, once.
//
// Presets fire SEQUENTIALLY within a tick — the scheduler awaits each scan before starting
// the next preset's — for the same reason the scan runner walks its points one by one: a
// personal A-Parser behind one proxy pool must not see two grids' queries interleaved.

import { prisma } from "@/lib/prisma";
import { latestFireAtOrBefore } from "@/lib/cron";
import { runGridPreset } from "./preset";
import { runGridScan } from "./run";

const TICK_MS = 15 * 60 * 1000;
// The look-back window for a cron fire — several missed ticks wide so one slow tick cannot
// skip a fire, and nothing older (that is downtime, which stays a gap).
const CRON_SCAN_MINUTES = 60;
// A grid scan is minutes long at most (gridSize² sequential queries); "running" older than
// this is a run the process abandoned (restart mid-scan leaves no one to finish it — a
// pre-existing manual-scan condition too). Past the cap the scheduler fires again instead of
// letting one zombie row silence the preset forever; the gap stays visible in the history.
const INFLIGHT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Injectable so the fire logic is unit-testable without contacting a SERP provider. */
export interface GridPresetTickDeps {
  runScan?: (scanId: string) => Promise<void>;
}

let started = false;

export function startGridPresetScheduler(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    gridPresetTick().catch(err => console.error("[grid-preset-scheduler] tick failed:", err));
  }, TICK_MS);
}

/**
 * One scheduler pass, exported for tests (they inject `now` and a no-op runScan). Sequential
 * over due presets; every step is per-preset-try/catch so one broken row never stops the rest.
 */
export async function gridPresetTick(now = new Date(), deps: GridPresetTickDeps = {}): Promise<void> {
  const runScan = deps.runScan ?? ((scanId: string) => runGridScan(scanId));
  // Only scheduled presets; archived/hidden sites keep their rows but fire nothing (the same
  // site filter the audit scheduler applies).
  const presets = await prisma.gridPreset.findMany({
    where: { schedule: { not: "" }, site: { archivedAt: null, hidden: false } },
    include: { site: { select: { userId: true } } },
  }).catch(() => []);

  for (const preset of presets) {
    try {
      await firePresetIfDue(preset, now, runScan);
    } catch (e) {
      console.error(`[grid-preset-scheduler] preset ${preset.name} (${preset.id}) failed:`, e);
    }
  }
}

type ScheduledPreset = {
  id: string;
  name: string;
  schedule: string;
  lastFireAt: Date | null;
  site: { userId: string };
};

async function firePresetIfDue(preset: ScheduledPreset, now: Date, runScan: (scanId: string) => Promise<void>): Promise<void> {
  // An expression the matcher cannot parse yields no fire (latestFireAtOrBefore → null) —
  // skipped, not crashed; validation at creation keeps such rows out in the first place.
  const latestFire = latestFireAtOrBefore(preset.schedule, now, CRON_SCAN_MINUTES);
  if (!latestFire) return;

  if (preset.lastFireAt === null) {
    // First acquaintance: adopt the marker WITHOUT firing — a preset saved between ticks
    // must not produce a scan the moment the scheduler first reads it.
    await prisma.gridPreset.update({ where: { id: preset.id }, data: { lastFireAt: latestFire } }).catch(() => {});
    return;
  }
  if (latestFire.getTime() <= preset.lastFireAt.getTime()) return; // this window is already handled

  const inFlight = await prisma.gridScan.findFirst({
    where: {
      presetId: preset.id,
      status: { in: ["queued", "running"] },
      createdAt: { gt: new Date(now.getTime() - INFLIGHT_MAX_AGE_MS) },
    },
    select: { id: true },
  }).catch(() => null);
  if (inFlight) return; // hold the marker back; the next free tick catches this window up, once

  const fired = await runGridPreset(preset.site.userId, preset.id, { kick: false });
  if (!fired.ok) {
    console.warn(`[grid-preset-scheduler] preset ${preset.name} (${preset.id}) not found on fire — skipped`);
    return;
  }
  if (!fired.result.ok) {
    // No row was created (no SERP key, unsupported provider…). The marker holds, so the fire
    // retries on the next tick while it is still inside the look-back window — and once it
    // ages out it stays a visible gap in the preset's scan history, not a back-filled burst.
    console.warn(`[grid-preset-scheduler] fire failed for ${preset.name} (${preset.id}): ${fired.result.error}`);
    return;
  }

  // The marker advances only once the scan row exists (the audit family's order): a fire is
  // recorded as a scan, never as intent. Advancing before the awaited run also makes an
  // overlapping tick a no-op for this window.
  await prisma.gridPreset.update({ where: { id: preset.id }, data: { lastFireAt: latestFire } }).catch(() => {});
  await runScan(fired.result.scan.id);
}
