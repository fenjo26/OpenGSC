import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { localSchemaMissing } from "@/lib/local/store";
import { createAndRunGridScan, listGridScans, type CreateGridScanProblem } from "@/lib/localGrid/run";

// GET /api/local/grid?siteId=…[&limit=…]   → scan history (points parsed, newest first)
// POST /api/local/grid                      → validate, create the row, kick the runner

// The listing and creation helpers both scope by site ownership inside the query
// (site: { userId }), the same guard /api/local/profile's store applies.

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const siteId = url.searchParams.get("siteId");
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });
  const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);

  try {
    const scans = await listGridScans(userId, siteId, Number.isFinite(limit) ? limit : 20);
    return NextResponse.json({ scans });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] grid scan list failed:", error);
    return NextResponse.json({ error: "grid_list_failed" }, { status: 500 });
  }
}

// Every creation problem is a 400 the operator can fix from this screen, except a vanished
// site (404) — the codes travel verbatim so the card can name the field that is wrong.
const STATUS_FOR_PROBLEM: Record<CreateGridScanProblem, number> = {
  site_not_found: 404,
  keyword_required: 400,
  grid_size_invalid: 400,
  radius_invalid: 400,
  center_invalid: 400,
  hl_invalid: 400,
  profile_no_coords: 400,
  no_serp_key: 400,
  location_unsupported: 400,
};

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const siteId = typeof body?.siteId === "string" ? body.siteId : "";
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });
  const numOrNull = (v: unknown): number | undefined =>
    typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

  try {
    const result = await createAndRunGridScan(userId, siteId, {
      keyword: String(body?.keyword ?? ""),
      gridSize: Number(body?.gridSize),
      radiusKm: Number(body?.radiusKm),
      centerLat: numOrNull(body?.centerLat),
      centerLng: numOrNull(body?.centerLng),
      // Manual scans gained the same language override presets carry (R+ §7.6-5): "" keeps
      // the profile-country default, "en"/"ru"/"de" answers for the tourist market.
      hl: typeof body?.hl === "string" ? body.hl : "",
    });
    if (!result.ok) {
      // The query count rides along even on failure: the operator sees what the rejected scan
      // WOULD have cost, before fixing the field and trying again.
      const queryCount = Number.isFinite(Number(body?.gridSize)) && [3, 5, 7].includes(Number(body?.gridSize))
        ? Number(body?.gridSize) ** 2
        : null;
      return NextResponse.json({ error: result.error, hint: result.hint, queryCount }, { status: STATUS_FOR_PROBLEM[result.error] });
    }
    return NextResponse.json({ scan: result.scan, queryCount: result.queryCount });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] grid scan create failed:", error);
    return NextResponse.json({ error: "grid_create_failed" }, { status: 500 });
  }
}
