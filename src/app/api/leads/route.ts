// N9 — the lead inbox list (dashboard `/leads`). Session-guarded like every /api route:
// read for the list, act for nothing here (mutations live under /api/leads/[id]).

import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { listLeads } from "@/lib/leads/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const result = await listLeads(userId, {
    status: p.get("status") ?? undefined,
    q: p.get("q") ?? undefined,
    limit: p.get("limit") ? Number(p.get("limit")) : undefined,
    offset: p.get("offset") ? Number(p.get("offset")) : undefined,
  });
  return NextResponse.json(result);
}
