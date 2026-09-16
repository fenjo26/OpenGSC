import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { snapshotView } from "@/lib/serpmon/store";
import { serpmonError, unauthorized } from "../../shared";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/serp-monitor/snapshots/[id]?compare=<id> — one snapshot expanded to rows, with the
 * diff against `compare` (same keyword only) or against the snapshot's own prevId when absent.
 */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const userId = await workspaceUserId();
    if (!userId) return unauthorized();
    const { id } = await params;
    const compare = new URL(req.url).searchParams.get("compare") ?? undefined;
    const view = await snapshotView(userId, id, compare || undefined);
    if (!view) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(view);
  } catch (e) {
    return serpmonError(e);
  }
}
