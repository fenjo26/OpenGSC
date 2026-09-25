import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getUptimeSettings, saveUptimeSettings, UptimeInputError, uptimeSchemaMissing } from "@/lib/uptime/store";
import type { UptimeWorkspaceSettings } from "@/lib/uptime/types";

// GET·PUT /api/uptime/settings — the workspace-wide uptime settings (Settings page card).
export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await getUptimeSettings(userId));
  } catch (e) {
    if (uptimeSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    console.warn("[uptime] settings read failed:", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const current = await getUptimeSettings(userId).catch(() => null);
  try {
    // A partial PUT merges over the stored settings (or the defaults when none are stored),
    // so a client sending one field cannot wipe the rest.
    const base: UptimeWorkspaceSettings = current ?? {
      autoEnroll: true, defaultIntervalMin: 5, reminderHours: 6, heartbeatUrl: "", notifyDegraded: false,
    };
    await saveUptimeSettings(userId, { ...base, ...body });
    return NextResponse.json(await getUptimeSettings(userId));
  } catch (e) {
    if (e instanceof UptimeInputError) return NextResponse.json({ error: e.code }, { status: 400 });
    if (uptimeSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    console.warn("[uptime] settings save failed:", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
