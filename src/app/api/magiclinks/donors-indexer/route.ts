import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { queuePurchasedDonors } from "@/lib/magiclinks/toIndexer";

// POST — queue PURCHASED donor pages into the private indexer network (/indexer): the doorways
// will serve links to them for the crawlers to discover. Free (our own domains), the same
// IndexerQueue the /indexer page feeds by hand.
//
// Body { all: true } queues every purchased donor NOT PROVEN indexed — the zero-extra-steps
// path that works before any xr pass has run. The default stays xr-gated: only donors the xr
// pass PROVED out of the index, longest-out first. Selection lives in lib/magiclinks/toIndexer.

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let all = false;
  try { all = !!(await req.json())?.all; } catch { /* no body = xr-gated default */ }

  const r = await queuePurchasedDonors(userId, { all });
  if (!r.ok) {
    const status = r.reason === "no_indexer_domains" ? 400 : r.reason === "not_migrated" ? 503 : 404;
    const message = r.reason === "no_indexer_domains" ? "Add doorway domains in /indexer first." : undefined;
    return NextResponse.json({ error: r.reason, ...(message ? { message } : {}) }, { status });
  }
  return NextResponse.json({ ok: true, queued: r.queued, candidates: r.candidates, domains: r.domains, capped: r.capped, skippedIndexed: r.skippedIndexed });
}
