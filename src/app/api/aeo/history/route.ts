import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";

// GET /api/aeo/history?questionId=…&days=90
// Full per-engine check history for one tracked question — used by the expandable row.
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const questionId = searchParams.get("questionId") || "";
  const days = Math.min(365, Math.max(7, parseInt(searchParams.get("days") || "90", 10) || 90));

  const q = await prisma.trackedQuestion.findUnique({
    where: { id: questionId },
    include: { site: { select: { userId: true } } },
  });
  if (!q || q.site.userId !== userId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const since = new Date(Date.now() - days * 86400000);
  let checks;
  try {
    checks = await prisma.aeoCheck.findMany({
      where: { questionId, checkedAt: { gte: since } },
      orderBy: { checkedAt: "asc" },
      select: {
        id: true, engine: true, checkedAt: true, cited: true, status: true, url: true,
        snippet: true, rank: true, model: true, searched: true, error: true,
        sentiment: true, sentimentScore: true, sentimentNote: true,
      },
    });
  } catch (e) {
    // The sentiment columns are new in this wave; an instance without `db push` keeps its
    // history readable rather than 500ing on the badge data it cannot have.
    const v = e as { code?: string; message?: string };
    if (v?.code === "P2022" || /sentiment(Score|Note)?\b.*(does not exist|no such column)/i.test(String(v?.message ?? ""))) {
      return NextResponse.json({ notMigrated: true });
    }
    throw e;
  }

  // The heavy columns (full answer, citation list) are fetched only for the newest check per
  // engine. The history strip renders dozens of dots; shipping a 12k answer behind each one
  // would make opening a row cost megabytes for data nobody scrolls to.
  const latestIds = new Map<string, string>();
  for (const c of checks) latestIds.set(c.engine, c.id);
  const detail = latestIds.size
    ? await prisma.aeoCheck.findMany({
        where: { id: { in: [...latestIds.values()] } },
        select: { id: true, engine: true, answerText: true, citations: true, sentiment: true, sentimentScore: true, sentimentNote: true },
      })
    : [];

  const latest: Record<string, { answerText: string | null; citations: unknown[]; sentiment: string | null; sentimentScore: number | null; sentimentNote: string | null }> = {};
  for (const d of detail) {
    let citations: unknown[] = [];
    try { citations = d.citations ? JSON.parse(d.citations) : []; } catch { citations = []; }
    latest[d.engine] = { answerText: d.answerText, citations, sentiment: d.sentiment, sentimentScore: d.sentimentScore, sentimentNote: d.sentimentNote };
  }

  return NextResponse.json({
    question: q.question,
    results: q.lastResults ? JSON.parse(q.lastResults) : {},
    checks,
    latest,
  });
}
