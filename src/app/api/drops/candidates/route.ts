import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { deleteCandidates, listCandidates, setStarred, setWatched, stageCounts, schemaMissing, type CandidateSortField } from "@/lib/drops/store";
import type { DropSource, DropStage } from "@/lib/drops/types";

const STAGES: DropStage[] = [
  "ingested", "dns_checked", "resolved_taken", "checking",
  "available", "taken", "confirmed", "rejected", "acquired",
];
const SOURCES: DropSource[] = ["csv", "ahrefs_refdomains", "ahrefs_broken", "crawler", "zone_diff"];
const SORT_FIELDS: CandidateSortField[] = ["score", "createdAt", "domain", "dr", "refdomains", "snapshots", "checkedAt"];

/** Filter fields shared by GET (read), DELETE and PATCH (bulk over "весь фильтр"). */
function filterFromParams(p: URLSearchParams) {
  const stage = p.get("stage");
  const source = p.get("source");
  const minScore = Number(p.get("minScore"));
  return {
    runId: p.get("runId") ?? undefined,
    // An unrecognised value is dropped rather than passed through: a typo in the query string
    // should show the unfiltered list, not an empty one the user reads as "nothing found".
    stage: STAGES.includes(stage as DropStage) ? (stage as DropStage) : undefined,
    source: SOURCES.includes(source as DropSource) ? (source as DropSource) : undefined,
    tld: p.get("tld")?.toLowerCase().replace(/^\./, "") || undefined,
    q: p.get("q") ?? undefined,
    minScore: Number.isFinite(minScore) && p.get("minScore") ? minScore : undefined,
    starred: p.get("starred") === "1" ? true : undefined,
    watched: p.get("watched") === "1" ? true : undefined,
  };
}

export async function GET(req: Request) {
  try {
    const userId = await workspaceUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const p = url.searchParams;
    const orderBy = p.get("orderBy");

    const page = await listCandidates(userId, {
      ...filterFromParams(p),
      limit: Number(p.get("limit")) || undefined,
      offset: Number(p.get("offset")) || undefined,
      orderBy: SORT_FIELDS.includes(orderBy as CandidateSortField) ? (orderBy as CandidateSortField) : "score",
      orderDir: p.get("order") === "asc" ? "asc" : "desc",
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

/** Filter fields sent by the client, dropped to `undefined` unless a non-empty string. */
function filterFromBody(raw: unknown) {
  const o = (raw ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" && o[k] !== "" ? (o[k] as string) : undefined);
  const minScore = Number(o.minScore);
  return filterFromParams(new URLSearchParams({
    ...(s("runId") ? { runId: s("runId")! } : {}),
    ...(s("stage") ? { stage: s("stage")! } : {}),
    ...(s("source") ? { source: s("source")! } : {}),
    ...(s("tld") ? { tld: s("tld")! } : {}),
    ...(s("q") ? { q: s("q")! } : {}),
    ...(Number.isFinite(minScore) && o.minScore != null && o.minScore !== "" ? { minScore: String(minScore) } : {}),
    ...(o.starred === "1" || o.starred === 1 ? { starred: "1" } : {}),
    ...(o.watched === "1" || o.watched === 1 ? { watched: "1" } : {}),
  }));
}

/**
 * Bulk actions over the selection. The body carries either explicit `ids` (the checked rows) or
 * `matchAll: true` + the current filter fields ("выбрать все по фильтру") — the same filter the
 * table reads with, so the count the UI promised is the count the query deletes or stars.
 */
async function bulk(req: Request): Promise<NextResponse> {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((v: unknown): v is string => typeof v === "string").slice(0, 500)
      : undefined;
    const scope = ids?.length
      ? { ids }
      : body?.matchAll === true
        ? { filter: filterFromBody(body?.filter) }
        : undefined;
    if (!scope) return NextResponse.json({ error: "no_selection" }, { status: 400 });

    const action = String(body?.action ?? "");
    if (req.method === "DELETE") {
      const deleted = await deleteCandidates(userId, scope);
      return NextResponse.json({ deleted });
    }
    if (action === "star" || action === "unstar") {
      const updated = await setStarred(userId, scope, action === "star");
      return NextResponse.json({ updated });
    }
    // Watching is the star that does something: a watched row is re-checked by the scheduler
    // until the registry frees it. Enabling makes the rows due immediately.
    if (action === "watch" || action === "unwatch") {
      const updated = await setWatched(userId, scope, action === "watch");
      return NextResponse.json({ updated });
    }
    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  return bulk(req);
}

export async function PATCH(req: Request) {
  return bulk(req);
}
