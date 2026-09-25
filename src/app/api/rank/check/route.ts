import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { getUserSerpCreds, checkSiteKeywords } from "@/lib/rank";
import { reportLocalPackChanges } from "@/lib/rankScheduler";

// POST /api/rank/check  { siteId, keywordId?, force? }
// Runs SERP checks now: one keyword (keywordId), all stale (default), or all (force).
// Processes up to 20 keywords per call (5 on A-Parser, whose checks take longer) — the client
// can call again while remaining > 0. `before` (ms epoch, sent with force) is when the client's
// loop started, so a forced run checks each keyword once instead of counting them all forever.
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
  const beforeMs = Number(b.before);
  const before = Number.isFinite(beforeMs) && beforeMs > 0 && beforeMs <= Date.now() + 60_000 ? new Date(beforeMs) : undefined;
  const result = await checkSiteKeywords(siteId, site.url, creds, {
    onlyIds: keywordId ? [keywordId] : undefined,
    force: !!b.force,
    before,
    limit: creds.provider === "aparser" ? 5 : 20,
  });

  // wave-nov N3: a manual check reports map-pack moves through the same once-a-day reporter
  // the scheduler uses (AlertEvent dedupe `lp:<siteId>:<utcDay>` keeps it to one message).
  if (result.packChanges?.length) {
    await reportLocalPackChanges(userId, siteId, site.url, result.packChanges);
  }

  return NextResponse.json({ ok: true, provider: creds.provider, fallbackProvider: creds.fallback?.provider ?? null, ...result });
}
