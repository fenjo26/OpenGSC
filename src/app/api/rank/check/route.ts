import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { getUserSerpCreds, checkSiteKeywords } from "@/lib/rank";

// POST /api/rank/check  { siteId, keywordId?, force? }
// Runs SERP checks now: one keyword (keywordId), all stale (default), or all (force).
// Processes up to 20 keywords per call — the client can call again while remaining > 0.
export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const creds = await getUserSerpCreds(userId);
  if (!creds) return NextResponse.json({ error: "no_serp_key" }, { status: 400 });

  const keywordId = b.keywordId ? String(b.keywordId) : undefined;
  const result = await checkSiteKeywords(siteId, site.url, creds, {
    onlyIds: keywordId ? [keywordId] : undefined,
    force: !!b.force,
    limit: 20,
  });

  return NextResponse.json({ ok: true, provider: creds.provider, ...result });
}
