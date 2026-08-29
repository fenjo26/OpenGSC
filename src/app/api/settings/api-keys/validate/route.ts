import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { loggedFetch } from '@/lib/providerLog/log';

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
      // NeuralIndexer bills for checks, not for being asked how much is left, so a row per
      // key validation would file spending against a request that spends nothing.
      const res = await fetch( // providerLog-exempt: balance read, not a billed action
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
      // Unlike its two neighbours this is not a balance read: it runs a real index query against
      // google.com to see whether the credentials work, and an account that is charged per query
      // is charged for this one. Logged for that reason.
      const { res, call } = await loggedFetch(url, { signal: AbortSignal.timeout(8000) }, { provider: 'xmlriver' });
      const data = await res.json();
      if (data?.error) {
        call.finish({ error: String(data.error).slice(0, 300), responseBody: data });
        return NextResponse.json({ ok: false, error: data.error });
      }
      call.finish({ responseBody: data });
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
      // A balance read, like the NeuralIndexer branch above. The submit action this token pays
      // for is logged; asking what is left is not an action.
      const res = await fetch('https://2index.ninja/api/v1/balance', { // providerLog-exempt: balance read
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
