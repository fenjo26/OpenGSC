import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { testChannel } from "@/lib/notify/channels";
import type { NotifyChannelId } from "@/lib/notify/types";

// POST /api/settings/notify-channels/test → NotifyDelivery (CONTRACT.md §4).
// The delivery itself reports success/failure — a failing test is a 200 with ok:false + error,
// so the UI can show which notifyChErr_* key to render. Permission as on the parent route
// (/api/settings/slack): manageSecrets, owner-only.
const CHANNEL_IDS: NotifyChannelId[] = ["telegram", "slack", "discord", "teams", "email", "webhook"];

export async function POST(req: Request) {
  const userId = await workspaceUserId("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const id = String(b.id ?? "");
  if (!CHANNEL_IDS.includes(id as NotifyChannelId)) {
    return NextResponse.json({ error: "unknown_channel" }, { status: 400 });
  }
  return NextResponse.json(await testChannel(userId, id as NotifyChannelId));
}
