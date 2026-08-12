import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { runClarityFetch } from "@/lib/clarityFetch";
import { aggregateSnapshots } from "@/lib/clarityParse";

// ─── GET: return cached snapshot (or null if none) ───────────────────────────
export async function GET(req: NextRequest) {
    const workspaceId = await workspaceUserId();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteDbId = searchParams.get("siteId");
  if (!siteDbId) return NextResponse.json({ error: "Missing siteId" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: workspaceId } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Verify site belongs to user
  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId: user.id } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  // Return site config + latest snapshot + 30-day aggregate across snapshots
  const snapshots = await prisma.claritySnapshot.findMany({
    where: { siteId: siteDbId },
    orderBy: { fetchedAt: "desc" },
    take: 35,
  });

  const parsedSnaps = snapshots.map((s: { fetchedAt: Date; data: string }) => ({
    fetchedAt: s.fetchedAt,
    data: JSON.parse(s.data),
  }));
  const latest = snapshots[0];
  const aggregate = parsedSnaps.length ? aggregateSnapshots(parsedSnaps, 30) : null;

  return NextResponse.json({
    clarityToken: site.clarityToken ? "••••••" : null,
    clarityProjectId: site.clarityProjectId ?? null,
    clarityInterval: (site as any).clarityInterval ?? "disabled",
    configured: !!(site.clarityToken && site.clarityProjectId),
    snapshot: latest
      ? { fetchedAt: latest.fetchedAt, periodDays: latest.periodDays, data: JSON.parse(latest.data) }
      : null,
    aggregate,
  });
}

// ─── POST: save token/projectId OR fetch fresh data from Clarity API ─────────
export async function POST(req: NextRequest) {
    const workspaceId = await workspaceUserId("act");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { siteId, action, clarityToken, clarityProjectId, clarityInterval, numOfDays = 3 } = body;

  if (!siteId) return NextResponse.json({ error: "Missing siteId" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: workspaceId } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const site = await prisma.site.findFirst({ where: { id: siteId, userId: user.id } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  // ── action: "save" — persist token + projectId (+ auto-collect interval) ──
  if (action === "save") {
    await prisma.site.update({
      where: { id: siteId },
      data: {
        clarityToken: clarityToken ?? site.clarityToken,
        clarityProjectId: clarityProjectId ?? site.clarityProjectId,
        ...(clarityInterval !== undefined ? { clarityInterval } : {}),
      },
    });
    return NextResponse.json({ ok: true });
  }

  // ── action: "fetch" — pull fresh data from Clarity API ──────────────────
  if (action === "fetch") {
    const result = await runClarityFetch(siteId, numOfDays);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, message: result.message }, { status: result.status });
    }
    return NextResponse.json({ ok: true, snapshot: result.snapshot });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
