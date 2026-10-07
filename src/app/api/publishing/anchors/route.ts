import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { siteAnchorSummary } from "@/lib/publish/store";

export const dynamic = "force-dynamic";

// GET /api/publishing/anchors?siteId=… → the anchor-distribution panel on /publishing:
// anchor → how many of this site's own published posts link the money site with that exact
// anchor → which target URLs, with the repeated-exact-anchor flag. Local read over stored
// rows only — the same pure aggregation the pre-publish review runs on a planned batch.
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") ?? "";
  if (!siteId) return NextResponse.json({ error: "siteId required" }, { status: 400 });
  try {
    return NextResponse.json(await siteAnchorSummary(userId, siteId));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: message === "site_not_found" ? 404 : 400 });
  }
}
