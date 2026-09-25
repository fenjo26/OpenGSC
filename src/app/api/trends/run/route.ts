import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { runTrends, trendsSchemaMissing } from "@/lib/trends/store";

// POST /api/trends/run { siteId, sources?: ("gsc_rising"|"gsc_new"|"suggest")[], deep?: boolean }
// (CONTRACT §4, act). "Refresh": the daily run, on demand. Free — the user's own GSC quota
// (three Search Analytics calls) and Google suggest (public endpoint) — so no spend gate.
// `deep` adds the a–z/0–9 suggest expansion, capped at 50 requests for the site either way.
export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const siteId = String(body?.siteId ?? "");
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });

  try {
    return NextResponse.json(
      await runTrends(userId, siteId, {
        deep: body?.deep === true,
        sources: Array.isArray(body?.sources) ? body.sources.map(String) : undefined,
      }),
    );
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (trendsSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "trends_run_failed" }, { status: 500 });
  }
}
