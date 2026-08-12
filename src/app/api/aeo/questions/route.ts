import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { getUserAeoCreds } from "@/lib/aeoTracker";
import { AEO_ENGINES, hostOf } from "@/lib/seo/aeo";

async function ownedSite(userId: string, siteId: string) {
  return prisma.site.findFirst({ where: { id: siteId, userId } });
}

// GET /api/aeo/questions?siteId=…
// List tracked questions with their latest per-engine citation state.
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") || "";
  const site = await ownedSite(userId, siteId);
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const questions = await prisma.trackedQuestion.findMany({
    where: { siteId },
    orderBy: { createdAt: "desc" },
  });

  const creds = await getUserAeoCreds(userId);
  const configured = AEO_ENGINES.filter(e => !!creds[e]);

  return NextResponse.json({
    engines: configured,
    hasAnyKey: configured.length > 0,
    // The client highlights our own domain inside the competitor lists, so it needs the
    // normalized host rather than the raw GSC property string.
    host: hostOf(site.url),
    questions: questions.map((q: any) => ({
      id: q.id,
      question: q.question,
      createdAt: q.createdAt,
      lastCheckedAt: q.lastCheckedAt,
      results: q.lastResults ? JSON.parse(q.lastResults) : {},
    })),
  });
}

// POST /api/aeo/questions  { siteId, questions: string[] }
export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const site = await ownedSite(userId, siteId);
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const raw: string[] = Array.isArray(b.questions) ? b.questions : [String(b.questions ?? "")];
  const list = [...new Set(
    raw.flatMap(s => String(s).split("\n"))
      .map(s => s.trim().replace(/\s+/g, " "))
      .filter(s => s.length > 0 && s.length <= 300),
  )].slice(0, 100);

  if (!list.length) return NextResponse.json({ error: "no_questions" }, { status: 400 });

  let added = 0, existing = 0;
  const ids: string[] = [];
  for (const question of list) {
    try {
      const q = await prisma.trackedQuestion.create({ data: { siteId, question } });
      ids.push(q.id);
      added++;
    } catch {
      existing++; // unique constraint — already tracked
    }
  }
  return NextResponse.json({ ok: true, added, existing, ids });
}

// DELETE /api/aeo/questions  { siteId, ids: string[] }
export async function DELETE(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const site = await ownedSite(userId, siteId);
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String) : [];
  if (!ids.length) return NextResponse.json({ error: "no_ids" }, { status: 400 });

  const r = await prisma.trackedQuestion.deleteMany({ where: { id: { in: ids }, siteId } });
  return NextResponse.json({ ok: true, deleted: r.count });
}
