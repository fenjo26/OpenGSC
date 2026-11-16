import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { searxngStatus } from "@/lib/seo/searxng";

export const dynamic = "force-dynamic";

// GET /api/seo/serp/searxng/status
//
// A real search, not a socket check: "connected" must mean the instance answered JSON with
// results. Read capability only — nothing here spends money or changes configuration.
export async function GET() {
  const workspaceId = await workspaceUserId("read");
  if (!workspaceId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const status = await searxngStatus();
  return NextResponse.json(status, { status: 200 });
}
