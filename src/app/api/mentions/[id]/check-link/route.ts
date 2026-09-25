import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { checkMentionLink, mentionsSchemaMissing } from "@/lib/mentions/store";

// POST /api/mentions/[id]/check-link (CONTRACT §4, act) → { linkStatus }. The only path that
// expands a Google News redirect: a user action per mention, never part of the daily run.

export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  try {
    return NextResponse.json({ linkStatus: await checkMentionLink(userId, id) });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "mention_not_found") return NextResponse.json({ error: "mention_not_found" }, { status: 404 });
    if (mentionsSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "link_check_failed" }, { status: 500 });
  }
}
