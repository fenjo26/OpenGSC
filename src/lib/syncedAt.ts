// "Last synced at" — one source of truth for the timestamp under the Sync button.
//
// It used to live only in localStorage, written by the poll that watches a sync finish. Two
// things went wrong with that, and both looked to the user like the sync itself had failed:
//
//   1. `localStorage.setItem` can throw — a full store is the usual reason — and the write sat
//      one line after `setSyncedAt(now)` inside a promise chain ending in `.catch(() => {})`.
//      The label showed the new time, the store kept the old one, and the next reload appeared
//      to roll the sync back by a day. Nothing was logged anywhere.
//   2. The value is per-browser. A sync run in one browser is invisible in another, and a tab
//      closed before the poll finished never recorded a sync that in fact completed.
//
// The server already knows the answer: `runGscSync` records `completedAt`, and GET
// /api/gsc/sync returns it. So the server is the source, and localStorage is the fallback for
// the one case the server can't cover — `lastSyncResult` is an in-memory variable, so a restart
// forgets it, while the browser still remembers the last sync it saw.

const KEY = "gsc_synced_at";

/**
 * The time of the last completed sync, or null if neither side knows of one.
 *
 * Server first, browser second. Storage failures are swallowed on purpose here: not knowing the
 * timestamp is a cosmetic problem, and the caller has nothing useful to do about it.
 */
export async function loadSyncedAt(): Promise<Date | null> {
  try {
    const r = await fetch("/api/gsc/sync");
    const s = await r.json();
    const completedAt = s?.lastResult?.completedAt;
    if (completedAt) {
      const d = new Date(completedAt);
      if (!isNaN(d.getTime())) return d;
    }
  } catch { /* offline, unauthorised, or restarted — fall through to the local copy */ }

  try {
    const cached = localStorage.getItem(KEY);
    if (cached) {
      const d = new Date(cached);
      if (!isNaN(d.getTime())) return d;
    }
  } catch { /* storage unavailable (private mode, blocked cookies) */ }

  return null;
}

/**
 * Cache a sync that just finished, so the label survives a restart of the server process.
 *
 * A failure here is not worth interrupting anything over, but it is worth saying out loud —
 * silence is exactly what made the original bug take a day to explain.
 */
export function rememberSyncedAt(when: Date): void {
  try {
    localStorage.setItem(KEY, when.toISOString());
  } catch (err) {
    console.warn(
      "[opengsc] could not cache the last-sync time in localStorage — the label will fall back " +
      "to the server's own record. Storage is most likely full.",
      err,
    );
  }
}
