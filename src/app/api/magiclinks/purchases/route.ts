import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { workspaceUserId } from "@/lib/team/workspace";
import { listPurchases, listUserPurchases, summarize, purchaseOrderEvents } from "@/lib/magiclinks/purchases";

// GET /api/magiclinks/purchases?siteId=… — the striking-distance table's memory.
//
// `summaries` marks every "query + URL" pair already bought, so the same pair is not paid for
// a second time by accident. `markers` is the same ledger folded one-event-per-order: the
// traffic chart and the annotations timeline draw these, and the before/after figures come
// from the annotations route's own DailyMetric read — purchases derived there, never stored.
//
// siteId=all serves the portfolio-wide striking report: summaries across every site of the
// workspace (pairs are keyed by query + full URL, which is unique per site anyway), while
// markers stay per-site — a portfolio chart does not exist.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const siteId = new URL(req.url).searchParams.get("siteId") || "";
  if (!siteId) return NextResponse.json({ error: "no_site" }, { status: 400 });

  if (siteId === "all") {
    const rows = await listUserPurchases(userId, 2000);
    return NextResponse.json({ summaries: summarize(rows), markers: [] });
  }

  const owned = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!owned) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const rows = await listPurchases(siteId);
  const events = await purchaseOrderEvents(siteId);
  return NextResponse.json({
    summaries: summarize(rows),
    markers: events.map(e => ({
      orderId: e.orderId,
      provider: e.provider,
      date: e.dayUtc,
      quantity: e.quantity,
      targetCount: e.targetUrls.length,
      queries: e.queries.slice(0, 3),
    })),
  });
}
