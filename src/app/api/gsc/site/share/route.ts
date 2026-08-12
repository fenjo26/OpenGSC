import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { getOwnerEngineKey } from '@/lib/engineKeysServer';
import crypto from 'crypto';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get('siteId') ?? '';
  const shareToken = searchParams.get('shareToken') ?? '';
  if (!siteId) return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });

  if (shareToken) {
    const site = await prisma.site.findFirst({
      where: { id: siteId, shareToken, shareEnabled: true },
      select: { id: true, url: true, shareEnabled: true },
    });
    if (!site) return NextResponse.json({ error: 'Invalid share token' }, { status: 403 });
    // Full site (need userId to resolve the owner's engine keys server-side).
    const full = await prisma.site.findFirst({ where: { id: siteId, shareToken, shareEnabled: true }, select: { id: true, url: true, userId: true } });
    const engines = full
      ? { bing: !!(await getOwnerEngineKey(full.userId, "bing", full.id)), yandex: !!(await getOwnerEngineKey(full.userId, "yandex", full.id)) }
      : { bing: false, yandex: false };
    return NextResponse.json({
      shareEnabled: site.shareEnabled,
      domain: site.url,
      engines,
    });
  }

  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  return NextResponse.json({
    shareEnabled: site.shareEnabled,
    shareToken: site.shareToken,
    domain: site.url,
  });
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { siteId, action, shareEnabled } = body;
  if (!siteId) return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });

  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  let data: any = {};
  if (shareEnabled !== undefined) {
    data.shareEnabled = !!shareEnabled;
  }

  if (action === 'generate') {
    data.shareToken = crypto.randomBytes(16).toString('hex');
    data.shareEnabled = true;
  } else if (action === 'revoke') {
    data.shareToken = null;
    data.shareEnabled = false;
  }

  const updated = await prisma.site.update({
    where: { id: siteId },
    data,
  });

  return NextResponse.json({
    shareEnabled: updated.shareEnabled,
    shareToken: updated.shareToken,
  });
}
