import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { fetchVolumeHistory, AHREFS_UNIT_FLOOR, MetricsProvider } from "@/lib/seo/metrics";
import { readUsage, recordUsage, withinCap } from "@/lib/seo/metricsStore";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";

// POST /api/metrics/demand { siteId, url, country?, fetch?, apiKey?, ... }
//
// Answers the one question Content Decay cannot answer on its own: did this page lose
// positions, or did the market lose interest? GSC shows clicks falling either way, and the
// difference decides whether the fix is a rewrite or nothing at all.
//
// The keyword is derived from the page's own top GSC query rather than asked for — the user is
// looking at a URL, not a keyword, and making them supply one would be asking them to guess at
// data the app already holds.

const HISTORY_TTL_DAYS = 30;

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const url = String(b.url ?? "");
  if (!url) return NextResponse.json({ error: "no_url" }, { status: 400 });

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const country = String(b.country ?? "us").toLowerCase();
  const provider = (b.provider === "semrush" ? "semrush" : "ahrefs") as MetricsProvider;
  const apiKey = String(b.apiKey ?? "").trim();
  const baseUrl = String(b.baseUrl ?? "").trim() || undefined;
  const cap = Number(b.cap ?? 0);

  // Top query for this URL by impressions over the last 90 days.
  let keyword = "";
  try {
    const since = new Date();
    since.setDate(since.getDate() - 90);
    const rows = await prisma.dailyMetric.groupBy({
      by: ["query"],
      where: { siteId: site.id, url, date: { gte: since }, NOT: { query: "" } },
      _sum: { impressions: true },
      orderBy: { _sum: { impressions: "desc" } },
      take: 1,
    });
    keyword = String(rows[0]?.query ?? "").trim().toLowerCase();
  } catch { /* fall through to no_keyword */ }

  if (!keyword) return NextResponse.json({ error: "no_keyword" }, { status: 404 });

  const readCache = async () => {
    try {
      const rows: any[] = await rawQuery(
        `SELECT points, fetchedAt FROM "KeywordVolumeHistory" WHERE keyword = ? AND country = ? AND provider = ?`,
        keyword, country, provider,
      );
      if (!rows.length) return null;
      return {
        points: JSON.parse(rows[0].points || "[]") as { date: string; volume: number }[],
        fetchedAt: new Date(rows[0].fetchedAt).toISOString(),
      };
    } catch { return null; }
  };

  const cached = await readCache();
  const fresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < HISTORY_TTL_DAYS * 86_400_000;

  const answer = (points: { date: string; volume: number }[] | null, extra: Record<string, unknown> = {}) => {
    // A verdict, not just a series: the caller is deciding what to do with a page, and
    // "-38% over a year" is the part that changes the decision.
    let trendPct: number | null = null;
    if (points && points.length >= 6) {
      const half = Math.floor(points.length / 2);
      const older = points.slice(0, half).reduce((s, p) => s + p.volume, 0) / half;
      const newer = points.slice(-half).reduce((s, p) => s + p.volume, 0) / half;
      if (older > 0) trendPct = Math.round(((newer - older) / older) * 100);
    }
    return NextResponse.json({ keyword, country, points: points ?? [], trendPct, ...extra });
  };

  if (fresh || !b.fetch || !apiKey) {
    return answer(cached?.points ?? null, {
      cached: !!cached,
      ...(b.fetch && !apiKey ? { error: "no_key" } : {}),
      usage: await readUsage(userId, provider),
    });
  }

  // No premium fields on this endpoint, so it is the bare 50-unit floor — cheap enough to ask
  // per page, which is exactly how it will be used.
  const units = AHREFS_UNIT_FLOOR;
  if (!(await withinCap(userId, provider, units, cap))) {
    return answer(cached?.points ?? null, { error: "cap_exceeded", wouldSpend: units });
  }
  await recordUsage(userId, provider, units);

  const res = await fetchVolumeHistory({ provider, apiKey, baseUrl }, keyword, { country });
  if (res.error || !res.items.length) {
    return answer(cached?.points ?? null, { error: res.error ?? "empty" });
  }

  try {
    await runUpsert({
      table: "KeywordVolumeHistory",
      conflict: ["keyword", "country", "provider"],
      values: { keyword, country, provider, points: JSON.stringify(res.items), fetchedAt: new Date().toISOString() },
      update: { points: "set", fetchedAt: "set" },
    });
  } catch { /* cache is best effort */ }

  return answer(res.items, { units, usage: await readUsage(userId, provider) });
}
