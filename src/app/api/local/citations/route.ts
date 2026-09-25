import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { addCitation, deleteCitation, getProfile, getSite, listCitations, localSchemaMissing } from "@/lib/local/store";
import { directorySuggestions } from "@/lib/local/citations";

// GET    /api/local/citations?siteId=  → rows + registration suggestions (read)
// POST   /api/local/citations { siteId, url } → add a listing URL (act)
// DELETE /api/local/citations?id=      → remove (act)

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const siteId = new URL(req.url).searchParams.get("siteId") ?? "";
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });
  try {
    const site = await getSite(userId, siteId);
    if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    const [citations, profile] = await Promise.all([
      listCitations(userId, siteId),
      getProfile(userId, siteId),
    ]);
    return NextResponse.json({
      citations,
      suggestions: directorySuggestions(profile?.country ?? ""),
    });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] citations load failed:", error);
    return NextResponse.json({ error: "citations_load_failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { siteId?: string; url?: string };
  const siteId = String(body?.siteId ?? "");
  const url = String(body?.url ?? "").trim();
  if (!siteId || !url) return NextResponse.json({ error: "site_and_url_required" }, { status: 400 });
  try {
    const citation = await addCitation(userId, siteId, url);
    return NextResponse.json({ citation });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (message === "bad_url") return NextResponse.json({ error: "bad_url" }, { status: 400 });
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] citation add failed:", error);
    return NextResponse.json({ error: "citation_add_failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "id_required" }, { status: 400 });
  try {
    await deleteCitation(userId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "citation_not_found") return NextResponse.json({ error: "citation_not_found" }, { status: 404 });
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] citation delete failed:", error);
    return NextResponse.json({ error: "citation_delete_failed" }, { status: 500 });
  }
}
