import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { listLocations } from "@/lib/local/gbp";

// GET /api/local/gbp/locations?account=accounts/123 (read, net) — locations of one GBP account,
// for the profile's account/location pickers. Free (the Business Profile API has no per-call
// price); pre-approval it answers with the classified gbp_access_required instead of a 500.

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const account = new URL(req.url).searchParams.get("account") ?? "";
  if (!account) return NextResponse.json({ error: "account_required" }, { status: 400 });

  const res = await listLocations(userId, account);
  if (!res.ok) return NextResponse.json({ error: res.error, message: res.message ?? null });
  return NextResponse.json({ locations: res.data ?? [] });
}
