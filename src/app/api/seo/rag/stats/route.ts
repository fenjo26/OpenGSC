import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { rawQuery } from "@/lib/db/raw";

// GET /api/seo/rag/stats — knowledge-base sizes for the "Casino RAG" card.
// Returns { slots: 0, casinos: 0 } when the tables don't exist yet (import not run).
export async function GET() {
  const workspaceId = await workspaceUserId();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let slots = 0, casinos = 0;
  try {
    const s: any[] = await rawQuery(`SELECT COUNT(*) as c FROM "RagSlot"`);
    slots = Number(s?.[0]?.c ?? 0);
  } catch { /* table missing */ }
  try {
    const c: any[] = await rawQuery(`SELECT COUNT(*) as c FROM "RagCasino"`);
    casinos = Number(c?.[0]?.c ?? 0);
  } catch { /* table missing */ }
  return NextResponse.json({ slots, casinos });
}
