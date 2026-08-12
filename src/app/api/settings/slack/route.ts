import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import type { Capability } from "@/lib/team/roles";
import { sendSlack } from "@/lib/notify";
import { rawQuery, rawExec } from "@/lib/db/raw";

async function uid(capability: Capability = "read"): Promise<string | null> {
return workspaceUserId(capability);
}

async function readRow(userId: string): Promise<string> {
  try {
    const rows: any[] = await rawQuery(
      `SELECT slackWebhook FROM "User" WHERE id = ?`, userId);
    return rows?.[0]?.slackWebhook ?? "";
  } catch {
    return "";
  }
}

export async function GET() {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const webhook = await readRow(userId);
  return NextResponse.json({
    connected: !!webhook,
    webhookMasked: webhook ? webhook.slice(0, 33) + "…" + webhook.slice(-8) : null,
  });
}

export async function POST(req: Request) {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const action = String(b.action ?? "save");

  try {
    if (action === "save") {
      const webhookUrl = String(b.webhookUrl ?? "").trim();
      if (!/^https:\/\/hooks\.slack\.com\/services\/\S+$/i.test(webhookUrl)) {
        return NextResponse.json({ error: "invalid_webhook_format" }, { status: 400 });
      }
      await rawExec(`UPDATE "User" SET slackWebhook = ? WHERE id = ?`, webhookUrl, userId);
      return NextResponse.json({ ok: true });
    }

    const webhook = await readRow(userId);
    if (!webhook) return NextResponse.json({ error: "no_webhook" }, { status: 400 });

    if (action === "test") {
      const r = await sendSlack(webhook, "✅ OpenGSC: Slack connected. Alerts and digests will arrive here.");
      return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: 502 });
    }

    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
}

export async function DELETE() {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await rawExec(`UPDATE "User" SET slackWebhook = NULL WHERE id = ?`, userId);
  } catch { /* ignored */ }
  return NextResponse.json({ ok: true });
}
