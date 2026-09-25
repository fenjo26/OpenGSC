import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { mentionsSchemaMissing, runMentions } from "@/lib/mentions/store";

// POST /api/mentions/run { siteId } (CONTRACT §4, act). "Check now": Google News RSS (one
// request per term, ≥2 s apart) + Wikipedia + Wikidata — free public sources, no spend gate.

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const siteId = String(body?.siteId ?? "");
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });

  try {
    return NextResponse.json(await runMentions(userId, siteId));
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (mentionsSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "mentions_run_failed" }, { status: 500 });
  }
}
