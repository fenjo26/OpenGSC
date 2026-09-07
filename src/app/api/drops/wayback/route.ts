import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { writeWaybackResults, schemaMissing } from "@/lib/drops/store";
import { fetchWaybackProfile } from "@/lib/drops/wayback";

export const dynamic = "force-dynamic";

/**
 * A Wayback CDX pass over a bounded slice of the catalogue.
 *
 * The archive is free and keyless but not a fan of bursts, so the slice is small (12) and walked
 * four-at-a-time with a 15s timeout each — the whole request stays under ~45s, the same budget
 * the registry check keeps to. Domains that did not make it into this slice simply come back
 * without numbers; the button covers the rest on the next click.
 */
const MAX_PER_PASS = 12;
const CONCURRENCY = 4;

export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const requested: unknown[] = Array.isArray(body?.domains) ? body.domains : [];
    const domains = requested
      .filter((d): d is string => typeof d === "string")
      .map(d => d.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, MAX_PER_PASS);
    if (!domains.length) return NextResponse.json({ updated: 0, results: [] });

    const results: { domain: string; snapshots: number; firstAt: string | null; lastAt: string | null; gapDays: number | null }[] = [];
    let throttled = 0, unreachable = 0;
    let cursor = 0;

    async function worker() {
      while (cursor < domains.length) {
        const domain = domains[cursor++];
        const out = await fetchWaybackProfile(domain);
        // A domain the archive refused is reported, not silently dropped — "Обновлено: 0" with
        // the reason still in our hands is the failure mode this module keeps regressing to.
        if (!out.ok) {
          if (out.reason === "throttled") throttled++;
          else unreachable++;
          continue;
        }
        results.push({
          domain,
          snapshots: out.profile!.snapshots,
          firstAt: out.profile!.firstAt?.toISOString() ?? null,
          lastAt: out.profile!.lastAt?.toISOString() ?? null,
          gapDays: out.profile!.gapDays,
        });
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, domains.length) }, worker));

    const updated = await writeWaybackResults(userId, results.map(r => ({
      domain: r.domain,
      snapshots: r.snapshots,
      firstAt: r.firstAt ? new Date(r.firstAt) : null,
      lastAt: r.lastAt ? new Date(r.lastAt) : null,
      gapDays: r.gapDays,
    })));

    return NextResponse.json({ updated, results, throttled, unreachable });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
