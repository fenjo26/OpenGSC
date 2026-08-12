import { NextResponse } from "next/server";
import { changeOwnPassword, TeamError } from "@/lib/team/service";
import { getWorkspace, unauthorized } from "@/lib/team/workspace";

// POST /api/team/password — change your own password. Available to every role, including a member
// who is still on the temporary password an admin handed them.
export async function POST(req: Request) {
  const ws = await getWorkspace();
  if (!ws) return unauthorized();
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(await changeOwnPassword(ws.actorId, body?.currentPassword, body?.newPassword));
  } catch (error) {
    if (error instanceof TeamError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "password_change_failed" }, { status: 500 });
  }
}
