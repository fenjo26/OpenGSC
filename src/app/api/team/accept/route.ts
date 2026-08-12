import { NextResponse } from "next/server";
import { acceptInvite, TeamError } from "@/lib/team/service";

// POST /api/team/accept — the only team endpoint without a session, because the person accepting an
// invite does not have one yet. The token is single-use, expires in 72 hours, and is stored only as
// a SHA-256 digest, so this route cannot be turned into a list of pending invitations.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(await acceptInvite(String(body?.token ?? ""), String(body?.name ?? ""), String(body?.password ?? "")));
  } catch (error) {
    if (error instanceof TeamError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "invite_accept_failed" }, { status: 500 });
  }
}
