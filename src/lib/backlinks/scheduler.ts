// The backlink-toxicity scheduler (N2) — same in-process pattern as the other loops
// (serpmon/scheduler.ts): started once from instrumentation, a `running` flag against overlap,
// and permanently disabled when the instance has not pushed the SiteBacklink tables yet.
//
// Tick = 1 h. Each tick recalculates up to SITES_PER_TICK sites whose toxicity is stale —
// rows never classified (a CSV import counts), or classified before the site's last finished
// sync, which is exactly "new donors arrived" (brief §2). The recalc itself is local (no
// network); the deep check is a button, not a cron job. After a recalc, donors that BECAME
// toxic fire one toxic_new alert per site per UTC day; the first run for a site is silent —
// otherwise the whole historical profile would arrive as a single message.

import { withCallContext } from "@/lib/providerLog/context";
import { resolveCaptureBodies } from "@/lib/providerLog/bodies";
import { backlinksNotMigrated, recalcSiteToxicity, staleToxSites } from "./store";

const TICK_MS = 60 * 60 * 1000; // hourly
const FIRST_TICK_MS = 120_000;  // first pass shortly after boot, after the data-bearing loops
const SITES_PER_TICK = 5;

let started = false;
let running = false;
/** Set when the tables are missing — the tick stops retrying until restart. */
let disabled = false;

async function tick(): Promise<void> {
  if (running || disabled) return;
  running = true;
  try {
    const sites = await staleToxSites(SITES_PER_TICK);
    for (const site of sites) {
      try {
        // No network leaves the server in a recalc, but delivery of the alert does; both belong
        // in the provider log context of the site's owner, like every cron's side effect.
        const captureBodies = await resolveCaptureBodies(site.userId);
        await withCallContext({ userId: site.userId, feature: "backlink-tox-cron", captureBodies }, async () => {
          const summary = await recalcSiteToxicity(site.id, { notify: true });
          if (summary.newToxic.length) {
            console.log(
              `[backlink-tox-cron] site ${site.id}: ${summary.newToxic.length} new toxic donor(s)` +
                `${summary.notified ? " (alerted)" : ""}`,
            );
          }
        });
      } catch (e) {
        console.warn(`[backlink-tox-cron] site ${site.id} failed:`, e);
      }
    }
  } catch (e) {
    if (backlinksNotMigrated(e)) {
      disabled = true;
      console.warn("[backlink-tox-cron] SiteBacklink tables missing — scheduler disabled until restart");
      return;
    }
    console.warn("[backlink-tox-cron] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startBacklinkToxScheduler(): void {
  if (started) return;
  started = true;
  console.log("[backlink-tox-cron] scheduler started");
  setTimeout(() => void tick(), FIRST_TICK_MS);
  setInterval(() => void tick(), TICK_MS);
}
