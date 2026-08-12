import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

// POST { siteDbId: string, urls: string[] }
// Runs Google URL Inspection for each URL and persists results
export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const siteDbId: string = body.siteDbId;
  const urls: string[] = body.urls ?? [];
  if (!siteDbId || urls.length === 0)
    return NextResponse.json({ error: 'siteDbId and urls required' }, { status: 400 });

  const site = await prisma.site.findFirst({
    where: { id: siteDbId, userId },
    select: { siteId: true },
  });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  // Get a Google OAuth access token from the user's account
  const account = await prisma.account.findFirst({
    where: { userId, provider: 'google' },
    select: { id: true, access_token: true, refresh_token: true, expires_at: true },
  });
  if (!account?.access_token)
    return NextResponse.json({ error: 'No Google account connected' }, { status: 400 });

  // Refresh the access token if it's expired (expires_at is in seconds)
  let accessToken = account.access_token;
  const nowSec = Math.floor(Date.now() / 1000);
  if (account.expires_at && account.expires_at < nowSec + 60) {
    if (!account.refresh_token) {
      return NextResponse.json({ error: 'Access token expired and no refresh token available. Please reconnect your Google account.' }, { status: 401 });
    }
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: account.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    if (!tokenRes.ok) {
      return NextResponse.json({ error: 'Failed to refresh Google access token. Please reconnect your Google account.' }, { status: 401 });
    }
    const tokenData = await tokenRes.json();
    accessToken = tokenData.access_token;
    await prisma.account.update({
      where: { id: account.id },
      data: {
        access_token: tokenData.access_token,
        expires_at: Math.floor(Date.now() / 1000) + (tokenData.expires_in ?? 3600),
      },
    });
  }

  let checked = 0;
  let errors = 0;
  const GSC_API = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

  // URL Inspection API does not support sc-domain: properties.
  // Convert to https:// URL-prefix format as a fallback.
  const rawSiteId = site.siteId;
  const isDomainProperty = rawSiteId.startsWith('sc-domain:');
  let siteUrl = rawSiteId;
  if (isDomainProperty) {
    siteUrl = 'https://' + rawSiteId.slice('sc-domain:'.length) + '/';
  }

  // Probe with 1 URL first to detect permission errors before looping all URLs
  const probeRes = await fetch(GSC_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inspectionUrl: urls[0], siteUrl }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);

  if (probeRes && !probeRes.ok) {
    const probeBody = await probeRes.json().catch(() => ({}));
    const googleMsg: string = probeBody?.error?.message ?? '';
    const isOwnershipError = probeRes.status === 403 &&
      (googleMsg.includes('do not own') || googleMsg.includes('not part of this property'));

    if (isOwnershipError) {
      const hint = isDomainProperty
        ? 'sc-domain_not_supported'
        : 'property_not_verified';
      return NextResponse.json({ ok: false, checked: 0, errors: urls.length, hint }, { status: 200 });
    }

    return NextResponse.json({
      ok: false, checked: 0, errors: urls.length,
      hint: 'api_error',
      detail: `HTTP ${probeRes.status}: ${googleMsg}`,
    }, { status: 200 });
  }

  for (const url of urls.slice(0, 200)) {
    try {
      const res = await fetch(GSC_API, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inspectionUrl: url, siteUrl }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) { errors++; continue; }

      const data = await res.json();
      const result = data?.inspectionResult;
      const indexStatus = result?.indexStatusResult;

      await prisma.sitemapUrl.upsert({
        where: { siteId_url: { siteId: siteDbId, url } },
        create: {
          siteId: siteDbId,
          url,
          googleStatus: indexStatus?.verdict ?? null,
          googleCoverage: indexStatus?.coverageState ?? null,
          googleReason: indexStatus?.indexingState ?? null,
          googleChecked: new Date(),
        },
        update: {
          googleStatus: indexStatus?.verdict ?? null,
          googleCoverage: indexStatus?.coverageState ?? null,
          googleReason: indexStatus?.indexingState ?? null,
          googleChecked: new Date(),
        },
      });
      checked++;

      // Small delay to avoid hitting rate limits (2000/day)
      await new Promise(r => setTimeout(r, 300));
    } catch {
      errors++;
    }
  }

  await prisma.indexingOperation.create({
    data: {
      siteId: siteDbId,
      type: 'google_check',
      result: errors > 0 ? 'partial' : 'success',
      detail: `checked: ${checked}, errors: ${errors}`,
      urlCount: checked,
    },
  });

  return NextResponse.json({ ok: true, checked, errors });
}
