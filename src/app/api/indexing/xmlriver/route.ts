import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

// POST { siteDbId: string, urls: string[] }
// Checks each URL's indexation status via XML River API and persists results.
export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { xmlRiverUserId: true, xmlRiverApiKey: true },
  });

  if (!user?.xmlRiverUserId || !user?.xmlRiverApiKey) {
    return NextResponse.json({ error: 'XML River API not configured' }, { status: 400 });
  }

  const body = await req.json();
  const siteDbId: string | undefined = body.siteDbId;
  const urls: string[] = (body.urls ?? []).slice(0, 50);

  if (urls.length === 0) {
    return NextResponse.json({ error: 'No URLs provided' }, { status: 400 });
  }

  let checked = 0;
  let errors = 0;

  for (const url of urls) {
    try {
      const apiUrl = `https://xmlriver.com/search_console/json/?user=${encodeURIComponent(user.xmlRiverUserId)}&key=${encodeURIComponent(user.xmlRiverApiKey)}&url=${encodeURIComponent(url)}`;
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
      const data = await res.json().catch(() => ({}));

      const xrStatus = data?.error
        ? 'error'
        : !!(data?.indexed === true || data?.content?.indexed === true || data?.content?.index === 'yes')
          ? 'indexed'
          : 'not_indexed';

      if (siteDbId) {
        await prisma.sitemapUrl.upsert({
          where: { siteId_url: { siteId: siteDbId, url } },
          create: { siteId: siteDbId, url, xrStatus, xrChecked: new Date() },
          update: { xrStatus, xrChecked: new Date() },
        });
      }

      if (xrStatus === 'error') errors++; else checked++;
      await new Promise(r => setTimeout(r, 300));
    } catch {
      errors++;
    }
  }

  if (siteDbId) {
    await prisma.indexingOperation.create({
      data: {
        siteId: siteDbId,
        type: 'xr_check',
        result: errors > 0 ? 'partial' : 'success',
        detail: `checked: ${checked}, errors: ${errors}`,
        urlCount: checked,
      },
    });
  }

  return NextResponse.json({ ok: true, checked, errors });
}
