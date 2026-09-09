// The drops watch loop ("watch / buy" in the funnel). Rows a user marked as watched are re-asked
// on their interval until a registry says they are free; a corroborated "free" turns into one
// Telegram/Slack notification and the end of that watch. Everything else about the timing —
// per-registry throttling, jitter, the deadline shape — is checkAvailabilityBatch's, the same
// code the manual check button uses, so the watch can never query a registry faster than the
// funnel is allowed to.
//
// Runs inside the Next server process from instrumentation, the way clarity/rank/aeo do. No
// system cron, no extra process. Free on idle: a tick with no due watched rows is one indexed
// query and nothing else.

import { checkAvailabilityBatch } from "./availability";
import { dueWatchedRows, recordWatchResults, schemaMissing, staleDrWatchedRows, type WatchAlert, type WatchRow } from "./store";
import { drForDomains } from "./drFree";
import { NOTIFY_L, normalizeLang } from "@/lib/notifyI18n";
import { getAlertSettings } from "@/lib/alertScheduler";
import { notifyUser } from "@/lib/notify";

const TICK_MS = 5 * 60 * 1000;      // 5 minutes — fine enough for the 15-minute pendingDelete cadence
const ROWS_PER_TICK = 60;           // across all users; the next tick drains whatever is left
const USER_DEADLINE_MS = 90_000;    // per user, wall clock — this runs in-process, no 504 to dodge
const TICK_BUDGET_MS = 4 * 60_000;  // stop starting new users when the tick is this old

let started = false;
let running = false;
/** Set when the instance has not migrated the drops tables yet — the tick stops retrying. */
let disabled = false;

/** The one message a watch ever sends, in the user's alert language. */
function alertText(lang: string, freed: WatchAlert[]): string {
  const L = NOTIFY_L[normalizeLang(lang)];
  const lines = freed.map(a => L.dropsWatchRow(
    a.domain,
    a.dr != null ? String(Math.round(a.dr)) : "—",
    a.refdomains != null ? String(a.refdomains) : "—",
  ));
  return [L.dropsWatchTitle(freed.length), ...lines].join("\n");
}

/**
 * The DR half of the watch. Availability re-checks answer "is it free yet"; this answers "is it
 * still worth wanting" — a watched domain is by definition one the user intends to buy, and its
 * DR trend is the penalty check they need before paying. Free by construction: drForDomains
 * talks to the public Ahrefs endpoint and every fresh measurement lands in DrSnapshot, whose
 * (domain, month) key makes this at most one new data point per domain per month.
 */
async function refreshWatchedDr() {
  const stale = await staleDrWatchedRows(ROWS_PER_TICK);
  if (!stale.length) return;
  const byUser = new Map<string, string[]>();
  for (const r of stale) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, []);
    byUser.get(r.userId)!.push(r.domain);
  }
  for (const [userId, domains] of byUser) {
    try {
      const { ratings, keyFound } = await drForDomains(userId, domains);
      if (keyFound && Object.keys(ratings).length) {
        console.log(`[drops-watch] DR series refreshed for ${Object.keys(ratings).length} watched domain(s)`);
      }
      // keyFound=false (no DR key anywhere) stays silent: it would repeat every tick, and the
      // DR buttons in the UI already say "настроить ключ" where the user can act on it.
    } catch (e) {
      console.warn("[drops-watch] DR refresh failed:", e);
    }
  }
}

async function tick() {
  if (running || disabled) return;
  running = true;
  const startedAt = Date.now();
  try {
    const rows: WatchRow[] = await dueWatchedRows(ROWS_PER_TICK);
    if (rows.length) {
      // One user's batch at a time: the registry check is per-user work (its verdicts and its
      // notification are), and serial users keep the tick's worst case readable.
      const byUser = new Map<string, WatchRow[]>();
      for (const r of rows) {
        if (!byUser.has(r.userId)) byUser.set(r.userId, []);
        byUser.get(r.userId)!.push(r);
      }

      for (const [userId, userRows] of byUser) {
        if (Date.now() - startedAt > TICK_BUDGET_MS) break; // leftovers stay due for the next tick
        const results = await checkAvailabilityBatch(
          userRows.map(r => r.domain),
          { deadlineMs: USER_DEADLINE_MS },
        );
        const written = await recordWatchResults(userRows, results);
        // One message per tick per user, however many names freed in it — a burst of drops is one
        // event to read, not one buzz each.
        if (written.freed.length) {
          try {
            const settings = await getAlertSettings(userId);
            await notifyUser(userId, alertText(settings.lang, written.freed));
          } catch (e) {
            // The DropEvent trail already records the flip; a dead webhook must not fail the tick.
            console.warn("[drops-watch] notify failed:", e);
          }
        }
        if (written.freed.length || written.uncertain.length) {
          console.log(`[drops-watch] ${userId}: ${written.freed.length} freed, ${written.uncertain.length} uncertain of ${written.checked}`);
        }
      }
    }

    // Independent of the availability queue: a tick with nothing due still gives any watched
    // domain waiting on this month's DR point its measurement.
    await refreshWatchedDr();
  } catch (e) {
    if (schemaMissing(e)) {
      // Pulled-but-not-restarted instance (the app pushes the schema at container start).
      disabled = true;
      console.warn("[drops-watch] drops tables missing — scheduler disabled until restart");
      return;
    }
    console.warn("[drops-watch] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startDropsScheduler() {
  if (started) return;
  started = true;
  console.log("[drops-watch] scheduler started");
  // First pass shortly after boot, then every five minutes.
  setTimeout(tick, 45_000);
  setInterval(tick, TICK_MS);
}
