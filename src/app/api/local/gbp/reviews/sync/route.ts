import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { syncGbpReviews } from "@/lib/local/gbp";
import { localSchemaMissing } from "@/lib/local/store";

// POST /api/local/gbp/reviews/sync { siteId } (act, net) — fetch reviews now instead of waiting
// for the 6-hour scheduler pass. Free; pre-approval the API answers gbp_access_required, which
// is returned as data (CONTRACT.md §0.4), not a 500.

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { siteId?: string };
  const siteId = String(body?.siteId ?? "");
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });

  try {
    const result = await syncGbpReviews(userId, siteId, { notify: true });
    if (!result.ok) return NextResponse.json({ error: result.error ?? "gbp_error", message: result.message ?? null });
    return NextResponse.json({ ok: true, inserted: result.inserted, updated: result.updated, notified: result.notified });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] GBP reviews sync failed:", error);
    return NextResponse.json({ error: "reviews_sync_failed" }, { status: 500 });
  }
}
