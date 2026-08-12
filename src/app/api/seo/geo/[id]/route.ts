import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";

const audits = () => (prisma as any).geoAudit;

// GET /api/seo/geo/[id] — poll a single audit (status + full report when done).
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const audit = await audits().findUnique({ where: { id } });
    if (!audit || audit.userId !== userId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ audit });
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
}

// DELETE /api/seo/geo/[id] — remove an audit.
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const audit = await audits().findUnique({ where: { id } });
    if (audit && audit.userId === userId) await audits().delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}
