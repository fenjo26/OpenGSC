import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

// Use 'any' cast until `npx prisma generate` is run after the schema update
const tc = () => (prisma as any).topicCluster;

function cuid(): string {
  return 'c' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

// GET /api/gsc/clusters?siteId=
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get('siteId') ?? '';

  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const clusters = await tc().findMany({ where: { siteId }, orderBy: { createdAt: 'asc' } });
  return NextResponse.json({ clusters });
}

// POST /api/gsc/clusters — bulk replace all clusters for a site
// Body: { siteId: string, clusters: {name: string, rules: string}[] }
export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { siteId, clusters }: { siteId: string; clusters: { name: string; rules: string }[] } = body;

  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await tc().deleteMany({ where: { siteId } });

  const created = await Promise.all(
    clusters.map((c: { name: string; rules: string }) =>
      tc().create({ data: { id: cuid(), siteId, name: c.name, rules: c.rules, createdAt: new Date() } })
    )
  );

  return NextResponse.json({ clusters: created });
}

// DELETE /api/gsc/clusters?id=
export async function DELETE(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id') ?? '';

  const cluster = await tc().findUnique({ where: { id }, include: { site: true } });
  if (!cluster || cluster.site.userId !== userId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await tc().delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
