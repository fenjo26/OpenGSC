import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { queuePurchasedDonors } from "@/lib/magiclinks/toIndexer";

// POST /api/magiclinks/orders/[id]/indexer — one order's published donor pages into the private
// indexer queue. No xr gate: a just-delivered placement is exactly what you want crawlers to
// discover now; donors already PROVEN indexed are skipped and reported. Shares the selection
// layer with the global donors-indexer route and the MCP tool (lib/magiclinks/toIndexer).

export const dynamic = "force-dynamic";

export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const r = await queuePurchasedDonors(userId, { orderId: id });
  if (!r.ok) {
    const status = r.reason === "no_indexer_domains" ? 400 : r.reason === "not_migrated" ? 503 : 404;
    const message = r.reason === "no_indexer_domains" ? "Add doorway domains in /indexer first." : undefined;
    return NextResponse.json({ error: r.reason, ...(message ? { message } : {}) }, { status });
  }
  return NextResponse.json({ ok: true, queued: r.queued, candidates: r.candidates, domains: r.domains, skippedIndexed: r.skippedIndexed });
}
