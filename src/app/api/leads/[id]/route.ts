// N9 — one lead: full findings for the card, status/proposal edits from the pipeline.
// The proposal generator lives under [id]/proposal; this route only persists edits.

import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getLead, LeadStoreError, updateLead } from "@/lib/leads/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const lead = await getLead(userId, id);
  if (!lead) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ lead });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const body = await req.json().catch(() => ({})) as { status?: unknown; proposal?: unknown };
  const patch: { status?: string; proposal?: string } = {};
  if (body.status !== undefined) patch.status = String(body.status);
  if (body.proposal !== undefined) patch.proposal = String(body.proposal ?? "");
  try {
    return NextResponse.json({ lead: await updateLead(userId, id, patch) });
  } catch (error) {
    if (error instanceof LeadStoreError) {
      const status = error.code === "not_found" ? 404 : error.code === "notMigrated" ? 500 : 400;
      return NextResponse.json({ error: error.code }, { status });
    }
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}
