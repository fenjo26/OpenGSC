import { NextResponse } from 'next/server';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { inspectUrls } from '@/lib/indexing/inspect';
import { indexingTablesMissing, quotaToday } from '@/lib/indexing/quota';
import { INSPECTION_DAILY_LIMIT } from '@/lib/indexing/types';

// POST { siteDbId: string, urls: string[] }
// The MANUAL Google URL Inspection button: specific URLs the user picked, no dailyBudget cap.
// Since T4 the actual API loop lives in src/lib/indexing/inspect.ts (account fallback, pacing,
// provider log, quota ledger); this route keeps its old response contract — { ok, checked,
// errors } plus the hint codes the Indexing tab translates — and adds one fast failure: when
// Google already answered 429 for this property today, we say so immediately instead of making
// up to 200 calls that each come back 429.

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

  try {
    // Fail fast on an exhausted quota day (reset at midnight America/Los_Angeles).
    const quota = await quotaToday(site.siteId);
    if (quota.exhausted) {
      return NextResponse.json({
        ok: false, checked: 0, errors: urls.length,
        hint: 'api_error',
        detail: `Google URL Inspection quota exhausted for this property (${quota.used}/${INSPECTION_DAILY_LIMIT} today) — resets at midnight Pacific time.`,
      }, { status: 200 });
    }

    const limited = urls.filter(u => typeof u === 'string' && u.startsWith('http')).slice(0, 200);
    if (!limited.length) return NextResponse.json({ error: 'siteDbId and urls required' }, { status: 400 });

    const outcomes = await inspectUrls(userId, siteDbId, limited, { auto: false });
    const okCount = outcomes.filter(o => o.ok).length;
    const failed = outcomes.filter(o => !o.ok);
    const firstError = failed.find(o => o.error)?.error ?? null;

    // The Indexing tab (page.tsx) translates these exact hint codes.
    let hint: string | undefined;
    let detail: string | undefined;
    if (firstError === 'no_google_account') {
      return NextResponse.json({ error: 'No Google account connected' }, { status: 400 });
    } else if (firstError === 'quota_exhausted') {
      hint = 'api_error';
      detail = 'Google URL Inspection quota exhausted — resets at midnight Pacific time.';
    } else if (firstError === 'property_not_verified' || firstError === 'sc_domain_not_supported') {
      hint = 'property_not_verified';
    } else if (firstError) {
      hint = 'api_error';
      detail = firstError;
    }

    await prisma.indexingOperation.create({
      data: {
        siteId: siteDbId,
        type: 'google_check',
        result: failed.length > 0 ? 'partial' : 'success',
        detail: `checked: ${okCount}, errors: ${failed.length}`,
        urlCount: okCount,
      },
    });

    return NextResponse.json({ ok: okCount > 0, checked: okCount, errors: failed.length, ...(hint ? { hint, ...(detail ? { detail } : {}) } : {}) });
  } catch (e) {
    if (indexingTablesMissing(e)) {
      return NextResponse.json({
        ok: false, checked: 0, errors: urls.length,
        hint: 'api_error',
        detail: 'Run `npx prisma db push` — the index-check tables are missing.',
      }, { status: 200 });
    }
    throw e;
  }
}
