import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { getProfile, getSite, localSchemaMissing } from "@/lib/local/store";
import { recheckCitations } from "@/lib/local/runner";

// POST /api/local/citations/run { siteId } (act, net) — re-check the site's listing URLs now.
// Free, but it leaves the server: one safeFetch per listing.

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { siteId?: string };
  const siteId = String(body?.siteId ?? "");
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });

  try {
    const site = await getSite(userId, siteId);
    if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    const profile = await getProfile(userId, siteId);
    if (!profile) return NextResponse.json({ error: "profile_required" }, { status: 400 });
    const rows = await prisma.localCitation.findMany({
      where: { siteId: site.id },
      orderBy: { createdAt: "asc" },
      take: 50,
      select: { id: true, url: true },
    });
    const summary = await recheckCitations(rows, profile);
    return NextResponse.json({ summary, checkedAt: new Date().toISOString() });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] citations run failed:", error);
    return NextResponse.json({ error: "citations_run_failed" }, { status: 500 });
  }
}
