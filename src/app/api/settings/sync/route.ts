import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import type { Capability } from "@/lib/team/roles";
import { getSyncSchedule, saveSyncSchedule, normalise, isDue } from "@/lib/syncSchedule";

// Automatic GSC sync schedule (Settings → System).
// GET  → { settings, due }   — `due` is what the scheduler would decide at this moment
// POST → { settings } save
//
// The schedule is stored per user but the sync it starts is instance-wide; see the note at the
// top of src/lib/syncScheduler.ts.

async function uid(capability: Capability = "read"): Promise<string | null> {
return workspaceUserId(capability);
}

export async function GET() {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const settings = await getSyncSchedule(userId);
  return NextResponse.json({ settings, due: isDue(settings, new Date()) });
}

export async function POST(req: Request) {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const current = await getSyncSchedule(userId);
  const settings = normalise(body?.settings ?? {}, current);

  // Switching the schedule on in the afternoon should not start a full sync on the spot.
  //
  // The scheduler deliberately catches up on a window it missed — that is what keeps a restart
  // at nine o'clock from costing a whole day of freshness. But a schedule that has never run has
  // no window to have missed, so on the very first save the same rule reads "9am was hours ago,
  // go" and a twenty-minute run starts because someone ticked a checkbox. Recording today as
  // already handled makes the first run happen at the hour that was actually asked for.
  if (settings.enabled && !settings.lastRunAt && isDue(settings, new Date())) {
    settings.lastRunAt = new Date().toISOString();
  }

  try {
    await saveSyncSchedule(userId, settings);
    return NextResponse.json({ ok: true, settings });
  } catch {
    // The column is added by `prisma db push`; until then saying so beats a blank 500.
    return NextResponse.json({ error: "not_migrated" }, { status: 500 });
  }
}
