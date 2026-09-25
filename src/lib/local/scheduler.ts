// Local SEO — the in-process loop (N4, brief §7). Same shape as serpmon/scheduler.ts: runs
// inside the Next server process from instrumentation, keeps a `running` flag against overlap,
// and disables itself permanently when the wave-nov Local*/Gbp* tables are missing.
//
// Tick = 10 min, three jobs:
//   1. GBP posts whose scheduledAt has passed → publish (status published/failed lands in the
//      list the UI shows);
//   2. GBP reviews every 6 h per site (last sync = max(GbpReview.fetchedAt); sites with no
//      reviews yet fall back to an in-memory last-attempt map);
//   3. citations every 7 days (checkedAt older than a week, or never), a few per tick.
// Without a connected GBP, jobs 1-2 resolve to gbp_no_token in one cheap read each and only the
// citation re-checks do real work — exactly the brief's "без подключённого GBP — только каталоги".
// Every external operation runs inside withCallContext, so the GBP calls land in the provider
// journal under the site owner (feature "local-cron").

import { prisma } from "@/lib/prisma";
import { withCallContext } from "@/lib/providerLog/context";
import { localSchemaMissing, dueCitations, duePosts, getProfile, setPostStatus } from "./store";
import { publishPost, syncGbpReviews } from "./gbp";
import { checkCitation } from "./runner";

const TICK_MS = 10 * 60_000;                // the brief's 10-minute tick
const FIRST_TICK_MS = 2 * 60_000;           // first pass shortly after boot, like the other loops
const REVIEWS_EVERY_MS = 6 * 60 * 60_000;   // reviews: every 6 h
const CITATIONS_STALE_MS = 7 * 24 * 60 * 60_000; // citations: weekly
const MAX_POSTS_PER_TICK = 5;
const MAX_REVIEWS_SITES_PER_TICK = 5;
const MAX_CITATIONS_PER_TICK = 8;

let started = false;
let running = false;
let kickQueued = false;
/** Set when the LocalProfile/LocalCitation/GbpPost/GbpReview tables are missing — the tick
 *  stops retrying until restart. */
let disabled = false;

/** Sites with no stored reviews have no fetchedAt to read; their last attempt lives here. */
const lastReviewAttempt = new Map<string, number>();

/** Sites with a profile AND a selected GBP location — the only ones reviews can sync for. */
async function gbpSites(): Promise<{ siteId: string; userId: string }[]> {
  const profiles = await prisma.localProfile.findMany({
    where: { gbpAccount: { not: null }, gbpLocation: { not: null } },
    select: { siteId: true, site: { select: { userId: true } } },
    take: 500,
  });
  return profiles.map(p => ({ siteId: p.siteId, userId: p.site.userId }));
}

async function lastReviewSyncAt(siteId: string): Promise<number> {
  const row = await prisma.gbpReview.findFirst({
    where: { siteId },
    orderBy: { fetchedAt: "desc" },
    select: { fetchedAt: true },
  }).catch(() => null);
  if (row?.fetchedAt) return row.fetchedAt.getTime();
  return lastReviewAttempt.get(siteId) ?? 0;
}

async function tick(): Promise<void> {
  if (running || disabled) return;
  running = true;
  try {
    // 1. Posts due for publication.
    const posts = await duePosts(MAX_POSTS_PER_TICK);
    for (const post of posts) {
      try {
        await withCallContext({ userId: post.userId, feature: "local-cron", captureBodies: false }, async () => {
          const profile = await getProfile(post.userId, post.siteId);
          if (!profile?.gbpAccount || !profile.gbpLocation) return;
          const row = await prisma.gbpPost.findUnique({ where: { id: post.id } });
          if (!row || row.status !== "scheduled") return;
          const res = await publishPost(post.userId, row, profile.gbpAccount, profile.gbpLocation);
          if (res.ok) {
            await setPostStatus(post.id, "published", { gbpName: res.gbpName ?? null });
          } else {
            // gbp_access_required included: the failure reason is data for the list, never a throw.
            await setPostStatus(post.id, "failed", { error: res.error ?? "gbp_error" });
          }
        });
      } catch (e) {
        console.warn(`[local-cron] post ${post.id} failed:`, e);
      }
    }

    // 2. Reviews every 6 h per site.
    const sites = await gbpSites();
    let reviewRuns = 0;
    for (const site of sites) {
      if (reviewRuns >= MAX_REVIEWS_SITES_PER_TICK) break;
      const last = await lastReviewSyncAt(site.siteId);
      if (Date.now() - last < REVIEWS_EVERY_MS) continue;
      reviewRuns++;
      lastReviewAttempt.set(site.siteId, Date.now());
      try {
        await withCallContext({ userId: site.userId, feature: "local-cron", captureBodies: false }, () =>
          syncGbpReviews(site.userId, site.siteId, { notify: true }),
        );
      } catch (e) {
        console.warn(`[local-cron] reviews for site ${site.siteId} failed:`, e);
      }
    }

    // 3. Citations weekly.
    const citations = await dueCitations(CITATIONS_STALE_MS, MAX_CITATIONS_PER_TICK);
    for (const citation of citations) {
      try {
        await withCallContext({ userId: citation.userId, feature: "local-cron", captureBodies: false }, async () => {
          const profile = await getProfile(citation.userId, citation.siteId);
          if (!profile) return; // no profile → nothing to compare against; wait for one
          await checkCitation(citation, profile);
        });
      } catch (e) {
        console.warn(`[local-cron] citation ${citation.id} failed:`, e);
      }
    }
  } catch (e) {
    if (localSchemaMissing(e)) {
      disabled = true;
      console.warn("[local-cron] Local*/Gbp* tables missing — scheduler disabled until restart");
      return;
    }
    console.warn("[local-cron] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startLocalScheduler(): void {
  if (started) return;
  started = true;
  console.log("[local-cron] scheduler started");
  setTimeout(() => void tick(), FIRST_TICK_MS);
  setInterval(() => void tick(), TICK_MS);
}

/**
 * Wake the loop now (after a post is scheduled or a citation added). Coalesced: a burst queues
 * exactly one immediate tick; a tick already in flight makes this a no-op.
 */
export function kickLocalScheduler(): void {
  if (!started || running || disabled || kickQueued) return;
  kickQueued = true;
  setTimeout(() => {
    kickQueued = false;
    void tick();
  }, 0);
}
