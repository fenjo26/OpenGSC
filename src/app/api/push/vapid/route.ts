import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getVapidKeys } from "@/lib/push";

// GET /api/push/vapid (CONTRACT.md §4, read) — the PUBLIC VAPID key the browser needs to
// subscribe (applicationServerKey). Generated on first use and kept in InstanceSetting, or
// taken from env; the private half is never part of any response.
export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const keys = await getVapidKeys();
  if (!keys) return NextResponse.json({ notMigrated: true });
  return NextResponse.json({ publicKey: keys.publicKey });
}
