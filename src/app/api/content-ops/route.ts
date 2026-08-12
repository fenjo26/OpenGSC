import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rawQuery } from "@/lib/db/raw";
import { contentOpsUserId, operationDto, repositoryDto } from "@/lib/contentOps/server";
import { extractHistoryContent, runContentPreflight } from "@/lib/contentOps/types";
import { captureDueCheckpoints } from "@/lib/contentOps/outcome";

const MAX_CONTENT = 2_000_000;

export async function GET() {
  const userId = await contentOpsUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    // Outcome windows close on their own schedule, so they are captured on read instead of by a
    // background timer: a couple of local aggregates, and nothing to lose across a restart.
    await captureDueCheckpoints(userId).catch(() => 0);
    const [operations, repositories, historyRows] = await Promise.all([
      prisma.contentOperation.findMany({
        where: { userId }, orderBy: { updatedAt: "desc" }, take: 100,
        include: { repository: true, events: { orderBy: { createdAt: "desc" }, take: 40 } },
      }),
      prisma.contentRepository.findMany({ where: { userId }, orderBy: { name: "asc" } }),
      rawQuery<any[]>(
        `SELECT id, type, keyword, data, createdAt FROM "SeoHistory"
         WHERE userId = ? AND status = ? AND type IN (?, ?, ?)
         ORDER BY createdAt DESC LIMIT 60`,
        userId, "completed", "text", "landing", "analysis",
      ).catch(() => []),
    ]);
    const history = historyRows.map(row => {
      let data: unknown = row.data;
      try { data = JSON.parse(row.data); } catch { /* legacy plain string */ }
      const content = extractHistoryContent(data);
      return { id: row.id, type: row.type, keyword: row.keyword, createdAt: row.createdAt, usable: !!content.trim(), words: content.trim().split(/\s+/).filter(Boolean).length };
    }).filter(row => row.usable);
    return NextResponse.json({ operations: operations.map(operationDto), repositories: repositories.map(repositoryDto), history });
  } catch {
    return NextResponse.json({ operations: [], repositories: [], history: [], notMigrated: true });
  }
}

export async function POST(req: Request) {
  const userId = await contentOpsUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const title = String(body.title ?? "").trim().slice(0, 240);
  if (!title) return NextResponse.json({ error: "missing_title" }, { status: 400 });
  const operationType = body.operationType === "update" ? "update" : "new";
  const allowedSources = new Set(["manual", "history", "demand", "gsc", "content_gap"]);
  const sourceType = allowedSources.has(String(body.sourceType)) ? String(body.sourceType) : "manual";
  const sourceRef = String(body.sourceRef ?? "").trim().slice(0, 300) || null;
  let content = String(body.content ?? "");

  if (sourceType === "history") {
    if (!sourceRef) return NextResponse.json({ error: "missing_history_item" }, { status: 400 });
    const rows = await rawQuery<any[]>(`SELECT data FROM "SeoHistory" WHERE id = ? AND userId = ? LIMIT 1`, sourceRef, userId).catch(() => []);
    if (!rows[0]) return NextResponse.json({ error: "history_item_not_found" }, { status: 404 });
    let data: unknown = rows[0].data;
    try { data = JSON.parse(rows[0].data); } catch { /* legacy plain string */ }
    content = extractHistoryContent(data);
    if (!content.trim()) return NextResponse.json({ error: "history_item_has_no_content" }, { status: 400 });
  }
  if (content.length > MAX_CONTENT) return NextResponse.json({ error: "content_too_large" }, { status: 413 });

  try {
    const operation = await prisma.contentOperation.create({
      data: {
        userId, title, operationType, sourceType, sourceRef,
        keyword: String(body.keyword ?? "").trim().slice(0, 240),
        targetUrl: String(body.targetUrl ?? "").trim().slice(0, 1000) || null,
        content,
        gates: content.trim() ? JSON.stringify(runContentPreflight(content)) : null,
        events: { create: { userId, toStatus: "idea", note: "system:created" } },
      },
      include: { repository: true, events: { orderBy: { createdAt: "desc" } } },
    });
    return NextResponse.json({ operation: operationDto(operation) }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "content_ops_not_migrated" }, { status: 503 });
  }
}
