import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { localSchemaMissing } from "@/lib/local/store";
import { runGridPreset } from "@/lib/localGrid/preset";
import type { CreateGridScanProblem } from "@/lib/localGrid/run";

// POST /api/local/grid/presets/run — { id } → { scan, queryCount }
// Run-now for a saved preset: the exact path the scheduler fires through (preset's point,
// radius, grid and hl; the scan row is chained by presetId so it joins the dynamics series).
// The cost statement rides on every answer, success or refusal — gridSize² queries per fire.

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
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id_required" }, { status: 400 });

  try {
    const fired = await runGridPreset(userId, id);
    if (!fired.ok) return NextResponse.json({ error: fired.error }, { status: 404 });
    if (!fired.result.ok) {
      return NextResponse.json({ error: fired.result.error, hint: fired.result.hint }, { status: STATUS_FOR_PROBLEM[fired.result.error] });
    }
    return NextResponse.json({ scan: fired.result.scan, queryCount: fired.result.queryCount });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] grid preset run failed:", error);
    return NextResponse.json({ error: "grid_preset_run_failed" }, { status: 500 });
  }
}
