import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { getUserAeoCreds, hasAnyAeoCreds, siteAeoConfig, checkSiteQuestions } from "@/lib/aeoTracker";
import { runAutoSentiment } from "@/lib/visibility/sentimentStore";

// POST /api/aeo/check  { siteId, questionId?, force? }
// Runs AEO citation checks now: one question (questionId), all stale (default), or all (force).
// Processes up to 5 questions per call (each up to 6 sequential billed API calls) — the client
// can call again while remaining > 0.
//
// When the site's sentiment toggle is on (N7), the answers this call just wrote get their
// sentiment pass right away — the same thing the scheduler does after its own checks.
export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const creds = await getUserAeoCreds(userId);
  if (!hasAnyAeoCreds(creds)) return NextResponse.json({ error: "no_aeo_key" }, { status: 400 });

  const questionId = b.questionId ? String(b.questionId) : undefined;
  const startedAt = new Date();
  const result = await checkSiteQuestions(siteId, siteAeoConfig(site), creds, {
    onlyIds: questionId ? [questionId] : undefined,
    force: !!b.force,
    limit: 5,
  });

  if (result.checked > 0) {
    const sent = await runAutoSentiment(userId, siteId, startedAt);
    return NextResponse.json({ ok: true, ...result, sentiment: sent });
  }

  return NextResponse.json({ ok: true, ...result });
}
