import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import {
  VERIFY_FILTERS,
  isVerifyRunning,
  runPlacementVerify,
  runRenderVerify,
} from "@/lib/seo/placementRunner";

// POST /api/backlinks/verify { siteId, ids?, filter?, allowInsecureTls?, useRender?, firecrawlKey? }
// → { id } — creates a SiteBacklinkSync (kind "verify") and runs it in the background; the
// caller polls GET for progress. Unlike check-alive there is no take:200 — the queue covers
// the entire selection, so "check all" really checks all and the tab can be closed.
//
//   ids     — concrete rows (single row required for the paid JS-render recheck)
//   filter  — all | missing | favorites | unchecked; mass actions work by filter, not by
//             checkboxes on the visible page
//
// GET /api/backlinks/verify?siteId= → latest verify run status for the site.
// Permission: workspaceUserId("act") — the check spends no provider units, it is our own HTTP
// (the render recheck bills the user's own Firecrawl key, passed per request, never stored).

const store = () => (prisma as any).siteBacklinkSync; // siteBacklinkSync arrives with T0's migration

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const siteId: string | undefined = typeof body.siteId === "string" ? body.siteId : undefined;
  const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === "string") : [];
  const filter: string | undefined = typeof body.filter === "string" ? body.filter : undefined;
  const allowInsecureTls: boolean = body.allowInsecureTls === true;
  const useRender: boolean = body.useRender === true;
  const firecrawlKey: string | undefined = typeof body.firecrawlKey === "string" ? body.firecrawlKey : undefined;

  if (!siteId) return NextResponse.json({ error: "siteId is required" }, { status: 400 });
  if (filter && !(VERIFY_FILTERS as readonly string[]).includes(filter)) {
    return NextResponse.json({ error: `filter must be one of: ${VERIFY_FILTERS.join(", ")}` }, { status: 400 });
  }
  if (useRender) {
    // The render recheck is paid and deliberately single-row — never part of a mass run.
    if (ids.length !== 1) return NextResponse.json({ error: "useRender requires exactly one id" }, { status: 400 });
    if (!firecrawlKey) return NextResponse.json({ error: "firecrawlKey is required for useRender" }, { status: 400 });
  }

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });
  if (isVerifyRunning(siteId)) return NextResponse.json({ error: "verify_already_running" }, { status: 409 });

  const sync = await store().create({
    data: { siteId, kind: "verify", status: "running", stage: "pull", progress: 0, heartbeatAt: new Date() },
  });

  const params = { siteId, ids, filter, allowInsecureTls };
  if (useRender) {
    void runRenderVerify(sync.id, { siteId, backlinkId: ids[0], firecrawlKey: firecrawlKey! })
      .catch(error => console.error("[verify] render run crashed:", error));
  } else {
    void runPlacementVerify(sync.id, params)
      .catch(error => console.error("[verify] run crashed:", error));
  }

  return NextResponse.json({ id: sync.id });
}

export async function GET(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const siteId = new URL(req.url).searchParams.get("siteId");
  if (!siteId) return NextResponse.json({ error: "siteId is required" }, { status: 400 });

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const sync = await store().findFirst({
    where: { siteId, kind: "verify" },
    orderBy: { startedAt: "desc" },
  });
  if (!sync) return NextResponse.json({ running: false, run: null });

  let summary = null;
  if (sync.summary) {
    try { summary = JSON.parse(sync.summary); } catch { summary = null; }
  }
  return NextResponse.json({
    running: sync.status === "running",
    run: {
      id: sync.id,
      status: sync.status,
      stage: sync.stage,
      progress: sync.progress,
      rowsSeen: sync.rowsSeen,
      complete: sync.complete,
      summary,
      error: sync.error,
      startedAt: sync.startedAt,
      finishedAt: sync.finishedAt,
    },
  });
}
