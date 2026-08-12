import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { google } from 'googleapis';

export async function GET() {
  const userId = await workspaceUserId("manageSecrets");
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
  const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

  const accounts = await prisma.account.findMany({
    where: { userId, provider: 'google' },
    select: { id: true, providerAccountId: true, scope: true, expires_at: true, access_token: true, refresh_token: true },
  });

  // For each account: fetch email via Google API + check GSC scope
  const enriched = await Promise.all(
    accounts.map(async (acc: typeof accounts[number]) => {
      // Check scope stored in DB first (fast, no API call needed)
      const gscAccess = acc.scope ? acc.scope.includes(GSC_SCOPE) : false;
      const ga4Access = acc.scope ? acc.scope.includes(GA4_SCOPE) : false;

      try {
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET
        );
        oauth2Client.setCredentials({
          access_token: acc.access_token,
          refresh_token: acc.refresh_token,
        });
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const info = await oauth2.userinfo.get();
        return {
          id: acc.id,
          email: info.data.email || acc.providerAccountId,
          picture: info.data.picture,
          connected: true,
          gscAccess,
          ga4Access,
        };
      } catch {
        return { id: acc.id, email: acc.providerAccountId, picture: null, connected: false, gscAccess, ga4Access };
      }
    })
  );

  return NextResponse.json({ accounts: enriched });
}

export async function DELETE(req: Request) {
  const userId = await workspaceUserId("manageSecrets");
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { accountId } = await req.json();

  await prisma.account.deleteMany({
    where: { id: accountId, userId },
  });

  return NextResponse.json({ success: true });
}
