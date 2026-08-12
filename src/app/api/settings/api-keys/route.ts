import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';

const mask = (s: string | null | undefined) =>
  s ? s.slice(0, 4) + '••••' + s.slice(-4) : null;

// GET — return current key status (masked)
export async function GET() {
  const userId = await workspaceUserId("manageSecrets");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      neuralIndexerToken: true,
      xmlRiverUserId: true,
      xmlRiverApiKey: true,
      twoIndexToken: true,
    },
  });

  // Fetch NeuralIndexer balance if token is set
  let neuralBalance: number | null = null;
  if (user?.neuralIndexerToken) {
    try {
      const res = await fetch(
        `https://inderixingbot.com/api/balance.php?api_key=${encodeURIComponent(user.neuralIndexerToken)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const d = await res.json();
      if (typeof d?.balance === 'number') neuralBalance = d.balance;
      else if (typeof d?.balance_usd === 'number') neuralBalance = d.balance_usd;
    } catch {}
  }

  return NextResponse.json({
    neuralIndexer: {
      configured: !!user?.neuralIndexerToken,
      token: mask(user?.neuralIndexerToken),
      balance: neuralBalance,
    },
    xmlRiver: {
      configured: !!(user?.xmlRiverUserId && user?.xmlRiverApiKey),
      userId: user?.xmlRiverUserId ?? null,
      apiKey: mask(user?.xmlRiverApiKey),
    },
    twoIndex: {
      configured: !!user?.twoIndexToken,
      token: mask(user?.twoIndexToken),
    },
  });
}

// POST — save keys
export async function POST(req: Request) {
  const userId = await workspaceUserId("manageSecrets");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const data: Record<string, string | null> = {};

  if ('neuralIndexerToken' in body) data.neuralIndexerToken = body.neuralIndexerToken || null;
  if ('xmlRiverUserId'     in body) data.xmlRiverUserId     = body.xmlRiverUserId     || null;
  if ('xmlRiverApiKey'     in body) data.xmlRiverApiKey     = body.xmlRiverApiKey     || null;
  if ('twoIndexToken'      in body) data.twoIndexToken      = body.twoIndexToken      || null;

  await prisma.user.update({ where: { id: userId }, data });

  return NextResponse.json({ ok: true });
}
