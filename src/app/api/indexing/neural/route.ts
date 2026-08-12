import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

const BASE = 'https://inderixingbot.com/api';

// POST { urls: string[], queue?: "slow"|"fast"|"yandex", label?: string }
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
  const urls: string[] = body.urls ?? [];
  const queue: string  = body.queue  ?? 'slow';
  const label: string  = body.label  ?? '';
  const siteDbId: string | undefined = body.siteDbId;  // optional: persist to SitemapUrl

  if (urls.length === 0) {
    return NextResponse.json({ error: 'No URLs provided' }, { status: 400 });
  }

  try {
    const res = await fetch(`${BASE}/v2/submissions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.neuralIndexerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        links: urls,
        queue,
        ...(label ? { label } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error ?? data?.message ?? `HTTP ${res.status}` },
        { status: res.status },
      );
    }

    // Persist submission status to SitemapUrl records if siteDbId provided
    if (siteDbId) {
      const now = new Date();
      await Promise.allSettled(
        urls.map(url =>
          prisma.sitemapUrl.upsert({
            where: { siteId_url: { siteId: siteDbId, url } },
            create: { siteId: siteDbId, url, neuralStatus: 'submitted', neuralAt: now, neuralQueue: queue },
            update: { neuralStatus: 'submitted', neuralAt: now, neuralQueue: queue },
          }),
        ),
      );
      await prisma.indexingOperation.create({
        data: {
          siteId: siteDbId,
          type: 'neural_submit',
          result: 'success',
          detail: `queue: ${queue}`,
          urlCount: urls.length,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      submissionId: data.submission_id,
      accepted: data.total_links_accepted ?? urls.length,
      charged: data.charged_amount ?? null,
      balance: data.balance_usd ?? null,
      wasCached: data.was_cached ?? false,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Request failed' }, { status: 500 });
  }
}

// GET — current balance
export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { neuralIndexerToken: true },
  });

  if (!user?.neuralIndexerToken) {
    return NextResponse.json({ error: 'NeuralIndexer token not configured' }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${BASE}/balance.php?api_key=${encodeURIComponent(user.neuralIndexerToken)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    const data = await res.json().catch(() => ({}));
    return NextResponse.json({
      balance: data?.balance ?? data?.balance_usd ?? null,
      pricePerLink: data?.price_per_link ?? null,
      availableLinks: data?.available_links ?? null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Request failed' }, { status: 500 });
  }
}
