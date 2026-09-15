import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { listRuns } from "@/lib/serpmon/store";
import { positiveInt, serpmonError, unauthorized } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/serp-monitor/projects/[id]/runs?limit=60 — run summaries, newest first. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const userId = await workspaceUserId();
    if (!userId) return unauthorized();
    const { id } = await params;
    const limit = positiveInt(new URL(req.url).searchParams, "limit") ?? 60;
    return NextResponse.json({ runs: await listRuns(userId, id, limit) });
  } catch (e) {
    return serpmonError(e, { runs: [] });
  }
}
