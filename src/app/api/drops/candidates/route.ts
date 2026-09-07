import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { listCandidates, stageCounts, schemaMissing } from "@/lib/drops/store";
import type { DropSource, DropStage } from "@/lib/drops/types";

const STAGES: DropStage[] = [
  "ingested", "dns_checked", "resolved_taken", "checking",
  "available", "taken", "confirmed", "rejected", "acquired",
];
const SOURCES: DropSource[] = ["csv", "ahrefs_refdomains", "ahrefs_broken", "crawler", "zone_diff"];

export async function GET(req: Request) {
  try {
    const userId = await workspaceUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const p = url.searchParams;

    const stage = p.get("stage");
    const source = p.get("source");
    const orderBy = p.get("orderBy");
    const minScore = Number(p.get("minScore"));

    const page = await listCandidates(userId, {
      runId: p.get("runId") ?? undefined,
      // An unrecognised value is dropped rather than passed through: a typo in the query string
      // should show the unfiltered list, not an empty one the user reads as "nothing found".
      stage: STAGES.includes(stage as DropStage) ? (stage as DropStage) : undefined,
      source: SOURCES.includes(source as DropSource) ? (source as DropSource) : undefined,
      tld: p.get("tld")?.toLowerCase().replace(/^\./, "") || undefined,
      q: p.get("q") ?? undefined,
      minScore: Number.isFinite(minScore) && p.get("minScore") ? minScore : undefined,
      starred: p.get("starred") === "1" ? true : undefined,
      limit: Number(p.get("limit")) || undefined,
      offset: Number(p.get("offset")) || undefined,
      orderBy: orderBy === "domain" || orderBy === "createdAt" ? orderBy : "score",
    });

    // Counts are for the funnel widget above the table and are not affected by the row filters —
    // they answer "where is the whole list", which is the question the filters exist to narrow.
    const counts = await stageCounts(userId, p.get("runId") ?? undefined);

    return NextResponse.json({ ...page, counts });
  } catch (e) {
    if (schemaMissing(e)) {
      return NextResponse.json({ rows: [], total: 0, limit: 0, offset: 0, counts: {}, notMigrated: true });
    }
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
