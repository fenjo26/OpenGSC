// Automatic GSC sync — the settings half. The scheduler itself is in syncScheduler.ts.
//
// Stored as JSON in User.syncSettings and read with raw SQL, the same convention as
// digestSettings and alertSettings: an instance that hasn't run `prisma db push` yet gets the
// defaults instead of an exception, so a missing column degrades into "the feature is off".
//
// The hour is kept in the user's own time zone rather than in UTC, unlike the digest. The reason
// is that this setting is chosen against a working day — "have the data ready before I sit down
// at ten" — and a UTC hour silently drifts an hour away from that twice a year, at exactly the
// moment nobody is looking at it.

import { rawQuery, rawExec } from "@/lib/db/raw";

export type SyncSchedule = {
  enabled: boolean;
  /** 0–23, in `timeZone`. */
  hour: number;
  /** IANA name, e.g. "Europe/Athens". Filled in by the browser when the user saves. */
  timeZone: string;
  /** ISO timestamp of the last run this schedule triggered, or null. */
  lastRunAt: string | null;
  /**
   * ISO timestamp of the last completed sync of any kind, scheduled or pressed by hand.
   *
   * Kept here rather than only in the scheduler's own `lastRunAt` because it answers a different
   * question: not "has today's schedule fired" but "how old is the data on screen". The server
   * used to answer that from a module-level variable, which every restart wiped — leaving the
   * dashboard showing a sync from days ago while the settings page, reading this row, showed one
   * from this morning. Two screens disagreeing about the same event.
   */
  lastCompletedAt?: string | null;
};

export const DEFAULT_SYNC_SCHEDULE: SyncSchedule = {
  enabled: false,
  hour: 9,
  timeZone: "UTC",
  lastRunAt: null,
  lastCompletedAt: null,
};

export async function getSyncSchedule(userId: string): Promise<SyncSchedule> {
  try {
    const rows: { syncSettings: string | null }[] =
      await rawQuery(`SELECT syncSettings FROM "User" WHERE id = ?`, userId);
    const raw = rows?.[0]?.syncSettings;
    return raw ? { ...DEFAULT_SYNC_SCHEDULE, ...JSON.parse(raw) } : DEFAULT_SYNC_SCHEDULE;
  } catch {
    return DEFAULT_SYNC_SCHEDULE; // column not there yet, or unparseable JSON
  }
}

export async function saveSyncSchedule(userId: string, s: SyncSchedule): Promise<void> {
  await rawExec(`UPDATE "User" SET syncSettings = ? WHERE id = ?`, JSON.stringify(s), userId);
}

/** Sanitise whatever the client sent. An invalid zone would otherwise disable the schedule silently. */
export function normalise(input: Partial<SyncSchedule>, current: SyncSchedule): SyncSchedule {
  const hour = Number(input.hour);
  return {
    enabled: input.enabled ?? current.enabled,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : current.hour,
    timeZone: isValidZone(input.timeZone) ? input.timeZone! : current.timeZone,
    // Both timestamps are the server's to write. Carried over explicitly rather than spread from
    // `current`, so that saving the form cannot erase them by omission.
    lastRunAt: current.lastRunAt,
    lastCompletedAt: current.lastCompletedAt ?? null,
  };
}

/**
 * Remember that a sync finished, for every user whose account it covered.
 *
 * A run is instance-wide, so there is no single owner to attribute it to; writing it to each
 * synced user's row keeps the answer available to whoever asks. Failures are ignored on purpose:
 * a timestamp that did not save is not a reason to treat a completed sync as failed.
 */
export async function recordSyncCompleted(userIds: string[], when: Date): Promise<void> {
  const stamp = when.toISOString();
  for (const userId of new Set(userIds)) {
    try {
      const current = await getSyncSchedule(userId);
      await saveSyncSchedule(userId, { ...current, lastCompletedAt: stamp });
    } catch { /* column missing, or the row went away mid-run */ }
  }
}

export function isValidZone(tz?: string | null): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Local wall-clock hour in `tz`, or null if the zone is unusable. */
export function hourIn(tz: string, at: Date): number | null {
  try {
    // hour12:false reports midnight as "24" in some ICU builds — hence the modulo.
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(at));
    return Number.isFinite(h) ? h % 24 : null;
  } catch {
    return null;
  }
}

/** Local calendar day in `tz` as YYYY-MM-DD — the unit "once a day" is counted in. */
export function dayIn(tz: string, at: Date): string | null {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return null;
  }
}

/**
 * Is this schedule due right now?
 *
 * Due once per local day, from the configured hour onwards — not only exactly at it. The tick
 * runs every fifteen minutes, but a server that was asleep, restarting or mid-deploy at nine
 * o'clock would otherwise skip the day entirely and the dashboard would be a day stale with no
 * indication why. Catching up late is the lesser of the two surprises.
 */
export function isDue(s: SyncSchedule, now: Date): boolean {
  if (!s.enabled) return false;

  const today = dayIn(s.timeZone, now);
  const hour = hourIn(s.timeZone, now);
  if (today === null || hour === null) return false; // unusable zone: stay off rather than guess
  if (hour < s.hour) return false;

  if (!s.lastRunAt) return true;
  const last = new Date(s.lastRunAt);
  if (isNaN(last.getTime())) return true;
  return dayIn(s.timeZone, last) !== today;
}
