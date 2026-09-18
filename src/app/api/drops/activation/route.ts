import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { schemaMissing } from "@/lib/drops/store";
import { getAsset, listAssets } from "@/lib/drops/activationStore";

/**
 * The activation tab's read side. Two shapes, one route:
 *   GET /api/drops/activation            → { assets: AssetSummary[] }
 *   GET /api/drops/activation?domain=…   → the getAsset detail (urls, donors, placements)
 *
 * "act" (not "read"): the tab this feeds is an operator surface — a viewer share link has
 * no business listing the indexer network's donor targets. The [domain]/* write routes use
 * the same capability, so one session sees one consistent permission story.
 */
export async function GET(req: Request) {
  try {
    const userId = await workspaceUserId("act");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const domain = new URL(req.url).searchParams.get("domain");
    if (domain) {
      const detail = await getAsset(userId, domain.trim());
      if (!detail) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
      return NextResponse.json(detail);
    }

    const assets = await listAssets(userId);
    return NextResponse.json({ assets });
  } catch (e) {
    if (schemaMissing(e)) {
      return NextResponse.json({ error: "schema_missing" }, { status: 503 });
    }
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
