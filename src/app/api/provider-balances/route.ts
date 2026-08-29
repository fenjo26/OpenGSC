import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getProviderBalances, refreshProviderBalances } from "@/lib/providerBalances";

// Provider balance cache (balances page + the balance_low alert's data source).
// GET  → cached rows as-is: fresh, stale, and failed checks alike.
// POST → refresh every configured provider's row from its live endpoint. Balance endpoints
//        are free but rate-limited, so this is on-demand (button / cron), never on page load.

export async function GET() {
  const userId = await workspaceUserId("read");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ balances: await getProviderBalances(userId) });
}

export async function POST() {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const results = await refreshProviderBalances(userId);
  return NextResponse.json({ ok: true, refreshed: results.length, balances: await getProviderBalances(userId) });
}
