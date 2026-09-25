import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { checkMonitorNow } from "@/lib/uptime/scheduler";
import { UptimeInputError, uptimeSchemaMissing } from "@/lib/uptime/store";

// POST /api/uptime/[siteId]/check — the Health tab's "Check now": one manual check through the
// same lifecycle as a scheduled one (state machine, incident, alerts). Free — it is one HTTP
// GET from this server to the monitored URL.
export async function POST(_req: Request, ctx: { params: Promise<{ siteId: string }> }) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { siteId } = await ctx.params;
  try {
    const result = await checkMonitorNow(userId, siteId);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof UptimeInputError) {
      const status = e.code === "no_monitor" ? 404 : 400;
      return NextResponse.json({ error: e.code }, { status });
    }
    if (uptimeSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    console.warn("[uptime] manual check failed:", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
