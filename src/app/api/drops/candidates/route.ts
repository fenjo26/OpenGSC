import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import {
  deleteCandidates, listCandidates, setStarred, setWatched, stageCounts, schemaMissing,
  setCandidateGroup, dropGroupExists, parseCandidateFilter, EXCLUDE_MAX, type CandidateSortField,
} from "@/lib/drops/store";

const SORT_FIELDS: CandidateSortField[] = ["score", "createdAt", "domain", "dr", "refdomains", "snapshots", "checkedAt", "tf"];

/** Filter fields shared by GET (read), DELETE and PATCH (bulk over "весь фильтр"). */
function filterFromParams(p: URLSearchParams) {
  // An unrecognised value is dropped rather than passed through: a typo in the query string
  // should show the unfiltered list, not an empty one the user reads as "nothing found".
  return parseCandidateFilter(Object.fromEntries(p.entries()));
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

/**
 * Bulk actions over the selection. The body carries either explicit `ids` (the checked rows) or
 * `matchAll: true` + the current filter fields ("выбрать все по фильтру") — the same filter the
 * table reads with, so the count the UI promised is the count the query deletes or stars.
 *
 * `matchAll` may carry `exclude`: the rows the user unchecked after selecting everything. They
 * arrive as holes rather than as a rewritten selection because the UI cannot enumerate 50 000
 * ids, and a list longer than the cap is refused outright — quietly dropping exclusions would
 * delete rows the user had explicitly unchecked.
 */
async function bulk(req: Request): Promise<NextResponse> {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((v: unknown): v is string => typeof v === "string").slice(0, 500)
      : undefined;
    const exclude = Array.isArray(body?.exclude)
      ? body.exclude.filter((v: unknown): v is string => typeof v === "string")
      : undefined;
    if (exclude && exclude.length > EXCLUDE_MAX) {
      return NextResponse.json({ error: "too_many_exclusions", max: EXCLUDE_MAX }, { status: 400 });
    }
    const scope = ids?.length
      ? { ids }
      : body?.matchAll === true
        ? { filter: parseCandidateFilter((body?.filter ?? {}) as Record<string, unknown>), exclude }
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
    // Group assign / unassign. The groupId is validated against the caller's own groups first:
    // a foreign or stale id must fail loudly, not silently regroup someone's shortlist.
    if (action === "group" || action === "ungroup") {
      let groupId: string | null = null;
      if (action === "group") {
        groupId = typeof body?.groupId === "string" ? body.groupId : "";
        if (!groupId || !(await dropGroupExists(userId, groupId))) {
          return NextResponse.json({ error: "group_not_found" }, { status: 404 });
        }
      }
      const updated = await setCandidateGroup(userId, scope, groupId);
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
