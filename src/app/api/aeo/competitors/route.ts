import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { getCompetitors, saveCompetitors, sovSchemaMissing } from "@/lib/visibility/store";
import type { AiCompetitor } from "@/lib/visibility/types";

// GET /api/aeo/competitors?siteId=… → AiCompetitor[]
// PUT /api/aeo/competitors?siteId=…  body: AiCompetitor[] (the whole list, max 10)
// Saving recomputes the share-of-voice report on the next read — no AI call, which is exactly
// the demo this sub-tab exists to make.

async function ownedSite(userId: string, siteId: string) {
  return prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
}

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") || "";
  const site = await ownedSite(userId, siteId);
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  return NextResponse.json({ competitors: await getCompetitors(userId, siteId) });
}

export async function PUT(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const site = await ownedSite(userId, siteId);
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const list: AiCompetitor[] = Array.isArray(b.competitors) ? b.competitors : [];
  if (!list.length && !Array.isArray(b.competitors)) {
    return NextResponse.json({ error: "invalid_list" }, { status: 400 });
  }

  try {
    await saveCompetitors(userId, siteId, list);
  } catch (e) {
    if (sovSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    throw e;
  }
  return NextResponse.json({ ok: true, competitors: await getCompetitors(userId, siteId) });
}
