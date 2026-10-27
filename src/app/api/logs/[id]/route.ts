import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { dbAny } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function ownImport(userId: string, id: string) {
  return dbAny.serverLogImport.findFirst({ where: { id, site: { userId } } }).catch(() => null);
}

// GET /api/logs/:id → the stored summary, minus the per-path map (that one feeds the audit join
// and can hold 20,000 entries the panel never shows).
export async function GET(_req: Request, { params }: Ctx) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const row = await ownImport(userId, id);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let summary: Record<string, unknown> | null = null;
  try { summary = JSON.parse(row.summary); } catch { /* corrupt row */ }
  if (summary?.google && typeof summary.google === "object") {
    const google = { ...(summary.google as Record<string, unknown>) };
    delete google.paths;
    summary = { ...summary, google };
  }
  return NextResponse.json({ import: { id: row.id, createdAt: row.createdAt, source: row.source, summary } });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const row = await ownImport(userId, id);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await dbAny.serverLogImport.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
