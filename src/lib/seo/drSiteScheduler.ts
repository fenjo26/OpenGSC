// The monthly DR walk over the workspace's own sites: every site domain owes DrSnapshot one
// fresh point per month, the same way the drops watch loop grows its watched rows. Without
// this walk the series only grows where a human happened to open a page after the value
// cache expired — which in practice means one September point and nothing after it, and the
// DR sparkline on the site page and dashboard never gets its second point to draw.
//
// One point per (domain, month) is the storage contract, so this cannot bill or hammer
// anything beyond a single free-endpoint fetch per domain per month, capped per tick. The
// key is resolved from each site owner's server settings — history growth therefore does not
// depend on a browser having typed the DR key either.

import { prisma } from "@/lib/prisma";
import { rawQuery } from "@/lib/db/raw";
import { monthKey } from "./drHistory";
import { drForDomains } from "@/lib/drops/drFree";

const TICK_MS = 5 * 60 * 1000;  // 5 minutes — a 245-site workspace drains in ~4 ticks on the 1st
const DOMAINS_PER_TICK = 60;    // matches drForDomains' own FREE_CAP batch shape
const SITE_SCAN_CAP = 5000;     // safety net; a workspace past this has bigger problems
const CHUNK = 400;              // SQLite bound-parameter ceiling, same as the drops store

let started = false;
let running = false;
/** Set when DrSnapshot is missing — without it every walk would "succeed" without writing a
 *  point, stay stale, and re-fetch the whole workspace every tick until the migration runs. */
let disabled = false;

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

/**
 * Site domains whose latest stored month is older than the current one, grouped by the owner
 * whose DR key measures them. A domain shared by two sites (two users) is measured once —
 * DrSnapshot is keyed by domain, so the second point would be the same row anyway.
 */
async function staleSiteDomains(limit: number): Promise<Array<{ userId: string; domain: string }>> {
  const sites = await prisma.site.findMany({ select: { userId: true, url: true }, take: SITE_SCAN_CAP });
  const owner: Map<string, string> = new Map(); // domain → first userId seen
  for (const s of sites) {
    const host = hostOf(s.url);
    if (host && host.includes(".") && !owner.has(host)) owner.set(host, s.userId);
  }
  const domains = [...owner.keys()];
  if (!domains.length) return [];

  const month = monthKey();
  const latest: Record<string, string> = {};
  try {
    for (let i = 0; i < domains.length; i += CHUNK) {
      const part = domains.slice(i, i + CHUNK);
      const rows = await rawQuery(
        `SELECT domain, MAX(month) AS latest FROM "DrSnapshot" WHERE domain IN (${part.map(() => "?").join(",")}) GROUP BY domain`,
        ...part,
      ) as Array<{ domain: string; latest: string }>;
      for (const r of rows) latest[r.domain] = String(r.latest);
    }
  } catch {
    // DrSnapshot missing until prisma db push. Unlike the drops watch loop (bounded by its
    // watched rows), re-fetching every site domain every tick until the migration runs is
    // exactly the hammering this scheduler exists to avoid — stop until restart.
    disabled = true;
    console.warn("[dr-site-walk] DrSnapshot table missing — scheduler disabled until restart");
    return [];
  }

  const stale: Array<{ userId: string; domain: string }> = [];
  for (const [domain, userId] of owner) {
    if ((latest[domain] ?? "") < month) stale.push({ userId, domain });
    if (stale.length >= limit) break;
  }
  return stale;
}

async function tick() {
  if (running || disabled) return;
  running = true;
  try {
    const stale = await staleSiteDomains(DOMAINS_PER_TICK);
    if (!stale.length) return;
    const byUser = new Map<string, string[]>();
    for (const r of stale) {
      if (!byUser.has(r.userId)) byUser.set(r.userId, []);
      byUser.get(r.userId)!.push(r.domain);
    }
    for (const [userId, domains] of byUser) {
      try {
        // force: the month flipped — the 7-day value cache must not postpone the point.
        const { ratings, keyFound } = await drForDomains(userId, domains, { force: true });
        if (keyFound && Object.keys(ratings).length) {
          console.log(`[dr-site-walk] DR point recorded for ${Object.keys(ratings).length} site domain(s)`);
        }
        // keyFound=false (no DR key anywhere) stays silent, same policy as the drops watch:
        // it would repeat every tick, and the DR UI already points at Settings.
      } catch (e) {
        console.warn("[dr-site-walk] DR refresh failed:", e);
      }
    }
  } catch (e) {
    console.warn("[dr-site-walk] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startDrSiteScheduler() {
  if (started) return;
  started = true;
  console.log("[dr-site-walk] scheduler started");
  // First pass shortly after boot (after the drops watch's own 45s, so a cold instance that
  // owes everyone a point spreads the two walks' first bursts), then every five minutes.
  setTimeout(tick, 2 * 60_000);
  setInterval(tick, TICK_MS);
}
