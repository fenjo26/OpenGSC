import { prisma } from '@/lib/prisma';
import { getUserAeoCreds, hasAnyAeoCreds, siteAeoConfig, checkSiteQuestions, AEO_STALE_MS } from '@/lib/aeoTracker';

// Background AEO citation tracking. Runs inside the Next server process (started from
// instrumentation) — same pattern as the Clarity/Rank schedulers, no system cron needed.
//
// Strategy: tick every few hours. For each *opted-in* site with tracked questions, check the
// ones whose last check is older than ~24h (or never checked).
//
// Opt-in (Site.aeoAuto) is the important word. Unlike a rank check, an AEO check spends the
// user's own AI credits — four billed calls per question with live web search on each. An
// instance with a few hundred connected properties would quietly burn a real bill on questions
// nobody was waiting for an answer to, so automatic checking is something a site has to be
// enrolled in deliberately. Everything else is checked on demand from the UI.

const TICK_MS = 4 * 60 * 60 * 1000; // 4 hours
const PER_SITE_CAP = 10;            // max questions checked per site per tick

let started = false;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const staleBefore = new Date(Date.now() - AEO_STALE_MS);
    // Archived properties are skipped — an AEO check on a dead domain costs an AI call
    // and can only ever come back empty.
    const sites = await prisma.site.findMany({
      where: {
        archivedAt: null,
        aeoAuto: true,
        trackedQuestions: {
          some: { OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: staleBefore } }] },
        },
      },
      select: {
        id: true, url: true, userId: true, brandedKeywords: true, market: true,
        aeoModel: true, aeoCountry: true, aeoCity: true, aeoLanguage: true,
      },
    });
    if (!sites.length) return;

    const credsByUser = new Map<string, Awaited<ReturnType<typeof getUserAeoCreds>>>();
    for (const site of sites) {
      try {
        if (!credsByUser.has(site.userId)) {
          credsByUser.set(site.userId, await getUserAeoCreds(site.userId));
        }
        const creds = credsByUser.get(site.userId)!;
        if (!hasAnyAeoCreds(creds)) continue; // no AEO-capable key configured — nothing we can do

        const r = await checkSiteQuestions(site.id, siteAeoConfig(site), creds, { limit: PER_SITE_CAP });
        if (r.checked > 0) console.log(`[aeo-cron] ${site.url}: checked ${r.checked}, remaining ${r.remaining}`);
      } catch (e) {
        console.warn(`[aeo-cron] site ${site.id} failed:`, e);
      }
    }
  } catch (e) {
    console.warn('[aeo-cron] tick failed:', e);
  } finally {
    running = false;
  }
}

export function startAeoScheduler() {
  if (started) return;
  started = true;
  console.log('[aeo-cron] scheduler started');
  // First run shortly after boot (staggered after the rank scheduler's own boot delay), then
  // every few hours.
  setTimeout(tick, 90_000);
  setInterval(tick, TICK_MS);
}
