import "server-only";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function contentOpsUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return ((session?.user as any)?.id as string | undefined) ?? null;
}
export function repositoryDto(repo: any) {
  if (!repo) return null;
  return {
    id: repo.id, name: repo.name, owner: repo.owner, repo: repo.repo,
    baseBranch: repo.baseBranch, contentRoot: repo.contentRoot,
    createdAt: repo.createdAt, updatedAt: repo.updatedAt,
  };
}

function json(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function operationDto(operation: any) {
  return {
    id: operation.id,
    title: operation.title,
    keyword: operation.keyword,
    operationType: operation.operationType,
    sourceType: operation.sourceType,
    sourceRef: operation.sourceRef,
    targetUrl: operation.targetUrl,
    filePath: operation.filePath,
    content: operation.content,
    status: operation.status,
    gates: json(operation.gates),
    prNumber: operation.prNumber,
    prUrl: operation.prUrl,
    branchName: operation.branchName,
    commitSha: operation.commitSha,
    error: operation.error,
    approvedAt: operation.approvedAt,
    prCreatedAt: operation.prCreatedAt,
    mergedAt: operation.mergedAt,
    liveAt: operation.liveAt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    repository: repositoryDto(operation.repository),
    events: Array.isArray(operation.events) ? operation.events.map((event: any) => ({
      id: event.id, fromStatus: event.fromStatus, toStatus: event.toStatus,
      note: event.note, meta: json(event.meta), createdAt: event.createdAt,
    })) : [],
  };
}

export async function ownedOperation(userId: string, id: string) {
  return prisma.contentOperation.findFirst({
    where: { id, userId },
    include: { repository: true, events: { orderBy: { createdAt: "desc" }, take: 40 } },
  });
}

export async function recordTransition(
  operationId: string,
  userId: string,
  fromStatus: string | null,
  toStatus: string,
  note = "",
  meta?: unknown,
) {
  return prisma.contentOperationEvent.create({
    data: { operationId, userId, fromStatus, toStatus, note: note.slice(0, 500), meta: meta == null ? null : JSON.stringify(meta) },
  });
}
