import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";

// POST { service: "neural" | "xmlriver" | "2index", ...fields }
export async function POST(req: Request) {
  const userId = await workspaceUserId("manageSecrets");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const service: 'neural' | 'xmlriver' | '2index' = body.service;

  // ── NeuralIndexer ───────────────────────────────────────────────────────────
  if (service === 'neural') {
    const token = body.token?.trim();
    if (!token) return NextResponse.json({ ok: false, error: 'Token is required' });

    try {
      const res = await fetch(
        `https://inderixingbot.com/api/balance.php?api_key=${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (res.status === 401 || res.status === 403) {
        return NextResponse.json({ ok: false, error: 'Invalid API token' });
      }
      if (!res.ok) {
        return NextResponse.json({ ok: false, error: `HTTP ${res.status}` });
      }
      const data = await res.json().catch(() => ({}));
      // API returns { balance, price_per_link, available_links } or similar
      const balance = data?.balance ?? data?.balance_usd ?? null;
      if (data?.error) return NextResponse.json({ ok: false, error: data.error });
      return NextResponse.json({ ok: true, balance });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message ?? 'Request failed' });
    }
  }

  // ── XML River ───────────────────────────────────────────────────────────────
  if (service === 'xmlriver') {
    const uid = body.userId?.trim();
    const key = body.apiKey?.trim();
    if (!uid || !key) {
      return NextResponse.json({ ok: false, error: 'User ID and API Key are required' });
    }
    try {
      const testUrl = 'https://www.google.com/';
      const url = `https://xmlriver.com/search_console/json/?user=${encodeURIComponent(uid)}&key=${encodeURIComponent(key)}&url=${encodeURIComponent(testUrl)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      if (data?.error) return NextResponse.json({ ok: false, error: data.error });
      return NextResponse.json({ ok: true });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message ?? 'Request failed' });
    }
  }

  // ── 2index.ninja ────────────────────────────────────────────────────────────
  if (service === '2index') {
    const token = body.token?.trim();
    if (!token) return NextResponse.json({ ok: false, error: 'Bearer token is required' });
    try {
      const res = await fetch('https://2index.ninja/api/v1/balance', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401 || res.status === 403) {
        return NextResponse.json({ ok: false, error: 'Invalid token' });
      }
      if (!res.ok) return NextResponse.json({ ok: false, error: `HTTP ${res.status}` });
      const data = await res.json().catch(() => ({}));
      return NextResponse.json({ ok: true, balance: data?.balance ?? null });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message ?? 'Request failed' });
    }
  }

  return NextResponse.json({ ok: false, error: 'Unknown service' });
}
