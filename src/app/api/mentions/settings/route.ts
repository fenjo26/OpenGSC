import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getMentionSettings, mentionsSchemaMissing, saveMentionSettings } from "@/lib/mentions/store";
import { kickMentionsScheduler } from "@/lib/mentions/scheduler";
import type { MentionSettings } from "@/lib/mentions/types";

// GET/PUT /api/mentions/settings?siteId= (CONTRACT §4: read/act). Saving with on=true kicks
// the scheduler, so a fresh opt-in gets its first (silent, backfilling) run immediately.

async function siteIdOf(req: Request, body?: Record<string, unknown>): Promise<string> {
  const fromQuery = new URL(req.url).searchParams.get("siteId");
  return String(fromQuery || body?.siteId || "");
}

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const siteId = await siteIdOf(req);
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });

  try {
    return NextResponse.json(await getMentionSettings(userId, siteId));
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (mentionsSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "mentions_settings_failed" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const siteId = await siteIdOf(req, body);
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });
  if (!body?.settings || typeof body.settings !== "object") {
    return NextResponse.json({ error: "settings_required" }, { status: 400 });
  }

  try {
    await saveMentionSettings(userId, siteId, body.settings as MentionSettings);
    if ((body.settings as MentionSettings).on) kickMentionsScheduler();
    return NextResponse.json(await getMentionSettings(userId, siteId));
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (mentionsSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "mentions_settings_failed" }, { status: 500 });
  }
}
