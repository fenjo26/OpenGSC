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

export type SyncState = {
  syncing: boolean;
  startedAt: Date | null;
  completedAt: Date | null;
  needsReauth: boolean;
  accountErrors: number;
  sitesSynced: number;
};

/**
 * What the server thinks is going on, or null if it couldn't be asked.
 *
 * `null` means "no answer", not "not syncing" — the caller has to keep those apart, because
 * treating an unreachable server as a finished sync is how a run that is still going gets
 * reported as complete.
 */
export async function fetchSyncState(): Promise<SyncState | null> {
  try {
    const r = await fetch("/api/gsc/sync");
    if (!r.ok) return null;
    const s = await r.json();
    const date = (v: unknown) => {
      if (typeof v !== "string") return null;
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    };
    return {
      syncing: !!s?.syncing,
      startedAt: date(s?.startedAt),
      completedAt: date(s?.lastResult?.completedAt),
      needsReauth: !!s?.lastResult?.needsReauth,
      accountErrors: Number(s?.lastResult?.accountErrors ?? 0),
      sitesSynced: Number(s?.lastResult?.sitesSynced ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Watch a run until the server says it is over, and return a function that stops watching.
 *
 * It deliberately has no deadline. The old code gave up after fifteen minutes, which is less
 * than a full sync of a couple of hundred properties takes: the spinner vanished, the label was
 * never written, and the run went on to finish quietly a few minutes later. From the browser
 * that is indistinguishable from a sync that died and took the fresh data with it, which is the
 * worst thing a dashboard can imply while the data is in fact sitting in the database.
 *
 * The one thing it does give up on is silence. A server that stops answering is not a finished
 * run, so `onLost` fires only after five solid minutes of no reply, and it means "I've lost
 * track", not "it's done".
 */
export function watchSync(
  onSettled: (state: SyncState) => void,
  onLost?: () => void,
  intervalMs = 15_000,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let misses = 0;

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  timer = setInterval(async () => {
    const state = await fetchSyncState();
    if (timer === null) return; // stopped while the request was in flight
    if (!state) {
      if (++misses >= 20) { stop(); onLost?.(); }
      return;
    }
    misses = 0;
    if (!state.syncing) { stop(); onSettled(state); }
  }, intervalMs);

  return stop;
}

/**
 * The time of the last completed sync, or null if neither side knows of one.
 *
 * Server first, browser second. Storage failures are swallowed on purpose here: not knowing the
 * timestamp is a cosmetic problem, and the caller has nothing useful to do about it.
 */
export async function loadSyncedAt(): Promise<Date | null> {
  const state = await fetchSyncState();
  if (state?.completedAt) return state.completedAt;

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
