import { NextResponse } from "next/server";
import { TeamError, transferOwnership } from "@/lib/team/service";
import { requireWorkspace } from "@/lib/team/workspace";

// POST /api/team/transfer — hand the workspace to an active admin. Owner-only and irreversible from
// this side: afterwards the previous owner is an admin like any other.
export async function POST(req: Request) {
  const guard = await requireWorkspace("manageAdmins");
  if (!guard.ok) return guard.response;
  const body = await req.json().catch(() => ({}));
  if (body?.confirm !== true) return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
  try {
    return NextResponse.json(await transferOwnership(guard.ws, String(body?.membershipId ?? "")));
  } catch (error) {
    if (error instanceof TeamError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "transfer_failed" }, { status: 500 });
  }
}
