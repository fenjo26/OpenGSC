import { NextResponse } from "next/server";
import { openSecret } from "@/lib/contentOps/secretBox";
import { GitHubError, previewRepositoryChange } from "@/lib/contentOps/github";
import { contentOpsUserId, ownedOperation } from "@/lib/contentOps/server";
import { prisma } from "@/lib/prisma";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await contentOpsUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const operation = await ownedOperation(userId, id);
  if (!operation) return NextResponse.json({ error: "operation_not_found" }, { status: 404 });
  if (!operation.repository || !operation.filePath || !operation.content.trim()) {
    return NextResponse.json({ error: "publishing_target_incomplete" }, { status: 400 });
  }
  try {
    const preview = await previewRepositoryChange(openSecret(operation.repository.tokenCipher), operation.repository, operation.filePath, operation.content);
    if (operation.operationType === "new" && preview.file.exists) {
      preview.preflight.gates.unshift({ id: "target_mode", severity: "error", message: "New-page target already exists", detail: preview.file.path });
      preview.preflight.blockers++;
    }
    if (operation.operationType === "update" && !preview.file.exists) {
      preview.preflight.gates.unshift({ id: "target_mode", severity: "error", message: "Update target does not exist", detail: preview.file.path });
      preview.preflight.blockers++;
    }
    await prisma.contentOperation.update({ where: { id }, data: { gates: JSON.stringify(preview.preflight), error: null } });
    return NextResponse.json(preview);
  } catch (error) {
    const code = error instanceof GitHubError ? error.code : error instanceof Error ? error.message : "preview_failed";
    return NextResponse.json({ error: code, message: error instanceof GitHubError ? error.message : undefined }, { status: error instanceof GitHubError ? error.status : 400 });
  }
}
