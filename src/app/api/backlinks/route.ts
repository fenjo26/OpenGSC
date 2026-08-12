import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

// GET /api/backlinks?siteDbId=...
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteDbId = searchParams.get('siteDbId') ?? '';

  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  const links = await prisma.backlink.findMany({
    where: { siteId: siteDbId },
    orderBy: { addedAt: 'desc' },
    select: {
      id: true, url: true, title: true, isAlive: true, aliveStatus: true, aliveChecked: true,
      xrStatus: true, xrChecked: true, twoIndexStatus: true, twoIndexAt: true, addedAt: true,
    },
  });

  const total = links.length;
  // aliveStatus is the richer field; fall back to isAlive for rows written before this column
  // existed, so legacy data still reads correctly without a backfill migration.
  const status = (l: any): 'alive' | 'dead' | 'blocked' | 'unknown' =>
    l.aliveStatus === 'alive' || l.aliveStatus === 'dead' || l.aliveStatus === 'blocked'
      ? l.aliveStatus
      : l.isAlive === true ? 'alive' : l.isAlive === false ? 'dead' : 'unknown';
  const alive = links.filter((l: any) => status(l) === 'alive').length;
  const dead  = links.filter((l: any) => status(l) === 'dead').length;
  const blocked = links.filter((l: any) => status(l) === 'blocked').length;
  const xrIndexed = links.filter((l: any) => l.xrStatus === 'indexed').length;

  return NextResponse.json({ links, stats: { total, alive, dead, blocked, xrIndexed } });
}

// POST /api/backlinks — { siteDbId, urls: string[] }
export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const siteDbId: string = body.siteDbId;
  const urls: string[] = (body.urls ?? []).filter((u: string) => u.startsWith('http'));

  if (!siteDbId || urls.length === 0)
    return NextResponse.json({ error: 'siteDbId and urls required' }, { status: 400 });

  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  const unique = [...new Set(urls)].slice(0, 5000);

  await prisma.$transaction(
    unique.map(url =>
      prisma.backlink.upsert({
        where: { siteId_url: { siteId: siteDbId, url } },
        create: { siteId: siteDbId, url },
        update: {},
      }),
    ),
    { timeout: 30000 },
  );

  return NextResponse.json({ ok: true, added: unique.length });
}

// DELETE /api/backlinks — { siteDbId, ids: string[] }
export async function DELETE(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const siteDbId: string = body.siteDbId;
  const ids: string[] = body.ids ?? [];

  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  await prisma.backlink.deleteMany({ where: { id: { in: ids }, siteId: siteDbId } });
  return NextResponse.json({ ok: true });
}
