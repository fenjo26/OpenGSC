import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { sovForSite, sovSchemaMissing } from "@/lib/visibility/store";

// GET /api/aeo/sov?siteId=…&days=7|30|90
// Share-of-voice report + cited-domain rating, aggregated from stored AeoCheck rows. Free by
// construction: no AI call runs here, which is the whole point of the sub-tab.
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") || "";
  const days = parseInt(searchParams.get("days") || "30", 10) || 30;

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  try {
    const r = await sovForSite(userId, siteId, days);
    if (!r) return NextResponse.json({ error: "Site not found" }, { status: 404 });
    return NextResponse.json(r);
  } catch (e) {
    // The report itself reads tables that predate the wave; only the competitor column is new.
    if (sovSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    throw e;
  }
}
