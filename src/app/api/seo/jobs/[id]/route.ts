import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { failStaleSeoJobs } from "@/lib/jobs/lifecycle";

const jobs = () => (prisma as any).seoJob;

// GET /api/seo/jobs/[id] — poll a single job (status + result when done).
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    let job = await jobs().findUnique({ where: { id } });
    if (!job || job.userId !== userId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    // The page WATCHING a wedged job is the one place the stale sweep must run: without this,
    // a hung-but-heartbeating job only ever dies if the user happens to open History.
    if (job.status === "processing") {
      await failStaleSeoJobs(userId);
      job = await jobs().findUnique({ where: { id } });
    }
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
