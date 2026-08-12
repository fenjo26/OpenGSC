import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { genAnalysis } from "@/lib/seo/generate";

// POST /api/seo/analysis — synchronous content analysis (also available as a background job).
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json();
  const r = await genAnalysis(b);
  if (!r.ok) {
    const status = r.error === "no_keyword" || r.error === "no_target_page" || r.error === "no_ai_key" ? 400 : 502;
    return NextResponse.json({ error: r.error === "parse_failed" ? "parse_failed" : r.error }, { status });
  }
  return NextResponse.json({ report: r.data });
}
