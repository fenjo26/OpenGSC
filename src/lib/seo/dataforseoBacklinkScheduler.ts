// The weekly DataForSEO backlink refresh (issue #26) — the "monitor 25 client sites for a few
// dollars a year" use case. Off by default; a user turns it on in Settings → SEO Metrics with
// `seoMetricsAuto_dataforseo`, mirrored to the server under the `seoMetrics` prefix:
//
//   "weekly"       — summary + referring domains for every site of that workspace, once a week
//                    (≈ $0.05 per small site: one summary request, one page of domains);
//   "weekly_links" — the same, plus the per-link export (live + lost links), so the digest's
//                    new/lost section and the toxicity tab stay current too.
//
// Every run goes through the same price → cap → reserve → reconcile path as the buttons, against
// the user's own monthly cap (`seoMetricsCap_dataforseo`). A run refused by the cap is logged and
// retried next tick, never pushed past the cap. One site per user per tick keeps the account's
// concurrency budget for the SERP and demand modules that share the same credential.

import { prisma } from "@/lib/prisma";
import { rawQuery } from "@/lib/db/raw";
import { withCallContext } from "@/lib/providerLog/context";
import { resolveCaptureBodies } from "@/lib/providerLog/bodies";
import { normDomain } from "@/lib/seo/backlinkStore";
import { dataforseoSettings, refreshDataforseoProfile, startDataforseoExport } from "@/lib/seo/dataforseoBacklinks";

const TICK_MS = 60 * 60 * 1000;   // hourly; a site is due once its last pull is 7 days old
const FIRST_TICK_MS = 180_000;    // after the data-bearing loops have started
const WEEK_MS = 7 * 86_400_000;
const USERS_PER_TICK = 20;

let started = false;
let running = false;

/** YYYY-MM-DD of this instance's last own DataForSEO pull for a target ("" = never). */
async function lastPull(target: string): Promise<string> {
  try {
    const rows: any[] = await rawQuery(
      `SELECT MAX(date) AS d FROM "BacklinkSnapshot" WHERE target = ? AND provider = 'dataforseo' AND source = 'api'`,
      target,
    );
    return String(rows?.[0]?.d ?? "");
  } catch { return ""; }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Cheap pre-filter: only users whose settings mention the switch at all.
    const users: Array<{ id: string }> = await rawQuery(
      `SELECT id FROM "User" WHERE seoSettings LIKE ? LIMIT 500`, "%seoMetricsAuto_dataforseo%",
    );
    let handled = 0;
    for (const u of users) {
      if (handled >= USERS_PER_TICK) break;
      const cfg = await dataforseoSettings(u.id);
      if (cfg.auto === "off" || !cfg.creds) continue;
      const sites = await prisma.site.findMany({ where: { userId: u.id }, select: { id: true, url: true } });
      const dueBefore = new Date(Date.now() - WEEK_MS + 3600_000).toISOString().slice(0, 10);
      for (const site of sites) {
        const target = normDomain(String(site.url ?? "").replace(/^sc-domain:/, ""));
        if (!target || !target.includes(".")) continue;
        const last = await lastPull(target);
        if (last && last > dueBefore) continue;
        handled++;
        const captureBodies = await resolveCaptureBodies(u.id);
        await withCallContext({ userId: u.id, feature: "dataforseo-backlinks-cron", captureBodies }, async () => {
          const r = await refreshDataforseoProfile(u.id, target, cfg.creds!, cfg.cap);
          if (!r.ok) {
            console.warn(`[dfs-backlinks-cron] ${target}: ${r.error}`);
            return;
          }
          if (cfg.auto === "weekly_links") {
            const ex = await startDataforseoExport({
              userId: u.id, siteId: site.id, target, creds: cfg.creds!, cap: cfg.cap, confirm: true,
            });
            if (ex.run) await ex.run;
            else if (ex.status !== 200) console.warn(`[dfs-backlinks-cron] ${target} links: ${String(ex.body.error ?? ex.status)}`);
          }
        });
        break; // one site per user per tick
      }
    }
  } catch (e) {
    console.warn("[dfs-backlinks-cron] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startDataforseoBacklinkScheduler(): void {
  if (started) return;
  started = true;
  console.log("[dfs-backlinks-cron] scheduler started");
  setTimeout(() => void tick(), FIRST_TICK_MS);
  setInterval(() => void tick(), TICK_MS);
}
