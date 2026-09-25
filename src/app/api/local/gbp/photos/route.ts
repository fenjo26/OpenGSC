import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { addPhoto, listPhotos } from "@/lib/local/gbp";
import { getProfile, getSite, localSchemaMissing } from "@/lib/local/store";

// GET  /api/local/gbp/photos?siteId= (read, net) — the location's current photos.
// POST /api/local/gbp/photos { siteId, url } (act, net) — add a photo from a public https URL
// (brief §6: upload happens from a public URL, no file pipe through the server). Free; the
// pre-approval state is the classified gbp_access_required, never a 500.

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const siteId = new URL(req.url).searchParams.get("siteId") ?? "";
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });
  try {
    const site = await getSite(userId, siteId);
    if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    const profile = await getProfile(userId, siteId);
    if (!profile?.gbpAccount || !profile.gbpLocation) return NextResponse.json({ photos: [], error: "gbp_not_selected" });

    const res = await listPhotos(userId, profile.gbpAccount, profile.gbpLocation);
    if (!res.ok) return NextResponse.json({ error: res.error ?? "gbp_error", message: res.message ?? null });
    return NextResponse.json({ photos: res.data ?? [] });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] GBP photos load failed:", error);
    return NextResponse.json({ error: "photos_load_failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { siteId?: string; url?: string };
  const siteId = String(body?.siteId ?? "");
  const url = String(body?.url ?? "").trim();
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });
  if (!/^https:\/\/\S+$/i.test(url)) return NextResponse.json({ error: "https_url_required" }, { status: 400 });

  try {
    const site = await getSite(userId, siteId);
    if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    const profile = await getProfile(userId, siteId);
    if (!profile) return NextResponse.json({ error: "profile_required" }, { status: 400 });
    if (!profile.gbpAccount || !profile.gbpLocation) return NextResponse.json({ error: "gbp_not_selected" }, { status: 400 });

    const res = await addPhoto(userId, profile.gbpAccount, profile.gbpLocation, url);
    if (!res.ok) return NextResponse.json({ error: res.error ?? "gbp_error", message: res.message ?? null });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] GBP photo add failed:", error);
    return NextResponse.json({ error: "photo_add_failed" }, { status: 500 });
  }
}
