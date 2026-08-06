import { prisma } from '@/lib/prisma';
import { google } from 'googleapis';
import { recordSyncCompleted } from '@/lib/syncSchedule';

let isSyncing = false;

export interface SyncResult {
  completedAt: Date | null;
  sitesSynced: number;
  // Properties this run moved into or out of the archive because Google's site list changed.
  sitesArchived: number;
  sitesRestored: number;
  accountErrors: { accountId: string; error: string; needsReauth: boolean }[];
  siteErrors: { site: string; error: string }[];
}

let lastSyncResult: SyncResult = {
  completedAt: null,
  sitesSynced: 0,
  sitesArchived: 0,
  sitesRestored: 0,
  accountErrors: [],
  siteErrors: [],
};

// When the run in progress began. Sites are synced one after another against Google's API, so a
// couple of hundred properties take tens of minutes; without this the UI can only show a spinner
// and hope, and a run that is merely long is indistinguishable from one that has died.
let syncStartedAt: Date | null = null;

export function isSyncInProgress() { return isSyncing; }
export function getLastSyncResult() { return lastSyncResult; }
export function getSyncStartedAt() { return syncStartedAt; }

// How many properties are fetched at once.
//
// Sites used to be walked strictly one at a time, which is why a couple of hundred of them took
// tens of minutes: three Google calls per site at a second or two each, all in single file.
// Google's own limits are nowhere near that conservative — Search Analytics allows 1,200 queries
// per minute per user and per site, and a whole run of 200 sites is about 600 calls.
//
// The limit that actually matters is the load quota, which is measured in ten-minute chunks and
// grows with the date range and with grouping by page and query — exactly what the third call
// does. That is an argument for a modest pool rather than an unlimited one: five keeps the run
// short without turning the whole day's load into one burst.
const SITE_CONCURRENCY = 5;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Run `worker` over `items`, at most `limit` at a time, preserving no order. */
async function pooled<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      await worker(items[i]);
    }
  });
  await Promise.all(lanes);
}

function isQuotaError(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; message?: string };
  const status = Number(e?.code ?? e?.status);
  return status === 429 || /quota|rate.?limit|too many requests/i.test(String(e?.message ?? ''));
}

/**
 * Retry a Google call that came back over quota.
 *
 * Only quota errors are retried, and only a few times: everything else — a revoked token, a
 * property that no longer exists — is a real answer and repeating it just makes the run longer.
 * The wait starts at 20 seconds because the short-term quota is measured in ten-minute chunks,
 * so a one-second retry would simply fail again.
 */
async function withQuotaRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let wait = 20_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isQuotaError(err)) throw err;
      console.warn(`[GSC Sync]   ${label}: over quota, waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      wait *= 2;
    }
  }
}

function cleanSiteUrl(siteUrl: string): string {
  if (siteUrl.startsWith('sc-domain:')) {
    return siteUrl.slice('sc-domain:'.length);
  }
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return siteUrl;
  }
}

export async function runGscSync() {
  if (isSyncing) {
    console.log('[GSC Sync] Already in progress — skipping.');
    return;
  }
  isSyncing = true;
  syncStartedAt = new Date();

  const result: SyncResult = {
    completedAt: null,
    sitesSynced: 0,
    sitesArchived: 0,
    sitesRestored: 0,
    accountErrors: [],
    siteErrors: [],
  };

  // Whose data this run touched, so the completion time can be written somewhere that survives a
  // restart. `lastSyncResult` below is a module variable and a deploy wipes it, which is how the
  // dashboard ended up claiming the last sync was two days ago while the settings page, reading
  // from the database, showed one from that morning.
  const syncedUserIds: string[] = [];

  // Every property Google returned for a user, pooled across all of their linked accounts, plus
  // the users whose site list failed to load at all. The archive is reconciled from these once
  // the account loop is done — a user with two accounts must not have the sites from one of them
  // archived just because the other account was processed first.
  const liveSiteIdsByUser = new Map<string, Set<string>>();
  const listingFailedUsers = new Set<string>();

  try {
    console.log('[GSC Sync] Starting…');

    // Include userId via the user relation so we can create sites per user
    const accounts = await prisma.account.findMany({
      where: { provider: 'google' },
      include: { user: { select: { id: true } } },
    });

    if (accounts.length === 0) {
      console.log('[GSC Sync] No Google accounts found.');
      return;
    }

    // GSC 'final' data lags ~2 days
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 2);
    endDate.setHours(23, 59, 59, 999);

    // Recent window: last 30 days (fast, syncs first for all sites)
    const recentStart = new Date(endDate);
    recentStart.setDate(endDate.getDate() - 30);
    recentStart.setHours(0, 0, 0, 0);

    // Historical window: last 16 months (slower, for long period views)
    const histStart = new Date(endDate);
    histStart.setDate(endDate.getDate() - 480);
    histStart.setHours(0, 0, 0, 0);

    const endDateStr      = endDate.toISOString().split('T')[0];
    const recentStartStr  = recentStart.toISOString().split('T')[0];
    const histStartStr    = histStart.toISOString().split('T')[0];

    console.log(`[GSC Sync] Recent: ${recentStartStr} → ${endDateStr}`);
    console.log(`[GSC Sync] History: ${histStartStr} → ${endDateStr}`);

    for (const account of accounts) {
      const userId = account.user.id;
      syncedUserIds.push(userId);
      console.log(`[GSC Sync] Account: ${account.providerAccountId} (user: ${userId})`);

      const oauth2 = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      );
      oauth2.setCredentials({
        access_token:  account.access_token,
        refresh_token: account.refresh_token,
        expiry_date:   account.expires_at ? account.expires_at * 1000 : undefined,
      });
      oauth2.on('tokens', async (tokens) => {
        await prisma.account.update({
          where: { id: account.id },
          data: {
            access_token:  tokens.access_token  ?? account.access_token,
            refresh_token: tokens.refresh_token ?? account.refresh_token,
            expires_at:    tokens.expiry_date
              ? Math.floor(tokens.expiry_date / 1000)
              : account.expires_at,
          },
        });
      });

      const wm = google.webmasters({ version: 'v3', auth: oauth2 });

      let siteList: { siteUrl?: string | null; permissionLevel?: string | null }[] = [];
      try {
        const res = await wm.sites.list();
        siteList = res.data.siteEntry ?? [];
        console.log(`[GSC Sync]   Found ${siteList.length} sites in GSC`);
        const live = liveSiteIdsByUser.get(userId) ?? new Set<string>();
        for (const entry of siteList) if (entry.siteUrl) live.add(entry.siteUrl);
        liveSiteIdsByUser.set(userId, live);
      } catch (err: any) {
        console.error(`[GSC Sync]   Failed to list sites: ${err.message}`);
        const needsReauth = /invalid_grant|token.*expired|unauthorized|invalid.*token/i.test(err.message);
        result.accountErrors.push({
          accountId: account.providerAccountId,
          error: err.message,
          needsReauth,
        });
        // Marks the whole user, not just this account: with an incomplete picture of what they
        // own, anything "missing" might simply be behind the token that just failed.
        listingFailedUsers.add(userId);
        continue;
      }

      // One site, start to finish. The three Google calls inside stay sequential — they are the
      // same property, and the second and third are the expensive ones — while `pooled` below
      // runs several sites side by side.
      //
      // Progress is logged as a single line at the end rather than five lines as it goes: with
      // five sites in flight, interleaved lines belong to whichever site got there first, and a
      // log you have to reassemble by hand is worse than no log.
      const syncOneSite = async (gscSite: { siteUrl?: string | null }) => {
        if (!gscSite.siteUrl) return;

        const gscUrl   = gscSite.siteUrl;
        const hostname = cleanSiteUrl(gscUrl);
        const hostnameNoWww = hostname.replace(/^www\./, '');
        const note: string[] = [];

        // ── Step 1: ensure site exists in DB for this user ──────────────────
        let dbSite = await prisma.site.findFirst({
          where: {
            userId,
            OR: [
              { siteId: gscUrl },
              { url: hostname },
              { url: hostnameNoWww },
            ],
          },
        });

        if (!dbSite) {
          // Auto-create site for this user from this GSC account
          console.log(`[GSC Sync]   Creating new site: ${hostname} for user ${userId}`);
          try {
            dbSite = await prisma.site.create({
              data: {
                userId,
                siteId: gscUrl,
                url:    hostnameNoWww || hostname,
                tags:   '',
              },
            });
          } catch (err: any) {
            // May fail on duplicate userId+siteId — try to fetch instead
            dbSite = await prisma.site.findFirst({
              where: { userId, siteId: gscUrl },
            });
            if (!dbSite) {
              console.error(`[GSC Sync]   Could not create site: ${err.message}`);
              return;
            }
          }
        } else {
          // Anything Google still hands us is live by definition, so a row that was archived
          // (property removed, or verification briefly lapsed) comes back out of the archive
          // here. Patching siteId in the same write keeps it to one round trip.
          const patch: { siteId?: string; archivedAt?: null } = {};
          if (dbSite.siteId !== gscUrl) patch.siteId = gscUrl;
          if (dbSite.archivedAt) patch.archivedAt = null;
          if (Object.keys(patch).length > 0) {
            await prisma.site.update({ where: { id: dbSite.id }, data: patch }).catch(() => {});
          }
        }

        // ── Step 2: sync daily metrics (recent first, then history) ─────────
        // Check if we already have recent data (to decide whether to do full history)
        const recentCount = await prisma.dailyMetric.count({
          where: { siteId: dbSite.id, date: { gte: recentStart }, url: '', query: '' },
        });
        const needsHistory = recentCount === 0; // new site → fetch full history

        const startDateStr = needsHistory ? histStartStr : recentStartStr;
        note.push(`${startDateStr} → ${endDateStr}${needsHistory ? ' (full history)' : ''}`);

        try {
          const res = await withQuotaRetry(hostname, () => wm.searchanalytics.query({
            siteUrl: gscUrl,
            requestBody: {
              startDate:  startDateStr,
              endDate:    endDateStr,
              dimensions: ['date'],
              rowLimit:   25000,
              dataState:  'all',
            },
          }));

          const rows = res.data.rows ?? [];
          note.push(`${rows.length} days`);

          if (rows.length > 0) {
            const rangeStart = new Date(startDateStr);

            // Delete existing records for this range in one query, then bulk-insert
            await prisma.dailyMetric.deleteMany({
              where: {
                siteId: dbSite.id,
                url:    '',
                query:  '',
                date:   { gte: rangeStart, lte: endDate },
              },
            });

            await prisma.dailyMetric.createMany({
              data: rows
                .filter(row => row.keys?.[0])
                .map(row => ({
                  siteId:      dbSite.id,
                  date:        new Date(row.keys![0]),
                  url:         '',
                  query:       '',
                  clicks:      row.clicks      ?? 0,
                  impressions: row.impressions ?? 0,
                  ctr:         row.ctr         ?? 0,
                  position:    row.position    ?? 0,
                })),
            });
            result.sitesSynced++;
          }
        } catch (err: any) {
          console.error(`[GSC Sync]     Error syncing ${hostname}: ${err.message}`);
          result.siteErrors.push({ site: hostname, error: err.message });
        }

        // ── Step 3: sync per-URL daily data (Content Decay Map) ─────────────
        // 90-day window gives ~3 monthly or ~13 weekly buckets in the decay map
        const url90Start = new Date(endDate);
        url90Start.setDate(endDate.getDate() - 90);
        url90Start.setHours(0, 0, 0, 0);
        const url90StartStr = url90Start.toISOString().split('T')[0];

        try {
          const urlRes = await withQuotaRetry(hostname, () => wm.searchanalytics.query({
            siteUrl: gscUrl,
            requestBody: {
              startDate:  url90StartStr,
              endDate:    endDateStr,
              dimensions: ['date', 'page'],
              rowLimit:   25000,
              dataState:  'all',
            },
          }));

          const urlRows = urlRes.data.rows ?? [];
          note.push(`${urlRows.length} url-day`);

          if (urlRows.length > 0) {
            await prisma.dailyMetric.deleteMany({
              where: {
                siteId: dbSite.id,
                url:    { not: '' },
                query:  '',
                date:   { gte: url90Start, lte: endDate },
              },
            });
            await prisma.dailyMetric.createMany({
              data: urlRows
                .filter(r => r.keys?.[0] && r.keys?.[1])
                .map(r => ({
                  siteId:      dbSite.id,
                  date:        new Date(r.keys![0]),
                  url:         r.keys![1],
                  query:       '',
                  clicks:      r.clicks      ?? 0,
                  impressions: r.impressions ?? 0,
                  ctr:         r.ctr         ?? 0,
                  position:    r.position    ?? 0,
                })),
            });
          }
        } catch (err: any) {
          console.error(`[GSC Sync]     Error syncing URL data for ${hostname}: ${err.message}`);
        }

        // ── Step 4: sync per-query+page data (Cannibalization/Striking/CTR) ──
        // No date dimension — returns aggregated totals over the 90-day window.
        // Stored with date=endDate so tools querying date>=since always find it.
        try {
          const qpRes = await withQuotaRetry(hostname, () => wm.searchanalytics.query({
            siteUrl: gscUrl,
            requestBody: {
              startDate:  url90StartStr,
              endDate:    endDateStr,
              dimensions: ['query', 'page'],
              rowLimit:   25000,
              dataState:  'all',
            },
          }));

          const qpRows = qpRes.data.rows ?? [];
          note.push(`${qpRows.length} query+page`);

          if (qpRows.length > 0) {
            // Delete all prior query+url summary rows for this site, then re-insert
            await prisma.dailyMetric.deleteMany({
              where: {
                siteId: dbSite.id,
                url:    { not: '' },
                query:  { not: '' },
              },
            });
            await prisma.dailyMetric.createMany({
              data: qpRows
                .filter(r => r.keys?.[0] && r.keys?.[1])
                .map(r => ({
                  siteId:      dbSite.id,
                  date:        endDate,        // summary date — always within any recent range
                  url:         r.keys![1],     // page URL
                  query:       r.keys![0],     // search query
                  clicks:      r.clicks      ?? 0,
                  impressions: r.impressions ?? 0,
                  ctr:         r.ctr         ?? 0,
                  position:    r.position    ?? 0,
                })),
            });
          }
        } catch (err: any) {
          console.error(`[GSC Sync]     Error syncing query+page data for ${hostname}: ${err.message}`);
        }

        console.log(`[GSC Sync]   ${hostname}: ${note.join(', ')}`);
      };

      await pooled(siteList, SITE_CONCURRENCY, syncOneSite);
    }

    // ── Reconcile the archive ────────────────────────────────────────────────
    // A property dropped from Search Console (removed, unverified, or the domain was
    // replaced) stops appearing in sites.list, but its row used to stay on the dashboard
    // forever because nothing ever pruned it. It is flagged rather than deleted, so the
    // metrics, audits and keywords already collected remain available.
    //
    // Runs on the scheduled sync as well as the dashboard's own site fetch, so a headless
    // instance nobody has opened in a week still keeps the list honest.
    for (const [userId, liveSiteIds] of liveSiteIdsByUser) {
      // Skipping a user whose listing failed is the whole point of tracking it: archiving on
      // a partial read would empty a dashboard because a token expired, not because anything
      // was actually removed. An empty list is treated the same way — a user really owning
      // zero properties has nothing to archive anyway.
      if (listingFailedUsers.has(userId) || liveSiteIds.size === 0) continue;

      try {
        const known = await prisma.site.findMany({
          where: { userId },
          select: { id: true, siteId: true, archivedAt: true },
        });
        const toArchive = known.filter(s => !s.archivedAt && !liveSiteIds.has(s.siteId)).map(s => s.id);
        const toRestore = known.filter(s =>  s.archivedAt &&  liveSiteIds.has(s.siteId)).map(s => s.id);

        if (toArchive.length > 0) {
          result.sitesArchived += (await prisma.site.updateMany({
            where: { id: { in: toArchive } },
            data: { archivedAt: new Date() },
          })).count;
        }
        if (toRestore.length > 0) {
          result.sitesRestored += (await prisma.site.updateMany({
            where: { id: { in: toRestore } },
            data: { archivedAt: null },
          })).count;
        }
      } catch (err) {
        // Never fails the run: the metrics above are the job, this is bookkeeping.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[GSC Sync]   Archive reconcile failed for user ${userId}: ${msg}`);
      }
    }
  } catch (e) {
    console.error('[GSC Sync] Fatal error:', e);
  } finally {
    result.completedAt = new Date();
    lastSyncResult = result;
    isSyncing = false;
    // Elapsed time is logged because it is the number that settles arguments: "the sync is
    // stuck" and "the sync takes 22 minutes for 201 sites" look identical from the browser.
    const elapsedMs = syncStartedAt ? result.completedAt.getTime() - syncStartedAt.getTime() : 0;
    const elapsed = `${Math.floor(elapsedMs / 60000)}m${String(Math.floor((elapsedMs % 60000) / 1000)).padStart(2, '0')}s`;
    syncStartedAt = null;
    console.log(`[GSC Sync] Done in ${elapsed}. sites=${result.sitesSynced} archived=${result.sitesArchived} restored=${result.sitesRestored} accountErrors=${result.accountErrors.length} siteErrors=${result.siteErrors.length}`);

    // Persist the completion time. Deliberately after the log line and outside anything that can
    // abort the run: this is a nicety for the UI, not part of the sync.
    await recordSyncCompleted(syncedUserIds, result.completedAt).catch(() => {});
  }
}
