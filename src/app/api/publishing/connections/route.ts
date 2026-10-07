import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { listConnections, createConnection, deleteConnection } from "@/lib/publish/store";
import { PLATFORMS } from "@/lib/publish/platforms";

export const dynamic = "force-dynamic";

// Blog connections (P1: WordPress). Auth + site scoping follow the backlinks route: every
// method resolves the workspace user first, then scopes through site.userId — a connection
// id or siteId from another workspace is "not found", never a leak.
//
// Credentials are write-only through this API: what comes back is the masked preview built
// by toConnectionRow (first 3 chars), never the stored secret.

// GET /api/publishing/connections?siteId=… → { connections }
// No siteId → { sites } — the site list for the page's selector, same shape /api/local/profile
// serves the /local page (id + url is all the picker needs; archived sites stay listed so an
// existing connection is not orphaned out of view).
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") ?? "";
  if (!siteId) {
    const sites = await prisma.site.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, url: true, siteId: true },
    });
    return NextResponse.json({
      sites: sites.map(s => ({ id: s.id, url: s.url || s.siteId })),
      platforms: PLATFORMS.map(p => ({ id: p.id, name: p.name })),
    });
  }

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });
  return NextResponse.json({ connections: await listConnections(userId, siteId) });
}

// POST /api/publishing/connections — { siteId, platform, label, siteIdentifier, credentials }
export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  try {
    const connection = await createConnection(userId, {
      siteId: String(body?.siteId ?? ""),
      platform: String(body?.platform ?? ""),
      label: String(body?.label ?? ""),
      siteIdentifier: String(body?.siteIdentifier ?? ""),
      credentials: (body?.credentials && typeof body.credentials === "object" ? body.credentials : {}) as Record<string, string>,
    });
    return NextResponse.json({ connection });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = message.includes("not_found") || message.includes("unknown_platform") ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

// DELETE /api/publishing/connections — { id }
export async function DELETE(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const id = String(body?.id ?? "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const deleted = await deleteConnection(userId, id);
  if (!deleted) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
