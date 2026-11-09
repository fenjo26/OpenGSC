import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { captureView, deleteCapture } from "@/lib/ext/serpCapture";
import { unauthorized, serpmonError, notFound } from "../../shared";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/serp-monitor/captures/[id]?compare=nearest|<snapshotId> — one browser capture with
// its rows and, optionally, the host-level diff against an automated snapshot of the same
// keyword (view-only: nothing is stored). DELETE removes the capture.

export async function GET(req: Request, { params }: Ctx) {
  try {
    const userId = await workspaceUserId();
    if (!userId) return unauthorized();
    const { id } = await params;
    const compare = new URL(req.url).searchParams.get("compare") || undefined;
    const view = await captureView(userId, id, compare ?? undefined);
    if (!view) return notFound();
    return NextResponse.json({ capture: view });
  } catch (e) {
    return serpmonError(e, {});
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return unauthorized();
    const { id } = await params;
    const deleted = await deleteCapture(userId, id);
    if (!deleted) return notFound();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serpmonError(e, {});
  }
}
