import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { writeMetricsUpdates, schemaMissing, type MetricsUpdate } from "@/lib/drops/store";

export const dynamic = "force-dynamic";

/**
 * Persist enrichment numbers onto candidates.
 *
 * The fetching happens elsewhere on purpose. Free DR comes from `/api/dr` (its key and its
 * 7-day DrCache live there), paid refdomains come from `/api/metrics/domain` (its unit
 * reservation and reconciliation live there). Both are browser-callable already; this route is
 * only the bridge that writes what they returned into the catalogue, so the enrichment sources
 * keep their own accounting and this one carries none.
 */
const MAX_ENTRIES = 500;

export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const raw = Array.isArray(body?.entries) ? body.entries.slice(0, MAX_ENTRIES) : [];

    const entries: MetricsUpdate[] = [];
    for (const e of raw) {
      if (!e || typeof e !== "object" || typeof (e as { domain?: unknown }).domain !== "string") continue;
      const domain = String((e as { domain: unknown }).domain).trim().toLowerCase();
      if (!domain) continue;
      const num = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
      const entry: MetricsUpdate = { domain };
      const dr = num((e as { dr?: unknown }).dr);
      const refdomains = num((e as { refdomains?: unknown }).refdomains);
      const backlinks = num((e as { backlinks?: unknown }).backlinks);
      if (dr !== undefined) entry.dr = dr;
      if (refdomains !== undefined) entry.refdomains = refdomains;
      if (backlinks !== undefined) entry.backlinks = backlinks;
      entries.push(entry);
    }
    if (!entries.length) return NextResponse.json({ updated: 0 });

    const updated = await writeMetricsUpdates(userId, entries);
    return NextResponse.json({ updated });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
