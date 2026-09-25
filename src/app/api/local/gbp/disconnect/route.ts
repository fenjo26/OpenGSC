import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { gbpDisconnect } from "@/lib/local/gbp";

// POST /api/local/gbp/disconnect (act) — drop the stored OAuth tokens. The per-site selections
// (LocalProfile.gbpAccount/gbpLocation) stay; they are inert until someone connects again.

export async function POST() {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await gbpDisconnect(userId);
  return NextResponse.json({ ok: true });
}
