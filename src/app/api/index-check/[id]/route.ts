import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getRunStatus, getRunItems } from "@/lib/indexing/checkQueue";

// One run's progress + paged items. Polled every 10s while the run is active.
//
//   GET ?verdict=&limit=&offset=  — status block (counts, verdicts, per-site breakdown) plus a
//                                   page of items. verdict "all"/absent = every item.

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  try {
    const status = await getRunStatus(userId, id);
    if (!status) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const items = await getRunItems(userId, id, {
      verdict: new URL(req.url).searchParams.get("verdict") ?? undefined,
      limit: Number(new URL(req.url).searchParams.get("limit") ?? 100),
      offset: Number(new URL(req.url).searchParams.get("offset") ?? 0),
    });
    if (!items) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ...status, items: items.rows, itemsTotal: items.total, nextOffset: items.nextOffset });
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? "");
    if (/SerpCheck|does not exist|no such table|no such column/i.test(msg)) {
      return NextResponse.json({ notMigrated: true }, { status: 503 });
    }
    console.error("[index-check:status]", e);
    return NextResponse.json({ error: "status_failed" }, { status: 500 });
  }
}
