import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

// POST /api/ga4/link  { domain, propertyId, propertyName }
// Links a GA4 property to a site.
export async function POST(req: Request) {
  const userId = await workspaceUserId("manageSecrets");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const domain = String(body.domain ?? '').trim();
  const propertyId = String(body.propertyId ?? '').trim();
  const propertyName = String(body.propertyName ?? '').trim();

  if (!domain || !propertyId) {
    return NextResponse.json({ error: 'domain and propertyId required' }, { status: 400 });
  }

  const site = await prisma.site.findFirst({ where: { userId, url: domain } });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  await prisma.site.update({
    where: { id: site.id },
    data: { ga4PropertyId: propertyId, ga4PropertyName: propertyName || null },
  });

  return NextResponse.json({ ok: true });
}

// DELETE /api/ga4/link?domain=...  — unlinks the GA4 property.
export async function DELETE(req: Request) {
  const userId = await workspaceUserId("manageSecrets");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const domain = (searchParams.get('domain') ?? '').trim();
  if (!domain) return NextResponse.json({ error: 'domain required' }, { status: 400 });

  const site = await prisma.site.findFirst({ where: { userId, url: domain } });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  await prisma.site.update({
    where: { id: site.id },
    data: { ga4PropertyId: null, ga4PropertyName: null },
  });

  return NextResponse.json({ ok: true });
}
