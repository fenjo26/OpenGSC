import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { unauthorized } from "../shared";

// GET /api/serp-monitor/captures?projectId=&keyword=&limit= — SERP pages saved from the browser
// extension, newest first. Session-authenticated like every other /api/serp-monitor route.
// E0 lays the guard; the body is wave-ext E5 (src/lib/ext/serpCapture.ts → listCaptures).

export async function GET(_req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return unauthorized();
  return NextResponse.json({ error: "not_implemented" }, { status: 501 });
}
