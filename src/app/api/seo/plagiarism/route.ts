import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { runPlagiarismCheck, estimatePlagiarism, plagiarismTablesMissing } from "@/lib/plagiarism";

// POST /api/seo/plagiarism  { text? , historyId? , siteId? , confirm , cap? }  — access: spend
//
// The run itself: one quoted SERP query per sampled fragment (≤ 10), shingle-matched against
// the snippets, sources aggregated, result cached by textHash for 7 days. Two gates before a
// single provider call:
//
//   confirm !== true → 409 with the fresh estimate attached. The UI always shows the price
//   first (via /estimate, which costs nothing); this refusal is the backstop for a client that
//   skipped that step.
//   cached text     → served free, no query sent, no unit reserved.
//
// Provider-down is an error with detail, never an empty "100 % original" result.

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));

  try {
    if (b.confirm !== true) {
      // Not a silent no-op: attach what the run WOULD cost so the client can show it and retry.
      const est = await estimatePlagiarism(userId, { text: b.text, historyId: b.historyId });
      return NextResponse.json({ error: "confirm_required", estimate: est }, { status: 409 });
    }

    const out = await runPlagiarismCheck(userId, {
      text: b.text, historyId: b.historyId, siteId: b.siteId, cap: b.cap,
    });

    if (!out.ok) {
      const status =
        out.error === "no_text" || out.error === "no_fragments" || out.error === "no_serp_key" ? 400 :
        out.error === "cap_exceeded" ? 429 :
        out.error === "provider_failed" ? 502 : 500;
      return NextResponse.json(
        { error: out.error, ...(out.detail ? { detail: out.detail } : {}), ...(out.provider ? { provider: out.provider } : {}) },
        { status },
      );
    }

    return NextResponse.json({
      ok: true,
      cached: out.cached === true,
      checkedAt: out.checkedAt ?? out.result?.checkedAt ?? null,
      queries: out.queries ?? 0,
      costUsd: out.costUsd ?? null,
      provider: out.provider ?? out.result?.provider ?? "",
      result: out.result,
    });
  } catch (e) {
    if (e instanceof Error && e.message === "history_not_found") {
      return NextResponse.json({ error: "history_not_found" }, { status: 404 });
    }
    if (plagiarismTablesMissing(e)) return NextResponse.json({ notMigrated: true });
    console.error("[plagiarism:run]", e);
    return NextResponse.json({ error: "check_failed" }, { status: 500 });
  }
}
