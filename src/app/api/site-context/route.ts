import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { getSiteContext, applyContextUpdates } from "@/lib/siteContext/store";
import { contextIsEmpty, bootstrapSuggestions } from "@/lib/siteContext/bootstrap";

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
  const ctx = await getSiteContext(site.id);
  // Empty context → attach the same bootstrap proposals the MCP tool returns, so the card and
  // the agent see (and confirm) identical suggestions — never two different proposal sets.
  const bootstrap = contextIsEmpty(ctx) ? await bootstrapSuggestions(site.id) : undefined;
  return NextResponse.json({ ...ctx, ...(bootstrap ? { bootstrap } : {}) });
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
