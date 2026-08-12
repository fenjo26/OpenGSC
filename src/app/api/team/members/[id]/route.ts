import { NextResponse } from "next/server";
import { removeMember, resetMemberPassword, TeamError, updateMember } from "@/lib/team/service";
import { requireWorkspace } from "@/lib/team/workspace";

function fail(error: unknown) {
  if (error instanceof TeamError) return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json({ error: "member_update_failed" }, { status: 500 });
}

// PATCH — change role, suspend or reactivate, or issue a new password for a member.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireWorkspace("manageMembers");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    if (body?.action === "reset_password") {
      return NextResponse.json(await resetMemberPassword(guard.ws, id));
    }
    return NextResponse.json({ member: await updateMember(guard.ws, id, body) });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireWorkspace("manageMembers");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  try {
    return NextResponse.json(await removeMember(guard.ws, id));
  } catch (error) {
    return fail(error);
  }
}
