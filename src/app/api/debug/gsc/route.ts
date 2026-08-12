import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { google } from 'googleapis';

export async function GET() {
    const workspaceId = await workspaceUserId("manageSecrets");
  if (!workspaceId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results: any[] = [];

  const accounts = await prisma.account.findMany({
    where: { provider: 'google' },
    include: { user: { select: { id: true, email: true } } },
  });

  for (const account of accounts) {
    const info: any = {
      accountId:        account.id,
      providerAccountId: account.providerAccountId,
      userId:           account.user.id,
      userEmail:        account.user.email,
      hasAccessToken:   !!account.access_token,
      hasRefreshToken:  !!account.refresh_token,
      tokenExpiresAt:   account.expires_at
        ? new Date(account.expires_at * 1000).toISOString()
        : null,
      tokenExpired:     account.expires_at
        ? account.expires_at * 1000 < Date.now()
        : null,
      steps: [] as any[],
    };

    // Step 1: try to get user email via OAuth2
    try {
      const oauth2 = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      );
      oauth2.setCredentials({
        access_token:  account.access_token,
        refresh_token: account.refresh_token,
        expiry_date:   account.expires_at ? account.expires_at * 1000 : undefined,
      });

      // Attempt token refresh first
      let refreshed = false;
      try {
        const { credentials } = await oauth2.refreshAccessToken();
        oauth2.setCredentials(credentials);
        refreshed = true;
        info.steps.push({ step: 'token_refresh', status: 'ok', newExpiry: credentials.expiry_date });

        // Save refreshed token
        await prisma.account.update({
          where: { id: account.id },
          data: {
            access_token: credentials.access_token ?? account.access_token,
            refresh_token: credentials.refresh_token ?? account.refresh_token,
            expires_at: credentials.expiry_date
              ? Math.floor(credentials.expiry_date / 1000)
              : account.expires_at,
          },
        });
      } catch (e: any) {
        info.steps.push({ step: 'token_refresh', status: 'failed', error: e.message });
      }

      // Step 2: get account email
      try {
        const o2 = google.oauth2({ version: 'v2', auth: oauth2 });
        const me = await o2.userinfo.get();
        info.googleEmail   = me.data.email;
        info.googleName    = me.data.name;
        info.steps.push({ step: 'userinfo', status: 'ok', email: me.data.email });
      } catch (e: any) {
        info.steps.push({ step: 'userinfo', status: 'failed', error: e.message });
      }

      // Step 3: list GSC sites
      try {
        const wm = google.webmasters({ version: 'v3', auth: oauth2 });
        const res = await wm.sites.list();
        const sites = res.data.siteEntry ?? [];
        info.gscSiteCount = sites.length;
        info.gscSites = sites.map(s => ({
          siteUrl:         s.siteUrl,
          permissionLevel: s.permissionLevel,
        }));
        info.steps.push({ step: 'list_gsc_sites', status: 'ok', count: sites.length });

        // Step 4: check which sites are already in DB
        const inDb: string[] = [];
        const notInDb: string[] = [];
        for (const s of sites) {
          if (!s.siteUrl) continue;
          const found = await prisma.site.findFirst({
            where: {
              OR: [
                { siteId: s.siteUrl },
                { url: s.siteUrl.replace('sc-domain:', '').replace(/^www\./, '') },
              ],
            },
          });
          if (found) inDb.push(s.siteUrl);
          else notInDb.push(s.siteUrl);
        }
        info.sitesInDb    = inDb.length;
        info.sitesNotInDb = notInDb;
        info.steps.push({ step: 'db_check', inDb: inDb.length, notInDb: notInDb.length });

        // Step 5: try a sample searchanalytics query
        if (sites.length > 0 && sites[0].siteUrl) {
          const testSite = sites[0].siteUrl;
          const end = new Date(); end.setDate(end.getDate() - 2);
          const start = new Date(end); start.setDate(end.getDate() - 7);
          try {
            const qres = await wm.searchanalytics.query({
              siteUrl: testSite,
              requestBody: {
                startDate:  start.toISOString().split('T')[0],
                endDate:    end.toISOString().split('T')[0],
                dimensions: ['date'],
                rowLimit:   5,
                dataState:  'all',
              },
            });
            const rows = qres.data.rows ?? [];
            info.steps.push({
              step:     'sample_query',
              status:   'ok',
              site:     testSite,
              rowCount: rows.length,
              sample:   rows.slice(0, 2),
            });
          } catch (e: any) {
            info.steps.push({ step: 'sample_query', status: 'failed', site: testSite, error: e.message });
          }
        }

      } catch (e: any) {
        info.gscSiteCount = 0;
        info.gscSites = [];
        info.steps.push({ step: 'list_gsc_sites', status: 'failed', error: e.message });
      }

    } catch (e: any) {
      info.steps.push({ step: 'oauth2_init', status: 'failed', error: e.message });
    }

    results.push(info);
  }

  // Summary
  const summary = {
    totalAccounts: accounts.length,
    totalDbSites:  await prisma.site.count(),
    totalMetrics:  await prisma.dailyMetric.count(),
  };

  return NextResponse.json({ summary, accounts: results }, { status: 200 });
}
