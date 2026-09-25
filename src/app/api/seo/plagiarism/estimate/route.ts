import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { estimatePlagiarism, plagiarismTablesMissing } from "@/lib/plagiarism";

// POST /api/seo/plagiarism/estimate  { text? , historyId? }  — access: act (NOT spend)
//
// The price before the run (CONTRACT.md §0.5). This route never sends a SERP query: it counts
// the fragments the checker WOULD search, names the provider that would answer, and prices it
// from the table in lib/plagiarism/price.ts. The only external thing it may touch is the
// A-Parser credentials probe (a ping, not a SERP call) when the instance has two password
// candidates to choose between.
//
// A cache hit is reported as such: queries 0, costUsd 0, cached true — a re-check of the same
// text is free and instant, and the button should say so before anyone clicks it.

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  try {
    const est = await estimatePlagiarism(userId, { text: b.text, historyId: b.historyId });
    return NextResponse.json(est);
  } catch (e) {
    if (e instanceof Error && e.message === "history_not_found") {
      return NextResponse.json({ error: "history_not_found" }, { status: 404 });
    }
    if (plagiarismTablesMissing(e)) return NextResponse.json({ notMigrated: true });
    console.error("[plagiarism:estimate]", e);
    return NextResponse.json({ error: "estimate_failed" }, { status: 500 });
  }
}
