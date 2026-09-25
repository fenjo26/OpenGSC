import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { mentionsSchemaMissing, updateMention } from "@/lib/mentions/store";

// PATCH /api/mentions/[id] { reviewed?, dismissed? } (CONTRACT §4, act).

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const body = await req.json().catch(() => ({}));
  const patch = {
    ...(typeof body?.reviewed === "boolean" ? { reviewed: body.reviewed } : {}),
    ...(typeof body?.dismissed === "boolean" ? { dismissed: body.dismissed } : {}),
  };
  if (!("reviewed" in patch) && !("dismissed" in patch)) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  try {
    await updateMention(userId, id, patch);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "mention_not_found") return NextResponse.json({ error: "mention_not_found" }, { status: 404 });
    if (mentionsSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "mention_update_failed" }, { status: 500 });
  }
}
