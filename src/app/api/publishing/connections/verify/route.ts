import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { verifyConnection } from "@/lib/publish/store";

export const dynamic = "force-dynamic";

// POST /api/publishing/connections/verify — { id }
// Runs the platform adapter's verify against the stored credentials and persists the honest
// outcome: status ok/error with lastError and lastVerifiedAt. The connection row (masked
// preview included) comes back so the UI can refresh the card from one response.
export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const id = String(body?.id ?? "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  try {
    return NextResponse.json({ connection: await verifyConnection(userId, id) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: message === "connection_not_found" ? 404 : 400 });
  }
}
