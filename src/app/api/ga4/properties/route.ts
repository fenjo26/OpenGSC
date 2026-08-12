import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { google } from 'googleapis';
import { makeOAuth2, type GoogleAccount } from '@/lib/ga4';

export type GA4Property = {
  id: string;          // numeric property id, e.g. "123456789"
  name: string;        // property display name
  account: string;     // owning GA4 account display name
};

export type GA4AccountInfo = {
  email: string;       // the connected Google login
  count: number;       // GA4 properties found via this account
  error?: string;      // Admin API error, if any
};

// GET /api/ga4/properties
// Lists every GA4 property visible across ALL linked Google accounts, plus a
// per-account breakdown so the user can see what each account contributed.
export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const accounts = (await prisma.account.findMany({
    where: { userId, provider: 'google' },
    select: { id: true, providerAccountId: true, access_token: true, refresh_token: true, expires_at: true },
  })) as (GoogleAccount & { providerAccountId: string })[];

  if (accounts.length === 0) {
    return NextResponse.json({ properties: [], connected_accounts: 0, accountsInfo: [] });
  }

  const byId = new Map<string, GA4Property>();
  const accountsInfo: GA4AccountInfo[] = [];

  await Promise.allSettled(
    accounts.map(async (account) => {
      const oauth2 = makeOAuth2(account);

      // Resolve a friendly email label for this account (best-effort).
      let email = account.providerAccountId;
      try {
        const info = await google.oauth2({ version: 'v2', auth: oauth2 }).userinfo.get();
        if (info.data.email) email = info.data.email;
      } catch { /* keep providerAccountId */ }

      let count = 0;
      try {
        const admin = google.analyticsadmin({ version: 'v1beta', auth: oauth2 });
        let pageToken: string | undefined;
        do {
          const res = await admin.accountSummaries.list({ pageSize: 200, pageToken });
          for (const acc of res.data.accountSummaries ?? []) {
            for (const prop of acc.propertySummaries ?? []) {
              const id = (prop.property ?? '').split('/')[1];
              if (!id) continue;
              count++;
              if (!byId.has(id)) {
                byId.set(id, {
                  id,
                  name: prop.displayName ?? `Property ${id}`,
                  account: acc.displayName ?? '',
                });
              }
            }
          }
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);
        accountsInfo.push({ email, count });
      } catch (err: any) {
        accountsInfo.push({ email, count: 0, error: err?.message ?? 'error' });
      }
    })
  );

  const properties = Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  accountsInfo.sort((a, b) => a.email.localeCompare(b.email));
  const errors = accountsInfo.filter(a => a.error).map(a => `${a.email}: ${a.error}`);

  return NextResponse.json({
    properties,
    connected_accounts: accounts.length,
    accountsInfo,
    errors: errors.length ? errors : undefined,
  });
}
