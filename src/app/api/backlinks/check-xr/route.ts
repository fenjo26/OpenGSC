import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

// POST { siteDbId, ids?: string[] }  — checks XML River index status for backlinks
export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const siteDbId: string = body.siteDbId;
  const ids: string[] = body.ids ?? [];

  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { xmlRiverUserId: true, xmlRiverApiKey: true },
  });
  if (!user?.xmlRiverUserId || !user?.xmlRiverApiKey)
    return NextResponse.json({ error: 'XML River not configured' }, { status: 400 });

  const where: any = { siteId: siteDbId };
  if (ids.length > 0) where.id = { in: ids };

  const links = await prisma.backlink.findMany({ where, take: 200, select: { id: true, url: true } });
  if (links.length === 0) return NextResponse.json({ ok: true, checked: 0 });

  let checked = 0;

  for (const link of links) {
    try {
      const apiUrl = `https://xmlriver.com/search_console/json/?user=${encodeURIComponent(user.xmlRiverUserId)}&key=${encodeURIComponent(user.xmlRiverApiKey)}&url=${encodeURIComponent(link.url)}`;
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(8000) });
      const data = await res.json().catch(() => ({}));
      const xrStatus = data?.error ? 'error' : data?.indexed ? 'indexed' : 'not_indexed';
      await prisma.backlink.update({
        where: { id: link.id },
        data: { xrStatus, xrChecked: new Date() },
      });
      checked++;
      await new Promise(r => setTimeout(r, 300));
    } catch {}
  }

  await prisma.indexingOperation.create({
    data: {
      siteId: siteDbId,
      type: 'backlink_check_xr',
      result: 'success',
      detail: `checked: ${checked}`,
      urlCount: checked,
    },
  });

  return NextResponse.json({ ok: true, checked });
}
