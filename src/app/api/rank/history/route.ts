import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { getUserGoogleAccounts, queryGsc, isoDaysAgo } from "@/lib/gscQuery";

// GET /api/rank/history?keywordId=…&days=90
// Full position history for one tracked keyword: scraped SERP checks + the GSC
// daily average position for the same query — merged by day for a two-line chart.
export async function GET(req: Request) {
  const userId = await workspaceUserId();

  const { searchParams } = new URL(req.url);
  const keywordId = searchParams.get("keywordId") || "";
  const days = Math.min(365, Math.max(7, parseInt(searchParams.get("days") || "90", 10) || 90));

  const kw = await prisma.trackedKeyword.findUnique({
    where: { id: keywordId },
    include: { site: { select: { id: true, userId: true, siteId: true, url: true, shareToken: true, shareEnabled: true } } },
  });
  // Owner session — or a valid share token for the keyword's own site (guest view).
  const shareToken = searchParams.get("shareToken") || "";
  const guestOk = !!(kw && shareToken && kw.site.shareEnabled && kw.site.shareToken === shareToken);
  if (!kw || (!guestOk && kw.site.userId !== userId)) {
    return NextResponse.json({ error: userId || guestOk ? "Not found" : "Unauthorized" }, { status: userId || guestOk ? 404 : 401 });
  }

  const since = new Date(Date.now() - days * 86400000);

  const checks = await prisma.rankCheck.findMany({
    where: { keywordId, checkedAt: { gte: since } },
    orderBy: { checkedAt: "asc" },
    select: { checkedAt: true, position: true, url: true, error: true },
  });

  // GSC daily series for this exact query. For a guest (share link) there's no session user,
  // so use the site owner's Google accounts.
  const accounts = await getUserGoogleAccounts(userId ?? kw.site.userId);
  const gscRows = await queryGsc(accounts, kw.site.siteId, {
    startDate: isoDaysAgo(days),
    endDate: isoDaysAgo(2),
    dimensions: ["date"],
    rowLimit: 500,
    filters: [{ dimension: "query", operator: "equals", expression: kw.keyword }],
  });

  // Merge by ISO day
  const byDay = new Map<string, { date: string; serp: number | null; gsc: number | null; clicks: number; impressions: number }>();
  const dayOf = (d: Date | string) => new Date(d).toISOString().split("T")[0];
  for (const r of gscRows) {
    const day = r.keys?.[0] ?? "";
    if (!day) continue;
    byDay.set(day, {
      date: day,
      serp: null,
      gsc: +((r.position ?? 0).toFixed(1)),
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
    });
  }
  for (const c of checks) {
    const day = dayOf(c.checkedAt);
    const row = byDay.get(day) ?? { date: day, serp: null, gsc: null, clicks: 0, impressions: 0 };
    if (c.position !== null) row.serp = c.position; // last check of the day wins
    byDay.set(day, row);
  }

  const series = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

  return NextResponse.json({
    keyword: kw.keyword,
    country: kw.country,
    position: kw.lastPosition,
    bestPosition: kw.bestPosition,
    url: kw.lastUrl,
    series,
    checks: checks.map(c => ({ date: c.checkedAt, position: c.position, url: c.url, error: c.error })),
  });
}
