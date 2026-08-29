import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { loggedFetch } from '@/lib/providerLog/log';

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
    const { res: pollRes, call } = await loggedFetch(`${BASE}/v2/checks/${checkId}?results_per_page=1000`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    }, { provider: 'neuralindexer' });

    if (!pollRes.ok) {
      call.finish({ error: `NeuralIndexer HTTP ${pollRes.status}` });
      return NextResponse.json({ error: `NeuralIndexer HTTP ${pollRes.status}` }, { status: 502 });
    }

    const pollData = await pollRes.json().catch(() => ({}));
    const checkStatus: string = pollData?.check?.status ?? '';
    const isReady: boolean = pollData?.check?.ready === true;

    if (checkStatus === 'failed' || checkStatus === 'error') {
      call.finish({ error: `check ${checkStatus}` });
      return NextResponse.json({ done: false, failed: true, status: checkStatus });
    }

    if (!isReady && checkStatus !== 'completed') {
      call.finish();
      return NextResponse.json({
        done: false,
        status: checkStatus,
        checkedLinks: pollData?.check?.checked_links ?? 0,
        totalLinks: pollData?.check?.total_links ?? 0,
      });
    }

    // Completed — and `charged_usd` stays off this row.
    //
    // It is NeuralIndexer's own statement of what the CHECK cost, and the check was bought by the
    // scheduling request in neural/check. This poll bought nothing; it is only the request in
    // which the provider finally says the number, which it does exactly once, on the poll that
    // reports completion. Filing it here because this is where it was read puts a real figure on
    // a request that was never priced, and every one of the earlier polls for the same check
    // reads as free beside it — so any per-row sum over this provider comes out of a column that
    // no longer means "what this request cost", which is the one thing costUsd is for.
    //
    // Putting it on the row it belongs to needs the scheduling row to still be addressable when
    // this poll lands, minutes and one HTTP request later: the check id stored against that row
    // and looked up here. That is a schema change and a separate one — it is not invented in
    // passing on a poll route. Until then the charge is reported to the caller below, where it
    // has always been, and the log records a poll that cost nothing, which is true.
    call.finish();

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
