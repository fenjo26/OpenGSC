import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { replyReview } from "@/lib/local/gbp";
import { getProfile, localSchemaMissing, saveReply } from "@/lib/local/store";

// POST /api/local/gbp/reviews/reply { siteId, reviewId, comment } (act, net) — answer a review
// from the UI. `reviewId` is the STORED row id; the Google review name is looked up server-side,
// the reply goes through the same classified-call path as everything else, and the local row is
// mirrored only when the API accepted it.

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { siteId?: string; reviewId?: string; comment?: string };
  const siteId = String(body?.siteId ?? "");
  const reviewId = String(body?.reviewId ?? "");
  const comment = String(body?.comment ?? "").trim().slice(0, 4000);
  if (!siteId || !reviewId) return NextResponse.json({ error: "site_and_review_required" }, { status: 400 });
  if (!comment) return NextResponse.json({ error: "comment_required" }, { status: 400 });

  try {
    // Ownership: the review must belong to a site of this workspace.
    const row = await prisma.gbpReview.findFirst({
      where: { id: reviewId, siteId },
      select: { id: true, reviewId: true, site: { select: { userId: true } } },
    });
    if (!row || row.site.userId !== userId) return NextResponse.json({ error: "review_not_found" }, { status: 404 });

    const profile = await getProfile(userId, siteId);
    if (!profile?.gbpAccount || !profile.gbpLocation) {
      return NextResponse.json({ error: "gbp_not_selected" }, { status: 400 });
    }

    const res = await replyReview(userId, profile.gbpAccount, profile.gbpLocation, row.reviewId, comment);
    if (!res.ok) return NextResponse.json({ error: res.error ?? "gbp_error", message: res.message ?? null });

    await saveReply(userId, reviewId, comment, new Date());
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] GBP reply failed:", error);
    return NextResponse.json({ error: "reply_failed" }, { status: 500 });
  }
}
