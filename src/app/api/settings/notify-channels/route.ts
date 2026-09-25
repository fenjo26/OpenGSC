import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { channelViews, saveChannel, saveChannelEvents, ChannelError } from "@/lib/notify/channels";
import type { NotifyChannelId } from "@/lib/notify/types";

// Delivery channels (Settings → Notifications). CONTRACT.md §4:
//   GET  → { channels: NotifyChannelView[] }
//   PUT  → { id, patch } → NotifyChannelView   ("" in url/secret/pass = keep the current value)
//
// Permission mirrors /api/settings/slack: `manageSecrets` (owner-only). The channel config holds
// the owner's webhook URLs and SMTP password, and a member must not be able to redirect the
// owner's alerts to their own Discord — CONTRACT §4 says read/act, but the T3 brief explicitly
// says to copy whatever /api/settings/slack does, and that route is owner-only.
const CHANNEL_IDS: NotifyChannelId[] = ["telegram", "slack", "discord", "teams", "email", "webhook"];

async function uid(): Promise<string | null> {
  return workspaceUserId("manageSecrets");
}

export async function GET() {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ channels: await channelViews(userId) });
}

export async function PUT(req: Request) {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const id = String(b.id ?? "");
  if (!CHANNEL_IDS.includes(id as NotifyChannelId)) {
    return NextResponse.json({ error: "unknown_channel" }, { status: 400 });
  }
  const patch = (b.patch ?? {}) as Record<string, unknown>;
  try {
    // Telegram/Slack credentials stay in their own columns; only their event filter is stored here.
    if (id === "telegram" || id === "slack") {
      await saveChannelEvents(userId, id, patch.events);
      return NextResponse.json((await channelViews(userId)).find(v => v.id === id));
    }
    return NextResponse.json(await saveChannel(userId, id as "discord" | "teams" | "email" | "webhook", patch));
  } catch (e) {
    if (e instanceof ChannelError) {
      // not_migrated means the write failed on a missing column — not the caller's fault.
      return NextResponse.json({ error: e.code }, { status: e.code === "not_migrated" ? 500 : 400 });
    }
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
}
