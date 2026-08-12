import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

// POST { urls: string[] }
// Submits each URL to 2index.ninja using the user's saved Bearer token.
export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoIndexToken: true },
  });

  if (!user?.twoIndexToken) {
    return NextResponse.json({ error: '2index.ninja token not configured' }, { status: 400 });
  }

  const body = await req.json();
  const urls: string[] = (body.urls ?? []).slice(0, 50); // max 50 per call

  if (urls.length === 0) {
    return NextResponse.json({ error: 'No URLs provided' }, { status: 400 });
  }

  const results: Array<{ url: string; ok: boolean; error?: string }> = [];

  for (const url of urls) {
    try {
      const res = await fetch('https://2index.ninja/api/v1/submit', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.twoIndexToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        results.push({ url, ok: true });
      } else {
        const err = await res.json().catch(() => ({}));
        results.push({ url, ok: false, error: err?.message ?? `HTTP ${res.status}` });
      }
    } catch (e: any) {
      results.push({ url, ok: false, error: e?.message ?? 'Request failed' });
    }
  }

  const submitted = results.filter(r => r.ok).length;
  return NextResponse.json({ results, submitted, total: urls.length });
}
