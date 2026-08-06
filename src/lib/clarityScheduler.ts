import { prisma } from '@/lib/prisma';
import { runClarityFetch } from '@/lib/clarityFetch';

// Background auto-collect for Microsoft Clarity. Runs inside the Next server
// process (started from instrumentation). No system cron / extra process needed.
//
// Strategy: tick hourly. For each site with clarityInterval="daily", if its most
// recent snapshot is older than ~20h (or there is none), fetch one fresh day.
// This is resilient to restarts and missed windows (no exact-time dependency),
// and stays well within Clarity's 10 requests/day limit.

const TICK_MS = 60 * 60 * 1000;   // 1 hour
const STALE_MS = 20 * 60 * 60 * 1000; // 20 hours

let started = false;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const sites = await prisma.site.findMany({
      // Archived properties are skipped — the Clarity project for a replaced domain
      // stops receiving traffic, so daily collection just logs failures.
      where: { archivedAt: null, clarityInterval: 'daily', clarityToken: { not: null } },
      select: { id: true, url: true },
    });
    for (const site of sites) {
      try {
        const last = await prisma.claritySnapshot.findFirst({
          where: { siteId: site.id },
          orderBy: { fetchedAt: 'desc' },
          select: { fetchedAt: true },
        });
        const age = last ? Date.now() - new Date(last.fetchedAt).getTime() : Infinity;
        if (age < STALE_MS) continue;

        const res = await runClarityFetch(site.id, 1);
        if (res.ok) console.log(`[clarity-cron] fetched ${site.url}`);
        else console.warn(`[clarity-cron] ${site.url}: ${res.error}`);
      } catch (e) {
        console.warn(`[clarity-cron] site ${site.id} failed:`, e);
      }
    }
  } catch (e) {
    console.warn('[clarity-cron] tick failed:', e);
  } finally {
    running = false;
  }
}

export function startClarityScheduler() {
  if (started) return;
  started = true;
  console.log('[clarity-cron] scheduler started');
  // First run shortly after boot, then hourly.
  setTimeout(tick, 30_000);
  setInterval(tick, TICK_MS);
}
