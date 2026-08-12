import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";

const jobs = () => (prisma as any).seoJob;

// GET /api/seo/jobs/[id] — poll a single job (status + result when done).
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const job = await jobs().findUnique({ where: { id } });
    if (!job || job.userId !== userId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ job });
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
}

// DELETE /api/seo/jobs/[id] — remove a job (after it's imported into local History, or dismissed).
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const job = await jobs().findUnique({ where: { id } });
    if (job && job.userId === userId) await jobs().delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}
