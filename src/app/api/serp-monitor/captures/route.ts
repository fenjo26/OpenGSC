import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { listCaptures } from "@/lib/ext/serpCapture";
import { unauthorized, serpmonError } from "../shared";

// GET /api/serp-monitor/captures?projectId=&keyword=&limit= — SERP pages saved from the browser
// extension, newest first. With projectId: that project's captures PLUS the loose ones
// (projectId null) whose country/lang match the project — they are the same market's SERPs.

export async function GET(req: Request) {
  try {
    const userId = await workspaceUserId();
    if (!userId) return unauthorized();

    const sp = new URL(req.url).searchParams;
    const projectId = sp.get("projectId") || undefined;
    const keyword = sp.get("keyword") || undefined;
    const limit = Number(sp.get("limit")) || 20;

    const captures = await listCaptures(userId, { projectId, keyword, limit });
    return NextResponse.json({ captures });
  } catch (e) {
    return serpmonError(e, { captures: [] });
  }
}
