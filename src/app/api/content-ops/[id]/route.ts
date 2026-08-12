import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canTransition, isContentStatus, normalizeContentPath, runContentPreflight } from "@/lib/contentOps/types";
import { contentOpsUserId, operationDto, ownedOperation, recordTransition } from "@/lib/contentOps/server";

const MAX_CONTENT = 2_000_000;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await contentOpsUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const operation = await ownedOperation(userId, id);
  if (!operation) return NextResponse.json({ error: "operation_not_found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));

  if (body.status != null) {
    const next = String(body.status);
    if (!isContentStatus(next) || !canTransition(operation.status, next)) {
      return NextResponse.json({ error: "invalid_status_transition", from: operation.status, to: next }, { status: 409 });
    }
    if (next === "review") {
      const preflight = runContentPreflight(operation.content);
      const updated = await prisma.contentOperation.update({ where: { id }, data: { status: next, gates: JSON.stringify(preflight), error: null } });
      await recordTransition(id, userId, operation.status, next, String(body.note ?? "system:ready_review"), { blockers: preflight.blockers, warnings: preflight.warnings });
      return NextResponse.json({ operation: operationDto(await ownedOperation(userId, updated.id)) });
    }
    const now = new Date();
    const timestamps = next === "approved" ? { approvedAt: now } : next === "live" ? { liveAt: now } : {};
    const updated = await prisma.contentOperation.update({ where: { id }, data: { status: next, error: null, ...timestamps } });
    await recordTransition(id, userId, operation.status, next, String(body.note ?? "").slice(0, 500));
    return NextResponse.json({ operation: operationDto(await ownedOperation(userId, updated.id)) });
  }

  if (["pr_open", "pr_merged", "live", "measuring", "completed"].includes(operation.status)) {
    return NextResponse.json({ error: "published_operation_is_locked" }, { status: 409 });
  }
  const data: Record<string, unknown> = {};
  if (body.title != null) {
    const title = String(body.title).trim().slice(0, 240);
    if (!title) return NextResponse.json({ error: "missing_title" }, { status: 400 });
    data.title = title;
  }
  if (body.keyword != null) data.keyword = String(body.keyword).trim().slice(0, 240);
  if (body.targetUrl != null) data.targetUrl = String(body.targetUrl).trim().slice(0, 1000) || null;
  if (body.repositoryId != null) {
    const repositoryId = String(body.repositoryId || "") || null;
    if (repositoryId && !(await prisma.contentRepository.findFirst({ where: { id: repositoryId, userId }, select: { id: true } }))) {
      return NextResponse.json({ error: "repository_not_found" }, { status: 404 });
    }
    data.repositoryId = repositoryId;
  }
  if (body.filePath != null) {
    try { data.filePath = body.filePath ? normalizeContentPath(String(body.filePath)) : null; }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "invalid_file_path" }, { status: 400 }); }
  }
  if (body.content != null) {
    const content = String(body.content);
    if (content.length > MAX_CONTENT) return NextResponse.json({ error: "content_too_large" }, { status: 413 });
    data.content = content;
    data.gates = content.trim() ? JSON.stringify(runContentPreflight(content)) : null;
  }
  const updated = await prisma.contentOperation.update({ where: { id }, data });
  return NextResponse.json({ operation: operationDto(await ownedOperation(userId, updated.id)) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await contentOpsUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const operation = await prisma.contentOperation.findFirst({ where: { id, userId }, select: { status: true } }).catch(() => null);
  if (!operation) return NextResponse.json({ error: "operation_not_found" }, { status: 404 });
  if (["pr_open", "pr_merged", "live", "measuring", "completed"].includes(operation.status)) {
    return NextResponse.json({ error: "published_operation_cannot_be_deleted" }, { status: 409 });
  }
  await prisma.contentOperation.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
