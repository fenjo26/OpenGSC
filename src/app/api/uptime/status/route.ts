import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getUptimeSettings, uptimeBadges, uptimeSchemaMissing } from "@/lib/uptime/store";

// GET /api/uptime/status — every monitor's badge for the dashboard, in one request.
// `notifyDegraded` rides along because the dashboard's "Needs attention" group includes slow
// sites only for workspaces that asked to be alerted about them (CONTRACT §4 shape is
// `{ badges }`; this extra key is additive and ignored by readers that don't know it).
export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const [badges, settings] = await Promise.all([uptimeBadges(userId), getUptimeSettings(userId)]);
    return NextResponse.json({ badges, notifyDegraded: settings.notifyDegraded });
  } catch (e) {
    if (uptimeSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    console.warn("[uptime] status failed:", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
