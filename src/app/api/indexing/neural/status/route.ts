import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

const BASE = 'https://inderixingbot.com/api';

// GET /api/indexing/neural/status?checkId=m11522&siteDbId=...
// Polls NeuralIndexer for a specific check task. When done, saves results to DB.
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const checkId = searchParams.get('checkId') ?? '';
  const siteDbId = searchParams.get('siteDbId') ?? '';

  if (!checkId) return NextResponse.json({ error: 'checkId required' }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { neuralIndexerToken: true },
  });
  if (!user?.neuralIndexerToken) {
    return NextResponse.json({ error: 'Token not configured' }, { status: 400 });
  }

  const token = user.neuralIndexerToken;

  try {
    const pollRes = await fetch(`${BASE}/v2/checks/${checkId}?results_per_page=1000`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!pollRes.ok) {
      return NextResponse.json({ error: `NeuralIndexer HTTP ${pollRes.status}` }, { status: 502 });
    }

    const pollData = await pollRes.json().catch(() => ({}));
    const checkStatus: string = pollData?.check?.status ?? '';
    const isReady: boolean = pollData?.check?.ready === true;

    if (checkStatus === 'failed' || checkStatus === 'error') {
      return NextResponse.json({ done: false, failed: true, status: checkStatus });
    }

    if (!isReady && checkStatus !== 'completed') {
      return NextResponse.json({
        done: false,
        status: checkStatus,
        checkedLinks: pollData?.check?.checked_links ?? 0,
        totalLinks: pollData?.check?.total_links ?? 0,
      });
    }

    // Completed — save results to DB
    const raw: Array<{ url?: string; is_indexed?: boolean }> =
      pollData?.check?.results ?? pollData?.results ?? [];

    console.log('[neural/status] completed', checkId, 'results=', raw.length);

    if (siteDbId && raw.length > 0) {
      const now = new Date();
      await Promise.allSettled(
        raw.map(r =>
          prisma.sitemapUrl.upsert({
            where: { siteId_url: { siteId: siteDbId, url: r.url ?? '' } },
            create: {
              siteId: siteDbId,
              url: r.url ?? '',
              neuralStatus: r.is_indexed ? 'indexed' : 'not_indexed',
              neuralAt: now,
            },
            update: {
              neuralStatus: r.is_indexed ? 'indexed' : 'not_indexed',
              neuralAt: now,
            },
          }),
        ),
      );

      const indexed = raw.filter(r => r.is_indexed).length;
      await prisma.indexingOperation.create({
        data: {
          siteId: siteDbId,
          type: 'xr_check',
          result: 'success',
          detail: `neural check ${checkId}: ${indexed}/${raw.length} indexed`,
          urlCount: raw.length,
        },
      });
    }

    return NextResponse.json({
      done: true,
      checked: raw.length,
      indexed: raw.filter(r => r.is_indexed).length,
      notIndexed: raw.filter(r => !r.is_indexed).length,
      charged: pollData?.check?.charged_usd ?? null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Failed' }, { status: 500 });
  }
}
