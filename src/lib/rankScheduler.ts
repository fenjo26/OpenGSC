import { prisma } from '@/lib/prisma';
import { getUserSerpCreds, checkSiteKeywords, RANK_STALE_MS, type PackChange } from '@/lib/rank';
import { resolveCaptureBodies } from '@/lib/providerLog/bodies';
import { withCallContext } from '@/lib/providerLog/context';
import { notifyUser } from '@/lib/notify';
import { NOTIFY_L, normalizeLang } from '@/lib/notifyI18n';
import { getAlertSettings } from '@/lib/alertScheduler';

// Background rank tracking. Runs inside the Next server process (started from
// instrumentation) — same pattern as the Clarity scheduler, no system cron needed.
//
// Strategy: tick hourly. For each site with tracked keywords, check the keywords whose
// last check is older than ~20h (or never checked). Resilient to restarts and missed
// windows. Sequential + capped per tick to stay kind to SERP provider quotas.
//
// wave-nov N3: after a site's batch, pack changes found in it (a local keyword left / entered
// the map pack, or moved inside it) are reported once per UTC day per site — the AlertEvent
// dedupe (`lp:<siteId>:<day>`) is what makes "once" true across the hourly tick AND the
// manual "Check positions" button, which runs the same batch through the same reporter.

const TICK_MS = 60 * 60 * 1000; // 1 hour
const PER_SITE_CAP = 50;        // max keywords checked per site per tick

let started = false;
let running = false;

const isoUtcDay = () => new Date().toISOString().slice(0, 10);

const packPlace = (n: number | null): string => (n == null ? "—" : `#${n}`);

/** The label other rank alerts use for a site: its URL, protocol stripped. */
export function siteLabelOf(siteUrl: string): string {
  return String(siteUrl ?? "").replace(/^https?:\/\//, "").replace(/^sc-domain:/, "");
}

/**
 * Report map-pack changes for one site: one notification per UTC day, event `local`,
 * template `localPackTitle/Msg`. Lines are language-neutral on purpose (`"kw" [city]: #2 → #1`)
 * — the N0 templates carry the localized words around them. Returns true when a notification
 * was sent. Also called from POST /api/rank/check, so a manual check reports the same change
 * the scheduler would have — and the dedupe key keeps it to one message a day either way.
 */
export async function reportLocalPackChanges(
  userId: string, siteId: string, siteUrl: string, changes: readonly PackChange[],
): Promise<boolean> {
  if (!changes.length) return false;
  let lang = normalizeLang(undefined);
  try {
    lang = normalizeLang((await getAlertSettings(userId)).lang);
  } catch { /* settings unreadable — English beats silence */ }
  const L = NOTIFY_L[lang];
  const lines = changes.map((c) => `"${c.keyword}"${c.location ? ` [${c.location}]` : ""}: ${packPlace(c.from)} → ${packPlace(c.to)}`).join("\n");
  const title = L.localPackTitle(siteLabelOf(siteUrl));
  const message = L.localPackMsg(siteLabelOf(siteUrl), lines);
  const dedupeKey = `lp:${siteId}:${isoUtcDay()}`;
  try {
    await prisma.alertEvent.create({
      data: { userId, type: "local_pack", siteId, title, message, dedupeKey },
    });
  } catch {
    return false; // already reported for this site today
  }
  const ok = await notifyUser(userId, `${title}\n\n${message}`, { event: "local", title });
  if (ok) await prisma.alertEvent.updateMany({ where: { userId, dedupeKey }, data: { sent: true } });
  return ok;
}

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
      // A timer inherits no request, so the log would file every one of these paid SERP calls
      // under nobody unless the owner is named here. The wrapper goes around the whole per-site
      // body, credential read included: a call made a line above it is a call logged as nobody's.
      //
      // Bodies are the site owner's own opt-in, read once here because the logger cannot read it
      // later. A tick that spans an hour keeps whatever it started with, which the settings copy
      // says out loud.
      const captureBodies = await resolveCaptureBodies(site.userId);
      await withCallContext({ userId: site.userId, feature: "rank-cron", captureBodies }, async () => {
        try {
          if (!credsByUser.has(site.userId)) {
            credsByUser.set(site.userId, await getUserSerpCreds(site.userId));
          }
          const creds = credsByUser.get(site.userId);
          if (!creds) return; // no SERP key configured — nothing we can do

          const r = await checkSiteKeywords(site.id, site.url, creds, { limit: PER_SITE_CAP });
          if (r.checked > 0) console.log(`[rank-cron] ${site.url}: checked ${r.checked}, errors ${r.errors}, remaining ${r.remaining}`);
          if (r.packChanges?.length) {
            await reportLocalPackChanges(site.userId, site.id, site.url, r.packChanges);
          }
        } catch (e) {
          console.warn(`[rank-cron] site ${site.id} failed:`, e);
        }
      });
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
