import { NextResponse } from "next/server";
import { createMember, TeamError } from "@/lib/team/service";
import { requireWorkspace } from "@/lib/team/workspace";

// POST /api/team/members — add a person. Admins may add viewers and editors; only the owner may
// create an admin, because that role carries permission to spend the owner's API credits.
export async function POST(req: Request) {
  const guard = await requireWorkspace("manageMembers");
  if (!guard.ok) return guard.response;
  const body = await req.json().catch(() => ({}));
  try {
    const result = await createMember(guard.ws, body);
    // The password and invite token appear in this response and nowhere else, ever.
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof TeamError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "member_create_failed" }, { status: 500 });
  }
}
