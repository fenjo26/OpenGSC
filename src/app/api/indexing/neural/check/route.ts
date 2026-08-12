import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

const BASE = 'https://inderixingbot.com/api';

// POST { siteDbId: string, urls: string[] }
// 1. Schedules an index check via check-index-task.php (api_key in JSON body)
// 2. Polls GET /api/v2/checks/{id} until completed (up to ~30s)
// 3. Persists results to SitemapUrl
export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { neuralIndexerToken: true },
  });

  if (!user?.neuralIndexerToken) {
    return NextResponse.json({ error: 'NeuralIndexer token not configured' }, { status: 400 });
  }

  const body = await req.json();
  const siteDbId: string | undefined = body.siteDbId;
  const urls: string[] = (body.urls ?? []).slice(0, 500);

  if (urls.length === 0) {
    return NextResponse.json({ error: 'No URLs provided' }, { status: 400 });
  }

  const token = user.neuralIndexerToken;

  try {
    // Step 1: Schedule the check — api_key goes in JSON body, not query string
    const schedRes = await fetch(`${BASE}/check-index-task.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: token, links: urls }),
      signal: AbortSignal.timeout(15000),
    });

    const schedData = await schedRes.json().catch(() => ({}));

    // DEBUG: log full response so we can see the actual shape
    console.log('[neural/check] schedule response HTTP', schedRes.status, JSON.stringify(schedData));

    if (!schedRes.ok || schedData?.error) {
      return NextResponse.json(
        { error: schedData?.error ?? schedData?.message ?? `HTTP ${schedRes.status}`, debug: schedData },
        { status: schedRes.ok ? 400 : schedRes.status },
      );
    }

    // Response contains check_id like "m456"
    const checkId: string | undefined = schedData?.check_id ?? schedData?.id ?? schedData?.task_id;

    if (!checkId) {
      // Some accounts get sync results directly (no check_id)
      const results: Array<{ url: string; indexed: boolean }> = schedData?.results ?? schedData?.links ?? [];
      return NextResponse.json({
        ok: true,
        results,
        checked: results.length,
        indexed: results.filter(r => r.indexed).length,
        balance: schedData?.balance_usd ?? null,
        raw: schedData,
      });
    }

    // Step 2: Return checkId immediately — client polls /api/indexing/neural/status
    const actualCheckId: string = schedData?.check_id ?? `m${checkId}`;
    console.log('[neural/check] task created', actualCheckId, 'for', urls.length, 'urls');

    return NextResponse.json({
      ok: true,
      pending: true,
      checkId: actualCheckId,
      siteDbId,
      urlCount: urls.length,
      estimatedMinutes: schedData?.estimated_wait_minutes ?? 2,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Request failed' }, { status: 500 });
  }
}
