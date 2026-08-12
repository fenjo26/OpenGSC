import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { getAlgoUpdates } from "@/lib/algoUpdatesServer";

// GET /api/gsc/algo-updates — Google's list of ranking updates, for the site chart markers.
//
// Proxied rather than fetched from the browser because status.search.google.com sends no CORS
// headers, so a client-side request is blocked outright. The list, the cache and the fallback all
// live in lib/algoUpdatesServer.ts, shared with the Annotations tab.

export async function GET() {
  // Session-gated because everything under /api/gsc is, not because the data is sensitive: it is
  // a public feed.
  const workspaceId = await workspaceUserId();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json(await getAlgoUpdates());
}
