import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { startRun } from "@/lib/serpmon/collector";
import { readJson, serpmonError, unauthorized } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/serp-monitor/projects/[id]/run — "Check now". Start statuses per CONTRACT §4:
 * 409 already_running / cooldown, 400 no_creds / no_keywords, 404 a foreign or missing project.
 */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const userId = await workspaceUserId("act");
    if (!userId) return unauthorized();
    const { id } = await params;
    const body = (await readJson(req)) ?? {};
    const force = body.force === true;

    const res = await startRun(userId, id, "manual", { force });
    if ("runId" in res) return NextResponse.json({ runId: res.runId });
    if (res.error === "not_found") return NextResponse.json({ error: res.error }, { status: 404 });
    if (res.error === "already_running" || res.error === "cooldown") {
      return NextResponse.json({ error: res.error }, { status: 409 });
    }
    return NextResponse.json({ error: res.error }, { status: 400 }); // no_creds | no_keywords
  } catch (e) {
    return serpmonError(e);
  }
}
