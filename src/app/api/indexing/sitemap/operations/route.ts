import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

// GET /api/indexing/sitemap/operations?siteDbId=...&limit=50
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteDbId = searchParams.get('siteDbId') ?? '';
  const limit = Math.min(200, parseInt(searchParams.get('limit') ?? '50', 10));

  const site = await prisma.site.findFirst({
    where: { id: siteDbId, userId },
    select: { id: true },
  });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  const ops = await prisma.indexingOperation.findMany({
    where: { siteId: siteDbId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, type: true, result: true, detail: true, urlCount: true, createdAt: true },
  });

  return NextResponse.json({ ops });
}
