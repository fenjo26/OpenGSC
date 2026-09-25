import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { listReviews, localSchemaMissing } from "@/lib/local/store";

// GET /api/local/gbp/reviews?siteId= (read) — the STORED reviews of a site, as the 6-hour sync
// left them. Live fetching is POST …/reviews/sync (act); this route never leaves the server.

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const siteId = new URL(req.url).searchParams.get("siteId") ?? "";
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });
  try {
    const reviews = await listReviews(userId, siteId);
    return NextResponse.json({ reviews });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] GBP reviews load failed:", error);
    return NextResponse.json({ error: "reviews_load_failed" }, { status: 500 });
  }
}
