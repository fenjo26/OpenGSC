import { prisma } from '@/lib/prisma';
import { getUserSerpCreds, checkSiteKeywords, RANK_STALE_MS } from '@/lib/rank';

// Background rank tracking. Runs inside the Next server process (started from
// instrumentation) — same pattern as the Clarity scheduler, no system cron needed.
//
// Strategy: tick hourly. For each site with tracked keywords, check the keywords whose
// last check is older than ~20h (or never checked). Resilient to restarts and missed
// windows. Sequential + capped per tick to stay kind to SERP provider quotas.

const TICK_MS = 60 * 60 * 1000; // 1 hour
const PER_SITE_CAP = 50;        // max keywords checked per site per tick

let started = false;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const staleBefore = new Date(Date.now() - RANK_STALE_MS);
    // Sites that have at least one stale tracked keyword.
    // Archived properties are skipped: the domain is usually gone or replaced, so every
    // check would burn a paid SERP call to record a rank for a site nobody looks at.
    const sites = await prisma.site.findMany({
      where: {
        archivedAt: null,
        trackedKeywords: {
          some: { OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: staleBefore } }] },
        },
      },
      select: { id: true, url: true, userId: true },
    });
    if (!sites.length) return;

    const credsByUser = new Map<string, Awaited<ReturnType<typeof getUserSerpCreds>>>();
    for (const site of sites) {
      try {
        if (!credsByUser.has(site.userId)) {
          credsByUser.set(site.userId, await getUserSerpCreds(site.userId));
        }
        const creds = credsByUser.get(site.userId);
        if (!creds) continue; // no SERP key configured — nothing we can do

        const r = await checkSiteKeywords(site.id, site.url, creds, { limit: PER_SITE_CAP });
        if (r.checked > 0) console.log(`[rank-cron] ${site.url}: checked ${r.checked}, errors ${r.errors}, remaining ${r.remaining}`);
      } catch (e) {
        console.warn(`[rank-cron] site ${site.id} failed:`, e);
      }
    }
  } catch (e) {
    console.warn('[rank-cron] tick failed:', e);
  } finally {
    running = false;
  }
}

export function startRankScheduler() {
  if (started) return;
  started = true;
  console.log('[rank-cron] scheduler started');
  // First run shortly after boot, then hourly.
  setTimeout(tick, 60_000);
  setInterval(tick, TICK_MS);
}
