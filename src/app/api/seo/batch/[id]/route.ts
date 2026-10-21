import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getGenBatch, deleteBatch } from "@/lib/seo/genQueue/queue";

// GET /api/seo/batch/[id]?status=&limit=&offset= — batch detail with a page of
// items. Items can number in the thousands; the list is paged and filterable.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const url = new URL(req.url);
  try {
    const r = await getGenBatch(userId, id, {
      status: url.searchParams.get("status") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 100),
      offset: Number(url.searchParams.get("offset") ?? 0),
    });
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(r);
  } catch {
    return NextResponse.json({ error: "not_migrated" }, { status: 500 });
  }
}

// DELETE /api/seo/batch/[id] — remove the batch and its items. Generated
// texts stay in SeoHistory (the History store is the source of truth, not the
// queue). Running items finish into nothing; queued items die with the batch.
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    await deleteBatch(userId, id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "not_migrated" }, { status: 500 });
  }
}
