import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { genByType } from "@/lib/seo/generate";
import { resolveAiFallbacks } from "@/lib/mcp/shared";
import { failStaleSeoJobs, touchSeoJob, withSeoJobHeartbeat } from "@/lib/jobs/lifecycle";

// SeoJob model isn't in the committed generated client until `prisma generate` re-runs
// on build; access it via a loose handle so types resolve everywhere.
const jobs = () => (prisma as any).seoJob;

// Detached background run — not awaited by the request, so the result is persisted even
// if the client navigates away or closes the tab. Keys live only in memory for the run.
function runJob(jobId: string, type: string, payload: any) {
  void (async () => {
    try {
      await touchSeoJob(jobId, { stage: "generating", progress: 5 });
      const r = await withSeoJobHeartbeat(jobId, genByType(type, payload));
      await jobs().update({
        where: { id: jobId },
        data: r.ok
          ? { status: "completed", stage: "completed", progress: 100, heartbeatAt: new Date(), result: JSON.stringify(r.data) }
          : { status: "error", stage: "error", heartbeatAt: new Date(), error: r.error },
      });
    } catch (e: any) {
      try {
        await jobs().update({
          where: { id: jobId },
          data: { status: "error", stage: "error", heartbeatAt: new Date(), error: String(e?.message ?? e) },
        });
      } catch { /* row removed */ }
    }
  })();
}

// POST /api/seo/jobs — start a background generation job. body: { type, keyword?, payload, meta? }
export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json();
  const type = String(b.type ?? "");
  if (!["outline", "text", "analysis", "landing", "cluster", "outline_auto"].includes(type)) return NextResponse.json({ error: "bad_type" }, { status: 400 });
  const payload = b.payload ?? {};
  const keyword = String(b.keyword ?? payload?.keyword ?? payload?.outline?.meta?.keyword ?? "").slice(0, 300);

  let job: any;
  try {
    job = await jobs().create({
      data: {
        userId, type, keyword, status: "processing", stage: "queued", progress: 0,
        heartbeatAt: new Date(), resumable: false,
        meta: b.meta ? JSON.stringify(b.meta) : null,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: `db: ${String(e?.message ?? e)} (run: npx prisma db push)` }, { status: 500 });
  }

  // Standby providers for the outline step, resolved SERVER-side from the user's stored keys.
  // The browser posts only the one credential set it resolved for this task, so a job started
  // from the UI had no way to survive that provider being down — even on an instance with three
  // other keys configured. An explicit `aiFallbacks` in the payload still wins.
  if (!payload.aiFallbacks) {
    try {
      const alts = await resolveAiFallbacks(userId, payload.aiProvider ? String(payload.aiProvider) : undefined);
      if (alts.length) payload.aiFallbacks = alts;
    } catch { /* fallbacks are a safety net, never a reason to refuse the job */ }
  }

  runJob(job.id, type, payload); // fire-and-forget
  return NextResponse.json({ jobId: job.id });
}

// GET /api/seo/jobs — list the current user's recent jobs (incl. result, so History can import).
export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    // A dedicated heartbeat distinguishes a slow model call from a task lost during restart.
    await failStaleSeoJobs(userId);
    const list = await jobs().findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 50 });
    return NextResponse.json({ jobs: list });
  } catch {
    return NextResponse.json({ jobs: [] }); // table not migrated yet → empty, no crash
  }
}

// DELETE /api/seo/jobs?failed=1 — bulk-remove the user's failed jobs so the list stays clean.
export async function DELETE(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const failed = new URL(req.url).searchParams.get("failed");
  if (!failed) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    const r = await jobs().deleteMany({ where: { userId, status: "error" } });
    return NextResponse.json({ deleted: r?.count ?? 0 });
  } catch {
    return NextResponse.json({ deleted: 0 });
  }
}
