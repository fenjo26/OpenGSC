import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { runSerp, heuristicSiteType, heuristicIntent, SerpEngine } from "@/lib/seo/serp";

// POST /api/seo/serp
// body: { keyword, provider, apiKey, gl?, hl?, location?, num?, engine? }
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const b = await req.json();
  const keyword = String(b.keyword ?? "").trim();
  if (!keyword) return NextResponse.json({ error: "no_keyword" }, { status: 400 });

  const provider = String(b.provider ?? "serper");
  const apiKey = String(b.apiKey ?? "");
  const engine = (b.engine as SerpEngine) ?? "google";

  const serp = await runSerp(provider, apiKey, keyword, {
    gl: b.gl, hl: b.hl, location: b.location, num: b.num ?? 10, engine,
  });

  if (serp.error) {
    return NextResponse.json({ error: serp.error, results: [] }, { status: 502 });
  }

  // Attach cheap heuristic site_type + buy/info intent for the UI.
  const results = serp.results.map((r) => ({
    ...r,
    site_type: heuristicSiteType(r.domain, r.url, r.title),
    intent: heuristicIntent(r.url, r.title),
  }));

  return NextResponse.json({ ...serp, results });
}
