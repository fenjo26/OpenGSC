import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { contentOpsUserId, repositoryDto } from "@/lib/contentOps/server";
import { sealSecret } from "@/lib/contentOps/secretBox";
import { GitHubError, verifyRepository } from "@/lib/contentOps/github";
import { validateRepositoryInput } from "@/lib/contentOps/types";

export async function POST(req: Request) {
  const userId = await contentOpsUserId("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const token = String(body.token ?? "").trim();
  if (!token || token.length > 1000) return NextResponse.json({ error: "missing_github_token" }, { status: 400 });
  try {
    const input = validateRepositoryInput(body);
    const verification = await verifyRepository(token, input);
    if (!verification.canPush) return NextResponse.json({ error: "github_token_cannot_push" }, { status: 400 });
    const repository = await prisma.contentRepository.upsert({
      where: { userId_owner_repo: { userId, owner: input.owner, repo: input.repo } },
      create: { userId, ...input, tokenCipher: sealSecret(token) },
      update: { name: input.name, baseBranch: input.baseBranch, contentRoot: input.contentRoot, tokenCipher: sealSecret(token) },
    });
    return NextResponse.json({ repository: repositoryDto(repository), verification }, { status: 201 });
  } catch (error) {
    const code = error instanceof GitHubError ? error.code : error instanceof Error ? error.message : "repository_save_failed";
    const message = error instanceof GitHubError ? error.message : undefined;
    return NextResponse.json({ error: code, message }, { status: error instanceof GitHubError ? error.status : 400 });
  }
}
