import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { readUsage } from "@/lib/seo/metricsStore";

// GET /api/metrics/usage?provider=ahrefs — units spent this month, for the settings screen.
// Read-only and free; the counter is written by the paid routes before they call out.
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const provider = new URL(req.url).searchParams.get("provider") === "semrush" ? "semrush" : "ahrefs";
  return NextResponse.json({ provider, ...(await readUsage(userId, provider)) });
}
