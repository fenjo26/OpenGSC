import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { previewPublish } from "@/lib/publish/store";
import { UNIQUENESS_BLOCK_THRESHOLD, UNIQUENESS_WARN_THRESHOLD } from "@/lib/publish/gate";

export const dynamic = "force-dynamic";

// POST /api/publishing/publish/preview — the same body the publish route takes.
//
// The pre-publish review step of the Publish dialog: resolves the SAME sources the publish
// would (historyId → body, per-connection items) WITHOUT creating anything, and returns the
// anchor distribution + footprint warnings + which connections would refuse a respin. The
// thresholds ride along so the dialog can state what the gate will do (block ≥ N, warn ≥ W)
// instead of the operator guessing at numbers.
export async function POST(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const siteId = String(body?.siteId ?? "");
  const items = Array.isArray(body?.items)
    ? (body.items as Record<string, unknown>[]).map(i => ({
      connectionId: String(i?.connectionId ?? ""),
      historyId: typeof i?.historyId === "string" && i.historyId ? i.historyId : undefined,
      title: typeof i?.title === "string" && i.title ? i.title : undefined,
      markdown: typeof i?.markdown === "string" && i.markdown ? i.markdown : undefined,
    })).filter(i => i.connectionId)
    : undefined;
  const connectionIds = (Array.isArray(body?.connectionIds) ? body.connectionIds : [])
    .filter((v: unknown): v is string => typeof v === "string" && !!v);
  if (!siteId || (!connectionIds.length && !items?.length)) {
    return NextResponse.json({ error: "siteId and connectionIds (or items) required" }, { status: 400 });
  }

  const site = await prisma.site.findFirst({
    where: { id: siteId, userId },
    select: { id: true, url: true, siteId: true },
  });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  try {
    const preview = await previewPublish(userId, site, {
      siteId,
      historyId: typeof body?.historyId === "string" && body.historyId ? body.historyId : undefined,
      title: typeof body?.title === "string" && body.title ? body.title : undefined,
      markdown: typeof body?.markdown === "string" && body.markdown ? body.markdown : undefined,
      connectionIds,
      items,
      respin: body?.respin === true,
    });
    return NextResponse.json({
      ...preview,
      thresholds: { block: UNIQUENESS_BLOCK_THRESHOLD, warn: UNIQUENESS_WARN_THRESHOLD },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
