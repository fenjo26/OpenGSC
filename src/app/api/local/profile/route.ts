import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getProfile, listLocalSites, localSchemaMissing, saveProfile } from "@/lib/local/store";
import { normaliseHours } from "@/lib/local/schema";
import type { OpeningHoursDay } from "@/lib/local/types";

// GET /api/local/profile            → site list for the selector + per-site hasProfile (read)
// GET /api/local/profile?siteId=…   → one profile (read)
// PUT /api/local/profile            → save the profile (act)

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const siteId = new URL(req.url).searchParams.get("siteId");
  try {
    if (!siteId) {
      const sites = await listLocalSites(userId);
      return NextResponse.json({ sites });
    }
    const profile = await getProfile(userId, siteId);
    if (profile === null) return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    return NextResponse.json({ profile: profile ?? null });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] profile load failed:", error);
    return NextResponse.json({ error: "profile_load_failed" }, { status: 500 });
  }
}

const str = (v: unknown, fallback = ""): string => typeof v === "string" ? v : fallback;
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const strList = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const hoursList = (v: unknown): OpeningHoursDay[] => normaliseHours(Array.isArray(v) ? v as OpeningHoursDay[] : []);

export async function PUT(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const siteId = str(body?.siteId);
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });

  try {
    const profile = await saveProfile(userId, siteId, {
      name: str(body?.name),
      businessType: str(body?.businessType, "LocalBusiness"),
      street: str(body?.street),
      locality: str(body?.locality),
      region: str(body?.region),
      postalCode: str(body?.postalCode),
      country: str(body?.country),
      phone: str(body?.phone),
      email: str(body?.email),
      lat: num(body?.lat),
      lng: num(body?.lng),
      hours: hoursList(body?.hours),
      priceRange: str(body?.priceRange),
      sameAs: strList(body?.sameAs),
      serviceAreas: strList(body?.serviceAreas),
    });
    return NextResponse.json({ profile });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (message === "name_required") return NextResponse.json({ error: "name_required" }, { status: 400 });
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] profile save failed:", error);
    return NextResponse.json({ error: "profile_save_failed" }, { status: 500 });
  }
}
