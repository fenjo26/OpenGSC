import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { gbpRedirectUri, gbpStatus, reqOrigin } from "@/lib/local/gbp";

// GET /api/local/gbp/status (read) — everything the GBP tab renders in one call. With a stored
// token this makes ONE free accounts.list request, because quota-0 (CONTRACT.md §0.4) is only
// visible by trying — its classified failure is the state `gbp_access_required`, never a 500.
// The redirect URI rides along so the card can show what to register in Google Cloud.

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const status = await gbpStatus(userId);
  return NextResponse.json({ ...status, redirectUri: gbpRedirectUri(reqOrigin(req)) });
}
