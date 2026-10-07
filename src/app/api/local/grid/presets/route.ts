import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { localSchemaMissing } from "@/lib/local/store";
import { createGridPreset, deleteGridPreset, listGridPresets } from "@/lib/localGrid/preset";

// Saved geo-grid presets (R+ wave G) — the /api/local/grid sibling route, same auth and
// site-scoping pattern: every method resolves the workspace user first, then scopes through
// site.userId / site: { userId } inside the store, so another workspace's preset id is
// "not found", never a leak.

// GET /api/local/grid/presets?siteId=… → { presets } (each with its dynamics series:
// the preset's scans, oldest first, summarized)
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const siteId = new URL(req.url).searchParams.get("siteId");
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });

  try {
    const presets = await listGridPresets(userId, siteId);
    return NextResponse.json({ presets });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] grid preset list failed:", error);
    return NextResponse.json({ error: "grid_preset_list_failed" }, { status: 500 });
  }
}

// POST /api/local/grid/presets — { siteId, name, keyword, centerLat, centerLng, gridSize,
// radiusKm, hl?, schedule? } → { preset }. Validation problems are 400s with the route code
// + hint travelling verbatim (the card names the field that is wrong); a vanished site is 404.
export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const siteId = typeof body?.siteId === "string" ? body.siteId : "";
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });
  const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));

  try {
    const result = await createGridPreset(userId, siteId, {
      name: String(body?.name ?? ""),
      keyword: String(body?.keyword ?? ""),
      centerLat: num(body?.centerLat),
      centerLng: num(body?.centerLng),
      gridSize: num(body?.gridSize),
      radiusKm: num(body?.radiusKm),
      hl: typeof body?.hl === "string" ? body.hl : "",
      schedule: typeof body?.schedule === "string" ? body.schedule : "",
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, hint: result.hint },
        { status: result.error === "site_not_found" ? 404 : 400 },
      );
    }
    return NextResponse.json({ preset: result.preset });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] grid preset create failed:", error);
    return NextResponse.json({ error: "grid_preset_create_failed" }, { status: 500 });
  }
}

// DELETE /api/local/grid/presets — { siteId, id }. The preset's scans survive (SetNull):
// history is a fact, not part of the configuration. Ownership is scoped inside the store.
export async function DELETE(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id_required" }, { status: 400 });

  try {
    const deleted = await deleteGridPreset(userId, id);
    if (!deleted) return NextResponse.json({ error: "preset_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] grid preset delete failed:", error);
    return NextResponse.json({ error: "grid_preset_delete_failed" }, { status: 500 });
  }
}
