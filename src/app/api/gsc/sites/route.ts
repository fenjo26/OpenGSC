import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { google } from 'googleapis';

async function fetchSitesForAccount(account: {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
}) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.expires_at ? account.expires_at * 1000 : undefined,
  });

  // Auto-save refreshed tokens back to DB
  oauth2Client.on('tokens', async (tokens) => {
    await prisma.account.update({
      where: { id: account.id },
      data: {
        access_token: tokens.access_token ?? account.access_token,
        refresh_token: tokens.refresh_token ?? account.refresh_token,
        expires_at: tokens.expiry_date
          ? Math.floor(tokens.expiry_date / 1000)
          : account.expires_at,
      },
    });
  });

  const webmasters = google.webmasters({ version: 'v3', auth: oauth2Client });
  const response = await webmasters.sites.list();
  return response.data.siteEntry || [];
}

export async function GET() {
  const userId = await workspaceUserId();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Fetch ALL linked Google accounts for the admin user ──────────────────
  const googleAccounts = await prisma.account.findMany({
    where: {
      userId,
      provider: 'google',
    },
    select: {
      id: true,
      access_token: true,
      refresh_token: true,
      expires_at: true,
    },
  });

  if (googleAccounts.length === 0) {
    // Return DB sites even if no accounts connected yet
    const dbSites = await prisma.site.findMany({ where: { userId } });
    return NextResponse.json({ sites: dbSites, connected_accounts: 0 });
  }

  // ── Process all accounts in parallel ─────────────────────────────────────
  const errors: string[] = [];
  const allSiteEntries: Array<{ siteUrl: string; accountId: string }> = [];

  await Promise.allSettled(
    googleAccounts.map(async (account: Parameters<typeof fetchSitesForAccount>[0]) => {
      try {
        const entries = await fetchSitesForAccount(account);
        entries.forEach((e) => {
          if (e.siteUrl) allSiteEntries.push({ siteUrl: e.siteUrl, accountId: account.id });
        });
      } catch (err: any) {
        errors.push(`Account ${account.id}: ${err.message}`);
      }
    })
  );

  // ── Upsert all sites into DB ──────────────────────────────────────────────
  for (const { siteUrl } of allSiteEntries) {
    // sc-domain:example.com → example.com
    // https://example.com/  → example.com
    let cleanUrl = siteUrl;
    if (cleanUrl.startsWith('sc-domain:')) {
      cleanUrl = cleanUrl.slice('sc-domain:'.length);
    } else {
      try { cleanUrl = new URL(cleanUrl).hostname; } catch {}
    }
    cleanUrl = cleanUrl.replace(/^www\./, ''); // strip www

    await prisma.site.upsert({
      where: {
        userId_siteId: {
          userId,
          siteId: siteUrl,
        },
      },
      update: {},
      create: {
        userId,
        url: cleanUrl,
        siteId: siteUrl,
        tags: '',
      },
    });
  }

  // ── Reconcile the archive against what Google actually returned ───────────
  // Properties removed from Search Console used to linger on the dashboard forever,
  // because this route only ever upserted. They are now flagged instead of deleted,
  // so all history (metrics, audits, keywords) survives and can still be inspected.
  //
  // Guards — never archive on a partial or failed read. If Google is down, or one
  // account's token expired, the missing properties are missing because of us, not
  // because the user removed them, and archiving would blank the whole dashboard:
  //   • every linked account must have answered without error
  //   • the response must be non-empty
  let archived = 0;
  let restored = 0;
  if (errors.length === 0 && allSiteEntries.length > 0) {
    const liveSiteIds = new Set(allSiteEntries.map((e) => e.siteUrl));
    const known = await prisma.site.findMany({
      where: { userId },
      select: { id: true, siteId: true, archivedAt: true },
    });

    // Both directions are diffed in memory and written as at most two updateMany
    // calls. Doing it in the upsert loop above would mean a write per site on every
    // dashboard load — a few hundred pointless writes for an account this size.
    const toArchive = known.filter(s => !s.archivedAt && !liveSiteIds.has(s.siteId)).map(s => s.id);
    const toRestore = known.filter(s =>  s.archivedAt &&  liveSiteIds.has(s.siteId)).map(s => s.id);

    if (toArchive.length > 0) {
      archived = (await prisma.site.updateMany({
        where: { id: { in: toArchive } },
        data: { archivedAt: new Date() },
      })).count;
    }
    // A property can come back — re-verified, or the same domain added again.
    if (toRestore.length > 0) {
      restored = (await prisma.site.updateMany({
        where: { id: { in: toRestore } },
        data: { archivedAt: null },
      })).count;
    }
  }

  const userSites = await prisma.site.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json({
    sites: userSites,
    connected_accounts: googleAccounts.length,
    archived_now: archived,
    restored_now: restored,
    errors: errors.length > 0 ? errors : undefined,
  });
}

// ── Archive / restore / permanently delete a single site ────────────────────
// PATCH  { id, archived: boolean }  → move a site in or out of the archive by hand
// DELETE ?id=<site.id>              → hard delete (cascades all of the site's data)

export async function PATCH(req: Request) {
    const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const id = body?.id as string | undefined;
  const archived = body?.archived;
  if (!id || typeof archived !== 'boolean') {
    return NextResponse.json({ error: 'id and archived are required' }, { status: 400 });
  }

  const res = await prisma.site.updateMany({
    where: { id, userId },
    data: { archivedAt: archived ? new Date() : null },
  });
  if (res.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ ok: true, id, archived });
}

export async function DELETE(req: Request) {
    const userId = await workspaceUserId("manageInstance");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  // Scoped by userId so one user can never delete another's site.
  // Every child table declares onDelete: Cascade, so metrics, audits,
  // keywords, backlinks and Clarity snapshots go with it.
  const res = await prisma.site.deleteMany({ where: { id, userId } });
  if (res.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ ok: true, id });
}
