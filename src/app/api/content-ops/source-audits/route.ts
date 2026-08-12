import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { contentOpsUserId } from "@/lib/contentOps/server";
import { validateSourceRef } from "@/lib/contentOps/github";
import { markStaleSourceAudits, runSourceAudit, sourceAuditDto } from "@/lib/sourceAudit/service";

function schemaMissing(error: unknown): boolean {
  const value = error as any;
  if (value?.code === "P2021" || value?.code === "P2022") return true;
  return /SourceAuditRun.*(?:does not exist|no such table|unknown column)/i.test(String(value?.message ?? value ?? ""));
}

export async function GET(req: Request) {
  const userId = await contentOpsUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await markStaleSourceAudits(userId);
    const repositoryId = new URL(req.url).searchParams.get("repositoryId") || undefined;
    const runs = await prisma.sourceAuditRun.findMany({
      where: { userId, ...(repositoryId ? { repositoryId } : {}) },
      include: { repository: true },
      orderBy: { startedAt: "desc" },
      take: 20,
    });
    return NextResponse.json({ runs: runs.map(sourceAuditDto) });
  } catch (error) {
    if (schemaMissing(error)) return NextResponse.json({ runs: [], notMigrated: true });
    return NextResponse.json({ error: "source_audit_failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await contentOpsUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const repositoryId = String(body.repositoryId ?? "").trim();
  const repository = await prisma.contentRepository.findFirst({ where: { id: repositoryId, userId } });
  if (!repository) return NextResponse.json({ error: "repository_not_found" }, { status: 404 });
  let ref: string;
  try { ref = validateSourceRef(body.ref, repository.baseBranch); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "invalid_source_ref" }, { status: 400 }); }

  try {
    const running = await prisma.sourceAuditRun.findFirst({ where: { repositoryId, userId, status: "running" } });
    if (running) return NextResponse.json({ error: "source_audit_running", run: sourceAuditDto({ ...running, repository }) }, { status: 409 });
    const run = await prisma.sourceAuditRun.create({
      data: { userId, repositoryId, ref, status: "running", stage: "tree", progress: 0, heartbeatAt: new Date() },
      include: { repository: true },
    });
    runSourceAudit(run.id).catch(error => console.error("[source-audit] run failed", error));
    return NextResponse.json({ run: sourceAuditDto(run) }, { status: 202 });
  } catch (error) {
    if (schemaMissing(error)) return NextResponse.json({ error: "source_audit_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "source_audit_failed" }, { status: 500 });
  }
}
