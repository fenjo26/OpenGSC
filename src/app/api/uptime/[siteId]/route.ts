import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { UptimeInputError, uptimeSchemaMissing, upsertMonitor } from "@/lib/uptime/store";
import { uptimeSummary } from "@/lib/uptime/store";

// GET /api/uptime/[siteId] — the site's full summary (Health tab). A valid share token may
// read it: the share view shows the panel without its mutating controls. PUT patches monitor
// fields; a URL change resets the status and re-checks immediately (store.upsertMonitor).

const MONITOR_FIELDS = ["url", "enabled", "intervalMin", "timeoutMs", "acceptStatus", "keyword", "slowMs", "failThreshold", "alerts"] as const;

export async function GET(req: Request, ctx: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await ctx.params;
  const userId = await workspaceUserId();

  // Owner session — or a valid share token belonging to the monitored site (guest view).
  // `userId` of the row is always the owner's id, so the summary query below works the same
  // for both paths; the share path authorized with the token instead of a session.
  const shareToken = new URL(req.url).searchParams.get("shareToken") ?? "";
  const site = userId
    ? await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true, userId: true } })
    : shareToken
      ? await prisma.site.findFirst({ where: { id: siteId, shareToken, shareEnabled: true }, select: { id: true, userId: true } })
      : null;
  if (!site) return NextResponse.json({ error: userId ? "not_found" : "unauthorized" }, { status: userId ? 404 : 401 });

  try {
    const summary = await uptimeSummary(site.userId, siteId);
    if (!summary) return NextResponse.json({ monitor: null });
    return NextResponse.json(summary);
  } catch (e) {
    if (uptimeSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    console.warn("[uptime] summary failed:", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ siteId: string }> }) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { siteId } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const patch: Record<string, unknown> = {};
  for (const field of MONITOR_FIELDS) {
    if (body[field] !== undefined) patch[field] = body[field];
  }

  try {
    const summary = await upsertMonitor(userId, siteId, patch);
    return NextResponse.json(summary);
  } catch (e) {
    if (e instanceof UptimeInputError) {
      const status = e.code === "not_found" ? 404 : 400;
      return NextResponse.json({ error: e.code }, { status });
    }
    if (uptimeSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    console.warn("[uptime] upsert failed:", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
