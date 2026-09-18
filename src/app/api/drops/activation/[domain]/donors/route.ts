import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getAsset, setDonors } from "@/lib/drops/activationStore";
import { schemaMissing } from "@/lib/drops/store";
import { mapDonorError } from "@/lib/drops/donors";

export const dynamic = "force-dynamic";

/**
 * Replace the asset's donor list (PUT — full list every time, no incremental add).
 *
 * The response carries `total` computed as before − removed + added, from the donor count this
 * request's own getAsset saw; setDonors diffs against the same rows, so the arithmetic holds
 * outside the microscopic window of a concurrent write.
 */
export async function PUT(req: Request, context: { params: Promise<{ domain: string }> }) {
  try {
    const userId = await workspaceUserId("act");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { domain } = await context.params;
    const found = await getAsset(userId, domain);
    if (!found) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const urls = (body as { urls?: unknown }).urls;
    if (!Array.isArray(urls) || urls.some(u => typeof u !== "string")) {
      return NextResponse.json({ error: "bad_urls" }, { status: 400 });
    }

    const { added, removed } = await setDonors(userId, found.asset.id, urls);
    return NextResponse.json({
      added,
      removed,
      total: found.donors.length - removed + added,
    });
  } catch (e) {
    const mapped = mapDonorError(e);
    if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
