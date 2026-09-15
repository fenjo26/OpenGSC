import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { keywordHistory } from "@/lib/serpmon/store";
import { positiveInt, serpmonError, unauthorized } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/serp-monitor/keywords/[id]/history?limit=30 — snapshots and the top hosts' series. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const userId = await workspaceUserId();
    if (!userId) return unauthorized();
    const { id } = await params;
    const limit = positiveInt(new URL(req.url).searchParams, "limit") ?? 30;
    const history = await keywordHistory(userId, id, limit);
    if (!history) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(history);
  } catch (e) {
    return serpmonError(e, { snapshots: [], hosts: [] });
  }
}
