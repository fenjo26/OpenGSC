import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { scrapeStructure } from "@/lib/seo/scrape";

// POST /api/seo/structure — Landing-flow "under my page" import (fast, HTML-based).
// body: { url, firecrawlKey? } -> { ok, title, nodes: [{level,text,words}], totalWords, error? }
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const b = await req.json();
  const url = String(b.url ?? "").trim();
  if (!url) return NextResponse.json({ error: "no_url" }, { status: 400 });

  const firecrawlKey = b.firecrawlKey ? String(b.firecrawlKey) : undefined;
  const result = await scrapeStructure(url, firecrawlKey);
  if (!result.ok) return NextResponse.json({ error: result.error || "structure_failed" }, { status: 502 });

  return NextResponse.json(result);
}
