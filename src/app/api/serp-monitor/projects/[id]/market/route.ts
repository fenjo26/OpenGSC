import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { marketRows } from "@/lib/serpmon/store";
import type { MarketQuery } from "@/lib/serpmon/types";
import { positiveInt, serpmonError, unauthorized } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/serp-monitor/projects/[id]/market?… — the per-keyword market table page. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const userId = await workspaceUserId();
    if (!userId) return unauthorized();
    const { id } = await params;
    const sp = new URL(req.url).searchParams;

    const sortRaw = sp.get("sort");
    const sort = sortRaw === "keyword" || sortRaw === "volatility" || sortRaw === "changes" ? sortRaw : undefined;
    const q: MarketQuery = {
      ...(sp.get("q") ? { q: sp.get("q")! } : {}),
      ...(sp.get("host") ? { host: sp.get("host")! } : {}),
      ...(sp.get("group") ? { group: sp.get("group")! } : {}),
      ...(sp.get("changed") === "1" ? { changedOnly: true } : {}),
      ...(sort ? { sort } : {}),
      ...(positiveInt(sp, "page") ? { page: positiveInt(sp, "page") } : {}),
      ...(positiveInt(sp, "pageSize") ? { pageSize: positiveInt(sp, "pageSize") } : {}),
    };

    const result = await marketRows(userId, id, q);
    if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (e) {
    return serpmonError(e, { rows: [], total: 0, all: 0 });
  }
}
