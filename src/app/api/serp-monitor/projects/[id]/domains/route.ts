// SERP Monitor — the "Домены" listing for one project.
import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { domainQueryFromSearchParams, domainRows, isSchemaMissing } from "@/lib/serpmon/domains";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("read");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const query = domainQueryFromSearchParams(new URL(req.url).searchParams);
  try {
    const result = await domainRows(userId, id, query);
    if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (e) {
    if (isSchemaMissing(e)) return NextResponse.json({ notMigrated: true, rows: [], total: 0 });
    throw e;
  }
}
