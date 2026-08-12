import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { runContentSearch } from "@/lib/seo/contentAnalysis";

// POST /api/seo/content-analysis  { keyword, dfsKey, limit? }
// Brand/keyword citations across the web with sentiment (DataForSEO Content Analysis).
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json();
  const keyword = String(b.keyword ?? "").trim();
  const dfsKey = String(b.dfsKey ?? "");
  if (!keyword) return NextResponse.json({ error: "no_keyword" }, { status: 400 });
  if (!dfsKey) return NextResponse.json({ error: "no_dataforseo_key" }, { status: 400 });

  const { total, items, error } = await runContentSearch(dfsKey, keyword, { limit: b.limit });
  if (error) return NextResponse.json({ error, items: [], total: 0 }, { status: 502 });
  return NextResponse.json({ total, items });
}
