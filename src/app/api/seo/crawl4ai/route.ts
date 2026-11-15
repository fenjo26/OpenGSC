import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { crawl4aiConfig } from "@/lib/seo/scrape";

// GET /api/seo/crawl4ai — status of the self-hosted Crawl4AI scraping service.
// The service is env-configured on the server (CRAWL4AI_URL / CRAWL4AI_TOKEN in .env);
// this route only reports what the server itself can reach, nothing is sent anywhere.
// body: none -> { configured, healthy?, version?, error? }
export async function GET() {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cfg = crawl4aiConfig();
  if (!cfg) return NextResponse.json({ configured: false });

  try {
    const res = await fetch(`${cfg.baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return NextResponse.json({ configured: true, healthy: false, error: `HTTP ${res.status}` });
    }
    const data = await res.json();
    return NextResponse.json({ configured: true, healthy: true, version: data?.version ?? "" });
  } catch (e) {
    return NextResponse.json({
      configured: true,
      healthy: false,
      error: (e as Error)?.message ?? "unreachable",
    });
  }
}
