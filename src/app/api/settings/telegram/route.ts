import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import type { Capability } from "@/lib/team/roles";
import { detectChatId, sendTelegram } from "@/lib/notify";
import { rawQuery, rawExec } from "@/lib/db/raw";

// Telegram bot connection (Settings → Notifications).
// GET             → { connected, botTokenMasked, chatId }
// POST { action } → "save" {botToken} | "detect" (find chat id via getUpdates) | "test"
// DELETE          → disconnect
// Raw SQL for graceful degradation before `prisma db push` (seoSettings convention).

async function uid(capability: Capability = "read"): Promise<string | null> {
return workspaceUserId(capability);
}

async function readRow(userId: string): Promise<{ token: string; chatId: string }> {
  try {
    const rows: any[] = await rawQuery(
      `SELECT telegramBotToken, telegramChatId FROM "User" WHERE id = ?`, userId);
    return { token: rows?.[0]?.telegramBotToken ?? "", chatId: rows?.[0]?.telegramChatId ?? "" };
  } catch {
    return { token: "", chatId: "" };
  }
}

export async function GET() {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { token, chatId } = await readRow(userId);
  return NextResponse.json({
    connected: !!(token && chatId),
    botTokenMasked: token ? token.slice(0, 8) + "…" + token.slice(-4) : null,
    chatId: chatId || null,
  });
}

export async function POST(req: Request) {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const action = String(b.action ?? "save");

  try {
    if (action === "save") {
      const botToken = String(b.botToken ?? "").trim();
      if (!/^\d+:[\w-]{30,}$/.test(botToken)) return NextResponse.json({ error: "invalid_token_format" }, { status: 400 });
      await rawExec(`UPDATE "User" SET telegramBotToken = ?, telegramChatId = NULL WHERE id = ?`, botToken, userId);
      return NextResponse.json({ ok: true });
    }

    const { token, chatId } = await readRow(userId);
    if (!token) return NextResponse.json({ error: "no_token" }, { status: 400 });

    if (action === "detect") {
      const r = await detectChatId(token);
      if (!r.chatId) return NextResponse.json({ error: r.error ?? "no_messages" }, { status: 400 });
      await rawExec(`UPDATE "User" SET telegramChatId = ? WHERE id = ?`, r.chatId, userId);
      return NextResponse.json({ ok: true, chatId: r.chatId, username: r.username });
    }

    if (action === "test") {
      if (!chatId) return NextResponse.json({ error: "no_chat" }, { status: 400 });
      const r = await sendTelegram(token, chatId, "✅ OpenGSC: Telegram connected. Alerts and digests will arrive here.");
      return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: 502 });
    }

    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "not_migrated" }, { status: 500 });
  }
}

export async function DELETE() {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await rawExec(`UPDATE "User" SET telegramBotToken = NULL, telegramChatId = NULL WHERE id = ?`, userId);
  } catch { /* not migrated */ }
  return NextResponse.json({ ok: true });
}
