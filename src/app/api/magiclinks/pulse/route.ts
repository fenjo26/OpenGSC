import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { purchasedPulse } from "@/lib/magiclinks/tracking";

// GET /api/magiclinks/pulse — bought placements per provider: how many are standing (found),
// gone (missing), unverifiable (blocked) and not yet checked. "unchecked" is reported as its own
// state, never folded into missing: a placement nobody has verified is unconfirmed, not lost.
// Empty (not an error) before `prisma db push` or with no imported placements yet.
export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ providers: await purchasedPulse(userId) });
}
