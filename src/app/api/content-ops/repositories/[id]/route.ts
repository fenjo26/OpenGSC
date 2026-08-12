import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { contentOpsUserId } from "@/lib/contentOps/server";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await contentOpsUserId("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const result = await prisma.contentRepository.deleteMany({ where: { id, userId } }).catch(() => ({ count: 0 }));
  if (!result.count) return NextResponse.json({ error: "repository_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
