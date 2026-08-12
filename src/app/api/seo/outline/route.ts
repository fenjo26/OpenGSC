import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { genOutline } from "@/lib/seo/generate";

// POST /api/seo/outline — synchronous outline generation (also available as a background job).
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json();
  const r = await genOutline(b);
  if (!r.ok) {
    const status = r.error === "no_keyword" || r.error === "no_ai_key" ? 400 : 502;
    return NextResponse.json({ error: r.error }, { status });
  }
  return NextResponse.json({ outline: r.data });
}
