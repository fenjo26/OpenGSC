import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { openSecret } from "@/lib/contentOps/secretBox";
import { createContentPullRequest, GitHubError, previewRepositoryChange } from "@/lib/contentOps/github";
import { contentOpsUserId, operationDto, ownedOperation } from "@/lib/contentOps/server";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await contentOpsUserId("publish");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (body.confirm !== true) return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
  const { id } = await params;
  const operation = await ownedOperation(userId, id);
  if (!operation) return NextResponse.json({ error: "operation_not_found" }, { status: 404 });
  if (operation.status !== "review") return NextResponse.json({ error: "operation_not_in_review" }, { status: 409 });
  if (!operation.repository || !operation.filePath || !operation.content.trim()) return NextResponse.json({ error: "publishing_target_incomplete" }, { status: 400 });

  try {
    const token = openSecret(operation.repository.tokenCipher);
    const preview = await previewRepositoryChange(token, operation.repository, operation.filePath, operation.content);
    if (operation.operationType === "new" && preview.file.exists) preview.preflight.blockers++;
    if (operation.operationType === "update" && !preview.file.exists) preview.preflight.blockers++;
    if (preview.preflight.blockers) {
      await prisma.contentOperation.update({ where: { id }, data: { gates: JSON.stringify(preview.preflight) } });
      return NextResponse.json({ error: "preflight_blocked", preflight: preview.preflight }, { status: 409 });
    }
    const result = await createContentPullRequest(token, operation.repository, {
      operationId: operation.id,
      title: operation.title,
      body: [
        "Created from OpenGSC Content Operations after an explicit operator confirmation.",
        "",
        `Primary keyword: ${operation.keyword || "—"}`,
        `Preflight: ${preview.preflight.blockers} blockers, ${preview.preflight.warnings} warnings, ${preview.preflight.words} words.`,
        "",
        "OpenGSC does not auto-merge this pull request.",
      ].join("\n"),
      filePath: operation.filePath,
      content: operation.content,
      commitMessage: `${operation.operationType === "update" ? "Update" : "Add"} ${operation.title}`,
    });
    await prisma.$transaction([
      prisma.contentOperation.update({ where: { id }, data: {
        status: "pr_open", prNumber: result.number, prUrl: result.url, branchName: result.branch,
        commitSha: result.commitSha, prCreatedAt: new Date(), gates: JSON.stringify(preview.preflight), error: null,
      } }),
      prisma.contentOperationEvent.create({ data: {
        operationId: id, userId, fromStatus: "review", toStatus: "pr_open",
        note: "system:pr_created", meta: JSON.stringify({ number: result.number, url: result.url, branch: result.branch }),
      } }),
    ]);
    return NextResponse.json({ operation: operationDto(await ownedOperation(userId, id)) });
  } catch (error) {
    const code = error instanceof GitHubError ? error.code : error instanceof Error ? error.message : "pull_request_failed";
    await prisma.contentOperation.update({ where: { id }, data: { error: code } }).catch(() => {});
    return NextResponse.json({ error: code, message: error instanceof GitHubError ? error.message : undefined }, { status: error instanceof GitHubError ? error.status : 400 });
  }
}
