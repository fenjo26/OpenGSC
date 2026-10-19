// Shared Google Search Console query helpers for server routes/libs that need
// filtered Search Analytics data (e.g. Rank Tracker: per-keyword GSC series).
// Same account-fallback pattern as /api/gsc/site.

import { google, type webmasters_v3 } from 'googleapis';
import { prisma } from '@/lib/prisma';
import { classifyGscFailure, type GscFailure } from '@/lib/gsc/gscFailure';

export type GscAccount = {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
};

export async function getUserGoogleAccounts(userId: string): Promise<GscAccount[]> {
  return prisma.account.findMany({
    where: { userId, provider: 'google' },
    select: { id: true, access_token: true, refresh_token: true, expires_at: true },
  });
}

export function makeOAuth2(account: GscAccount) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.expires_at ? account.expires_at * 1000 : undefined,
  });
  oauth2.on('tokens', async (tokens) => {
    await prisma.account.update({
      where: { id: account.id },
      data: {
        access_token: tokens.access_token ?? account.access_token,
        refresh_token: tokens.refresh_token ?? account.refresh_token,
        expires_at: tokens.expiry_date ? Math.floor(tokens.expiry_date / 1000) : account.expires_at,
      },
    });
  });
  return oauth2;
}

export interface GscQueryOpts {
  startDate: string;
  endDate: string;
  dimensions: string[];
  rowLimit?: number;
  // e.g. [{ dimension: 'query', operator: 'equals', expression: 'buy shoes' }]
  filters?: { dimension: string; operator: string; expression: string }[];
}

/** One Search Analytics row as Google returns it (keys, clicks, impressions, ctr, position). */
export type GscRow = webmasters_v3.Schema$ApiDataRow;

export interface GscStatusResult<T> {
  rows: T[];
  /** Why every linked account failed — null when Google answered. "quota" outranks
   *  "unreachable": it is transient, and it is the one the UI must explain (issue #38). */
  failure: GscFailure | null;
}

// T defaults to the real row type: without the default every untyped caller (queryGsc,
// queryGscStrict) got `unknown[]` after the #38 refactor and stopped type-checking.
async function queryGscOnce<T = GscRow>(accounts: GscAccount[], siteUrl: string, opts: GscQueryOpts): Promise<GscStatusResult<T>> {
  let failure: GscFailure | null = null;
  for (const account of accounts) {
    try {
      const oauth2 = makeOAuth2(account);
      const wm = google.webmasters({ version: 'v3', auth: oauth2 });
      const res = await wm.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate: opts.startDate,
          endDate: opts.endDate,
          dimensions: opts.dimensions,
          rowLimit: opts.rowLimit ?? 250,
          dataState: 'all',
          ...(opts.filters?.length
            ? { dimensionFilterGroups: [{ filters: opts.filters }] }
            : {}),
        },
      });
      return { rows: (res.data.rows ?? []) as T[], failure: null };
    } catch (err) {
      const f = classifyGscFailure(err);
      if (failure !== "quota") failure = f;
    }
  }
  return { rows: [] as T[], failure };
}

// Try each linked account until one successfully queries GSC for the given siteUrl.
export async function queryGsc(accounts: GscAccount[], siteUrl: string, opts: GscQueryOpts) {
  return (await queryGscOnce(accounts, siteUrl, opts)).rows;
}

/** The account-fallback loop with the failure reason attached (see GscStatusResult). */
export async function queryGscWithStatus<T = GscRow>(accounts: GscAccount[], siteUrl: string, opts: GscQueryOpts) {
  return queryGscOnce<T>(accounts, siteUrl, opts);
}

/** Like queryGsc, but tells "Google answered with no rows" ([]) apart from "no linked account
 *  could query this property" (null). Callers that would otherwise fall back to a different
 *  data source — or show a misleading zero — need that distinction (issue #27). */
export async function queryGscStrict(accounts: GscAccount[], siteUrl: string, opts: GscQueryOpts) {
  const r = await queryGscOnce(accounts, siteUrl, opts);
  return r.failure ? null : r.rows;
}

export function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}
