import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

function cuid(): string {
  return 'c' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

// GET /api/gsc/groups?siteId=
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get('siteId') ?? '';

  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const groups = await prisma.contentGroup.findMany({
    where: { siteId },
    orderBy: { createdAt: 'asc' },
  });
  return NextResponse.json({ groups });
}

// POST /api/gsc/groups — bulk replace all groups for a site
// Body: { siteId: string, groups: {name: string, rules: string}[] }
export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { siteId, groups }: { siteId: string; groups: { name: string; rules: string }[] } = body;

  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Delete existing groups for this site
  await prisma.contentGroup.deleteMany({ where: { siteId } });

  // Create new ones
  const created = await Promise.all(
    groups.map(g =>
      prisma.contentGroup.create({
        data: { id: cuid(), siteId, name: g.name, rules: g.rules, createdAt: new Date() },
      })
    )
  );

  return NextResponse.json({ groups: created });
}

// DELETE /api/gsc/groups?id=
export async function DELETE(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id') ?? '';

  const group = await prisma.contentGroup.findUnique({ where: { id }, include: { site: true } });
  if (!group || group.site.userId !== userId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.contentGroup.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
