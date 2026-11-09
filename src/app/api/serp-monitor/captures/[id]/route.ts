import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { unauthorized } from "../../shared";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/serp-monitor/captures/[id]?compare=nearest|<snapshotId> — one browser capture with
// its rows and, optionally, the host-level diff against the nearest automated snapshot.
// DELETE removes it. Session-authenticated; E0 lays the guards, the bodies are wave-ext E5.

export async function GET(_req: Request, _ctx: Ctx) {
  const userId = await workspaceUserId();
  if (!userId) return unauthorized();
  return NextResponse.json({ error: "not_implemented" }, { status: 501 });
}

export async function DELETE(_req: Request, _ctx: Ctx) {
  const userId = await workspaceUserId("write");
  if (!userId) return unauthorized();
  return NextResponse.json({ error: "not_implemented" }, { status: 501 });
}
