import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { openSecret } from "@/lib/contentOps/secretBox";
import { GitHubError, readPullRequest } from "@/lib/contentOps/github";
import { contentOpsUserId, operationDto, ownedOperation } from "@/lib/contentOps/server";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await contentOpsUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const operation = await ownedOperation(userId, id);
  if (!operation) return NextResponse.json({ error: "operation_not_found" }, { status: 404 });
  if (operation.status !== "pr_open" || !operation.repository || !operation.prNumber) return NextResponse.json({ error: "no_open_pull_request" }, { status: 409 });
  try {
    const state = await readPullRequest(openSecret(operation.repository.tokenCipher), operation.repository, operation.prNumber);
    if (state.merged) {
      const mergedAt = state.mergedAt ? new Date(state.mergedAt) : new Date();
      await prisma.$transaction([
        prisma.contentOperation.update({ where: { id }, data: { status: "pr_merged", mergedAt, commitSha: state.mergeCommitSha || operation.commitSha, error: null } }),
        prisma.contentOperationEvent.create({ data: { operationId: id, userId, fromStatus: "pr_open", toStatus: "pr_merged", note: "system:pr_merged" } }),
      ]);
    }
    return NextResponse.json({ state, operation: operationDto(await ownedOperation(userId, id)) });
  } catch (error) {
    const code = error instanceof GitHubError ? error.code : error instanceof Error ? error.message : "pull_request_refresh_failed";
    return NextResponse.json({ error: code, message: error instanceof GitHubError ? error.message : undefined }, { status: error instanceof GitHubError ? error.status : 400 });
  }
}
