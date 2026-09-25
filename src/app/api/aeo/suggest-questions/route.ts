import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { suggestQuestions } from "@/lib/visibility/store";

// GET /api/aeo/suggest-questions?siteId=…&limit=…
// Question-shaped queries from the site's own GSC data (last 28 days), minus what is already
// tracked. Reads DailyMetric locally — free, no quota spent.
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") || "";
  const limit = parseInt(searchParams.get("limit") || "20", 10) || 20;

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  return NextResponse.json({ items: await suggestQuestions(userId, siteId, limit) });
}
