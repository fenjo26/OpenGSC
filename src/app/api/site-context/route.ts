import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { getSiteContext, applyContextUpdates } from "@/lib/siteContext/store";

// The Context card's backend — the same store the MCP tools use (get_site_context /
// update_site_context), so the operator's edits and the agent's write-backs land on one
// dataset and can never drift apart.
//
// GET  /api/site-context?siteId=…        → the whole context (empty shell before db push)
// POST /api/site-context { siteId, updates: ContextPatchOp[] } → apply, as "user"

async function ownSite(userId: string, siteId: string | null) {
  if (!siteId) return null;
  return prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
}

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const siteId = new URL(req.url).searchParams.get("siteId");
  const site = await ownSite(userId, siteId);
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });
  return NextResponse.json(await getSiteContext(site.id));
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const site = await ownSite(userId, typeof body.siteId === "string" ? body.siteId : null);
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });
  const updates = Array.isArray(body.updates) ? body.updates : [];
  if (!updates.length) return NextResponse.json({ error: "updates required" }, { status: 400 });
  try {
    const result = await applyContextUpdates(site.id, updates, "user");
    return NextResponse.json(result);
  } catch (e: unknown) {
    const missing = /SiteContextSection|SiteKeyPage|SiteResearchLog/i.test(String((e as Error)?.message ?? ""));
    return NextResponse.json(
      { error: missing ? "not_migrated" : String((e as Error)?.message ?? e) },
      { status: missing ? 503 : 500 },
    );
  }
}
