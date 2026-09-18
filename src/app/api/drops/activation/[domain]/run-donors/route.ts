import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getAsset } from "@/lib/drops/activationStore";
import { schemaMissing } from "@/lib/drops/store";
import { mapDonorError, runDonors } from "@/lib/drops/donors";

export const dynamic = "force-dynamic";

/**
 * Run the donor accelerator: stored donors × eligible doorways → placements + IndexerQueue
 * rows. Idempotent (upserts — re-runs refresh placedAt, never duplicate).
 *
 * An empty result is 200, never an error: no donors stored, or no doorway met the threshold
 * (`hint.code` says which). The threshold echoes back in the hint so the panel can offer
 * lowering it per run — the operator decides; this route never lowers the default itself.
 */
export async function POST(req: Request, context: { params: Promise<{ domain: string }> }) {
  try {
    const userId = await workspaceUserId("act");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { domain } = await context.params;
    const found = await getAsset(userId, domain);
    if (!found) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const opts: { minGoogleHits?: number; days?: number } = {};
    for (const key of ["minGoogleHits", "days"] as const) {
      const value = (body as Record<string, unknown>)[key];
      if (value === undefined) continue;
      // Reject rather than coerce: a threshold of -5 or 2.7 silently lowered to the default
      // would hide the caller's mistake behind a run they did not ask for.
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        return NextResponse.json({ error: `bad_${key}` }, { status: 400 });
      }
      opts[key] = value;
    }

    return NextResponse.json(await runDonors(userId, found.asset.id, opts));
  } catch (e) {
    const mapped = mapDonorError(e);
    if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
