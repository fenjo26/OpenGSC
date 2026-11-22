import { prisma } from '@/lib/prisma';
import { bumpReportCacheVersion } from "@/lib/gsc/reportCache";
import { QUERY_PAGE_DAILY_DAYS } from "@/lib/gsc/reportData";
import { google } from 'googleapis';
import { recordSyncFinished } from '@/lib/syncSchedule';
import { planQueryHistory, type DayRange } from "@/lib/gsc/queryHistoryPlan";
import { localYmd, utcDay } from "@/lib/periodWindow";
import { isGscQuotaError } from "@/lib/gsc/gscFailure";
import {
  classifySyncError,
  errorText,
  sanitizeSyncError,
  summarizeSyncFailure,
  type SyncFailureKind,
} from '@/lib/gscSyncHealth';

let isSyncing = false;

export interface SyncResult {
  completedAt: Date | null;
  sitesSynced: number;
  // Properties this run moved into or out of the archive because Google's site list changed.
  sitesArchived: number;
  sitesRestored: number;
  accountErrors: { accountId: string; error: string; needsReauth: boolean; kind: SyncFailureKind }[];
  siteErrors: { site: string; error: string; kind: SyncFailureKind }[];
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

const isQuotaError = isGscQuotaError;

/** Search Console's maximum rows per searchanalytics request. */
const GSC_ROW_LIMIT = 25_000;
/** Days of per-URL daily rows refreshed on every sync — see Step 3. */
const URL_DAILY_DAYS = 120;
/** Upper bound on date×page pages per site per sync (×25k rows). */
const URL_DAILY_MAX_PAGES = 8;
/** Upper bound on query×page pages per site per sync (×25k rows) — see Step 4. */
const QUERY_PAGE_MAX_PAGES = 8;
/** Upper bound on date×query×page pages per site per sync (×25k rows) — see Step 5. */
const QUERY_PAGE_DAILY_MAX_PAGES = 8;
/** Upper bound on date×query pages per planned range per sync (×25k rows) — see Step 6. */
const QUERY_HISTORY_MAX_PAGES = 8;

// A backfill chunk that died on quota must not come back on the very next sync: retrying the
// same heavy 30-day fetch every run keeps the property pinned at its load ceiling, which is
// what starves the dashboard's live tables for days (issue #38). The site's backfill (never
// its tail) pauses for this long after a quota failure. In-memory: a restart just retries.
const QUERY_HISTORY_QUOTA_PAUSE_MS = 6 * 60 * 60_000;
const queryHistoryPausedUntil = new Map<string, number>();

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

export async function runGscSync(): Promise<SyncResult | null> {
  if (isSyncing) {
    console.log('[GSC Sync] Already in progress — skipping.');
    return null;
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
      return result;
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
      } catch (err: unknown) {
        const text = errorText(err);
        const kind = classifySyncError(text);
        console.error(`[GSC Sync]   Failed to list sites: ${text}`);
        // Scope errors ("Request had insufficient authentication scopes.", "Insufficient
        // Permission") and a revoked refresh token (`invalid_grant`, often only on
        // response.data while message is "Request failed with status code 400") never
        // recover on retry. The user has to sign in again and grant the full scopes.
        result.accountErrors.push({
          accountId: account.providerAccountId,
          error: sanitizeSyncError(text),
          needsReauth: kind === 'reauth',
          kind,
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
          } catch (err) {
            // May fail on duplicate userId+siteId — try to fetch instead
            dbSite = await prisma.site.findFirst({
              where: { userId, siteId: gscUrl },
            });
            if (!dbSite) {
              console.error(`[GSC Sync]   Could not create site: ${(err as Error).message}`);
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

        // ── Step 2: sync daily metrics per search type (recent first, then history) ──
        // The date-only rollup is one row-kind per GSC search type (url='' query='' +
        // searchType), so every count/delete/insert below is type-scoped. Web keeps the
        // historic rhythm (empty recent window → full-history refetch); a non-web type
        // backfills its full history exactly once — the first sync where it has no rows —
        // then follows the recent window. A type GSC rejects is logged and skipped: it must
        // never take the web sync down with it.
        const rollupTypes = ['web', 'discover', 'news', 'image', 'video'];
        // The web rollup is the sync that counts. URL and query breakdowns can fail
        // without meaning the property was not refreshed. A thrown web call does not
        // move lastGscSyncAt — including when the body is invalid_grant.
        let webOk = false;
        for (const searchType of rollupTypes) {
          const hasRecent = (await prisma.dailyMetric.count({
            where: { siteId: dbSite.id, date: { gte: recentStart }, url: '', query: '', searchType },
          })) > 0;
          const needsTypeHistory = searchType === 'web'
            ? !hasRecent
            : !hasRecent && (await prisma.dailyMetric.count({
                where: { siteId: dbSite.id, url: '', query: '', searchType },
              })) === 0;
          const typeStartStr = needsTypeHistory ? histStartStr : recentStartStr;

          try {
            const res = await withQuotaRetry(hostname, () => wm.searchanalytics.query({
              siteUrl: gscUrl,
              requestBody: {
                startDate:  typeStartStr,
                endDate:    endDateStr,
                dimensions: ['date'],
                searchType,
                rowLimit:   25000,
                dataState:  'all',
              },
            }));

            const rows = res.data.rows ?? [];
            note.push(`${searchType}:${rows.length}d${needsTypeHistory ? '(full)' : ''}`);

            if (searchType === 'web') webOk = true;
            if (rows.length > 0) {
              const rangeStart = new Date(typeStartStr);

              // Delete this type's records for the range in one query, then bulk-insert
              await prisma.dailyMetric.deleteMany({
                where: {
                  siteId:     dbSite.id,
                  url:        '',
                  query:      '',
                  searchType,
                  date:       { gte: rangeStart, lte: endDate },
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
                    searchType,
                    clicks:      row.clicks      ?? 0,
                    impressions: row.impressions ?? 0,
                    ctr:         row.ctr         ?? 0,
                    position:    row.position    ?? 0,
                  })),
              });
              if (searchType === 'web') result.sitesSynced++;
            }
          } catch (err: unknown) {
            const text = errorText(err);
            const kind = classifySyncError(text);
            console.error(`[GSC Sync]     Error syncing ${hostname} (${searchType}): ${text}`);
            if (searchType === 'web') {
              result.siteErrors.push({ site: hostname, error: sanitizeSyncError(text), kind });
            }
          }
        }

        if (webOk) {
          await prisma.site.update({
            where: { id: dbSite.id },
            data: { lastGscSyncAt: new Date() },
          }).catch((err: unknown) => {
            console.error(`[GSC Sync]   Could not store last success for ${hostname}: ${errorText(err)}`);
          });
        }

        // ── Step 3: sync per-URL daily data (Content Decay Map) ─────────────
        // 90 days still drives the query+page summary below; the per-URL daily rows need longer.
        const url90Start = new Date(endDate);
        url90Start.setDate(endDate.getDate() - 90);
        url90Start.setHours(0, 0, 0, 0);
        const url90StartStr = url90Start.toISOString().split('T')[0];

        // Decay compares two 56-day windows and drops the newest 2 provisional days
        // (src/lib/decay/logic.ts), so it needs ~114 days of page rows; 90 left the earlier
        // window a month short and every page's "before" undercounted. Rows older than this
        // window are never deleted, so a long-running instance keeps accumulating history
        // (which is what the 16-month heatmap and the YoY column read).
        const urlDailyStart = new Date(endDate);
        urlDailyStart.setDate(endDate.getDate() - URL_DAILY_DAYS);
        urlDailyStart.setHours(0, 0, 0, 0);
        const urlDailyStartStr = urlDailyStart.toISOString().split('T')[0];

        try {
          // One request returns at most 25,000 rows, and date×page is days × pages: a site with
          // a few hundred pages crosses that easily. It used to be a single request, so the tail
          // — the low-traffic URLs a migration audit is looking for — was dropped silently.
          // Page through with startRow; the cap only exists so a giant property can't monopolise
          // the sync, and hitting it is logged rather than hidden.
          const urlRows: { keys?: string[] | null; clicks?: number | null; impressions?: number | null; ctr?: number | null; position?: number | null }[] = [];
          let capped = false;
          for (let page = 0; ; page++) {
            if (page >= URL_DAILY_MAX_PAGES) { capped = true; break; }
            const urlRes = await withQuotaRetry(hostname, () => wm.searchanalytics.query({
              siteUrl: gscUrl,
              requestBody: {
                startDate:  urlDailyStartStr,
                endDate:    endDateStr,
                dimensions: ['date', 'page'],
                rowLimit:   GSC_ROW_LIMIT,
                startRow:   page * GSC_ROW_LIMIT,
                dataState:  'all',
              },
            }));
            const batch = urlRes.data.rows ?? [];
            urlRows.push(...batch);
            if (batch.length < GSC_ROW_LIMIT) break;
          }
          note.push(`${urlRows.length} url-day${capped ? ` (capped at ${URL_DAILY_MAX_PAGES * GSC_ROW_LIMIT})` : ''}`);
          if (capped) {
            console.warn(`[GSC Sync]     ${hostname}: per-URL daily rows hit the ${URL_DAILY_MAX_PAGES * GSC_ROW_LIMIT}-row cap — the lowest-traffic URL-days are missing.`);
          }

          if (urlRows.length > 0) {
            await prisma.dailyMetric.deleteMany({
              where: {
                siteId: dbSite.id,
                url:    { not: '' },
                query:  '',
                date:   { gte: urlDailyStart, lte: endDate },
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
        } catch (err) {
          console.error(`[GSC Sync]     Error syncing URL data for ${hostname}: ${(err as Error).message}`);
        }

        // ── Step 4: sync per-query+page data (Cannibalization/Striking/CTR) ──
        // No date dimension — returns aggregated totals over the 90-day window.
        // Stored with date=endDate so tools querying date>=since always find it.
        try {
          // Paged like Step 3, for the same reason and with sharper consequences: Search Console
          // returns these rows by clicks, so a single 25k request dropped exactly the
          // impressions-without-clicks tail that Striking Distance exists to find, and the
          // second ranking URL of a query that Cannibalization needs.
          const qpRows: { keys?: string[] | null; clicks?: number | null; impressions?: number | null; ctr?: number | null; position?: number | null }[] = [];
          let qpCapped = false;
          for (let page = 0; ; page++) {
            if (page >= QUERY_PAGE_MAX_PAGES) { qpCapped = true; break; }
            const qpRes = await withQuotaRetry(hostname, () => wm.searchanalytics.query({
              siteUrl: gscUrl,
              requestBody: {
                startDate:  url90StartStr,
                endDate:    endDateStr,
                dimensions: ['query', 'page'],
                rowLimit:   GSC_ROW_LIMIT,
                startRow:   page * GSC_ROW_LIMIT,
                dataState:  'all',
              },
            }));
            const batch = qpRes.data.rows ?? [];
            qpRows.push(...batch);
            if (batch.length < GSC_ROW_LIMIT) break;
          }
          note.push(`${qpRows.length} query+page${qpCapped ? ` (capped at ${QUERY_PAGE_MAX_PAGES * GSC_ROW_LIMIT})` : ''}`);
          if (qpCapped) {
            console.warn(`[GSC Sync]     ${hostname}: query+page rows hit the ${QUERY_PAGE_MAX_PAGES * GSC_ROW_LIMIT}-row cap — the lowest-click pairs are missing.`);
          }

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
        } catch (err) {
          console.error(`[GSC Sync]     Error syncing query+page data for ${hostname}: ${(err as Error).message}`);
        }

        // ── Step 5: per-day query+page rows (Related intent "winner changes") ──
        // Step 4's rows are one 90-day total per pair, so they can't say which page won a query
        // on which day. These can, for the last QUERY_PAGE_DAILY_DAYS. They live in their own
        // table (see QueryPageDaily in the schema) and are replaced wholesale each sync. An
        // instance that hasn't run `prisma db push` yet just logs and carries on — the table is
        // optional, Related intent reports the signal as unavailable.
        try {
          const qpdStart = new Date(endDate);
          qpdStart.setDate(endDate.getDate() - (QUERY_PAGE_DAILY_DAYS - 1));
          qpdStart.setHours(0, 0, 0, 0);
          const qpdStartStr = qpdStart.toISOString().split('T')[0];
          const qpdRows: { keys?: string[] | null; clicks?: number | null; impressions?: number | null; position?: number | null }[] = [];
          let qpdCapped = false;
          for (let page = 0; ; page++) {
            if (page >= QUERY_PAGE_DAILY_MAX_PAGES) { qpdCapped = true; break; }
            const res = await withQuotaRetry(hostname, () => wm.searchanalytics.query({
              siteUrl: gscUrl,
              requestBody: {
                startDate:  qpdStartStr,
                endDate:    endDateStr,
                dimensions: ['date', 'query', 'page'],
                rowLimit:   GSC_ROW_LIMIT,
                startRow:   page * GSC_ROW_LIMIT,
                dataState:  'all',
              },
            }));
            const batch = res.data.rows ?? [];
            qpdRows.push(...batch);
            if (batch.length < GSC_ROW_LIMIT) break;
          }
          note.push(`${qpdRows.length} query+page/day${qpdCapped ? ` (capped)` : ''}`);
          if (qpdRows.length > 0) {
            await prisma.queryPageDaily.deleteMany({ where: { siteId: dbSite.id } });
            await prisma.queryPageDaily.createMany({
              data: qpdRows
                .filter(r => r.keys?.[0] && r.keys?.[1] && r.keys?.[2])
                .map(r => ({
                  siteId:      dbSite.id,
                  date:        new Date(r.keys![0]),
                  query:       r.keys![1],
                  url:         r.keys![2],
                  clicks:      r.clicks      ?? 0,
                  impressions: r.impressions ?? 0,
                  position:    r.position    ?? 0,
                })),
            });
          }
        } catch (err) {
          console.error(`[GSC Sync]     Per-day query+page rows skipped for ${hostname}: ${(err as Error).message}`);
        }

        // ── Step 6: per-day query history (QueryDaily — accumulated, never wiped) ──
        // Each run rewrites only the ranges planQueryHistory() picks: the recent tail (Google
        // revises its freshest days) and a few older 30-day slices walking back to Google's
        // ~16-month floor. Days Google has since dropped stay stored. A missing table
        // (`prisma db push` not run since the update) skips only this step.
        try {
          const [newest, cursorRow] = await Promise.all([
            prisma.queryDaily.findFirst({ where: { siteId: dbSite.id }, orderBy: { date: 'desc' }, select: { date: true } }),
            prisma.site.findUnique({ where: { id: dbSite.id }, select: { queryHistoryFrom: true } }),
          ]);
          const storedDay = (d: Date) => d.toISOString().slice(0, 10); // stored as UTC midnights
          const plan = planQueryHistory({
            endStr: localYmd(endDate),
            newestStr: newest ? storedDay(newest.date) : null,
            historyFromStr: cursorRow?.queryHistoryFrom ? storedDay(cursorRow.queryHistoryFrom) : null,
          });

          const writeRange = async (r: DayRange): Promise<number> => {
            const rows: { keys?: string[] | null; clicks?: number | null; impressions?: number | null; position?: number | null }[] = [];
            for (let page = 0; ; page++) {
              if (page >= QUERY_HISTORY_MAX_PAGES) {
                console.warn(`[GSC Sync]     ${hostname}: query history ${r.start}..${r.end} hit the ${QUERY_HISTORY_MAX_PAGES * GSC_ROW_LIMIT}-row cap — the lowest-traffic query-days are missing.`);
                break;
              }
              const res = await withQuotaRetry(hostname, () => wm.searchanalytics.query({
                siteUrl: gscUrl,
                requestBody: {
                  startDate:  r.start,
                  endDate:    r.end,
                  dimensions: ['date', 'query'],
                  rowLimit:   GSC_ROW_LIMIT,
                  startRow:   page * GSC_ROW_LIMIT,
                  dataState:  'all',
                },
              }));
              const batch = res.data.rows ?? [];
              rows.push(...batch);
              if (batch.length < GSC_ROW_LIMIT) break;
            }
            // Replace exactly this range, atomically: a failed insert must not leave a hole.
            await prisma.$transaction([
              prisma.queryDaily.deleteMany({ where: { siteId: dbSite.id, date: { gte: utcDay(r.start), lte: utcDay(r.end) } } }),
              prisma.queryDaily.createMany({
                data: rows
                  .filter(x => x.keys?.[0] && x.keys?.[1])
                  .map(x => ({
                    siteId:      dbSite.id,
                    date:        utcDay(x.keys![0]),
                    query:       x.keys![1],
                    clicks:      x.clicks      ?? 0,
                    impressions: x.impressions ?? 0,
                    posWeighted: (x.position ?? 0) * (x.impressions ?? 0),
                  })),
              }),
            ]);
            return rows.length;
          };
          const saveCursor = (ymd: string) =>
            prisma.site.update({ where: { id: dbSite.id }, data: { queryHistoryFrom: utcDay(ymd) } });

          let written = await writeRange(plan.tail);
          // The tail is complete from its start; a cursor already further back stays there.
          const known = newest && cursorRow?.queryHistoryFrom ? storedDay(cursorRow.queryHistoryFrom) : null;
          let cursor = known && known < plan.tail.start ? known : plan.tail.start;
          await saveCursor(cursor);
          const pausedUntil = queryHistoryPausedUntil.get(dbSite.id) ?? 0;
          if (Date.now() < pausedUntil) {
            note.push(`${written} query/day (backfill paused — quota)`);
          } else {
            for (const r of plan.backfill) {
              written += await writeRange(r);
              cursor = r.start;
              await saveCursor(cursor);
            }
            queryHistoryPausedUntil.delete(dbSite.id);
            note.push(`${written} query/day (history from ${cursor})`);
          }
        } catch (err) {
          if (isQuotaError(err)) {
            queryHistoryPausedUntil.set(dbSite.id, Date.now() + QUERY_HISTORY_QUOTA_PAUSE_MS);
            console.warn(`[GSC Sync]     ${hostname}: query history over quota — backfill paused for ${QUERY_HISTORY_QUOTA_PAUSE_MS / 3_600_000}h (tail still refreshes)`);
          } else {
            console.error(`[GSC Sync]     Query history skipped for ${hostname}: ${(err as Error).message}`);
          }
        }

        // Reports computed from these rows (cannibalization, …) are cached per site; this
        // site's rows just changed.
        bumpReportCacheVersion();
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
    const text = errorText(e);
    const kind = classifySyncError(text);
    result.accountErrors.push({
      accountId: '*',
      error: sanitizeSyncError(text || 'Sync failed.'),
      needsReauth: kind === 'reauth',
      kind,
    });
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

    // Persist the outcome. A failed run must not move lastCompletedAt — that timestamp is
    // what the button calls "last sync", and stamping a revoked token made it look fresh.
    const summary = summarizeSyncFailure(result);
    const failed = result.accountErrors.length > 0 || result.siteErrors.length > 0;
    await recordSyncFinished(syncedUserIds, {
      when: result.completedAt,
      sitesSynced: result.sitesSynced,
      accountErrors: result.accountErrors.length,
      siteErrors: result.siteErrors.length,
      needsReauth: summary.needsReauth,
      failureKind: failed ? summary.failureKind : null,
      failedSites: result.siteErrors.map(e => e.site),
    }).catch(() => {});
  }

  return result;
}
