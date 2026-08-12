import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";

// GET /api/gsc/page-queries?url=https://example.com/page&days=90&limit=30
//
// The queries a specific page actually ranks for, straight from Search Console.
//
// This is the free and more accurate half of "what should this rewrite keep". An external
// provider sells market volume — how much the world searches a phrase. Search Console knows
// something better for this particular job: what THIS page is already being shown for. A refresh
// that loses those phrases loses traffic that already exists, which is a worse outcome than
// missing a phrase it never had.
//
// Matched by URL rather than by site so the caller only needs the address it is about to rewrite.
// Ownership is still enforced — the URL must belong to one of the caller's own sites.

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const raw = (sp.get("url") ?? "").trim();
  const days = Math.min(365, Math.max(7, Number(sp.get("days") ?? 90)));
  const limit = Math.min(100, Math.max(1, Number(sp.get("limit") ?? 30)));

  if (!raw) return NextResponse.json({ error: "no_url", queries: [] }, { status: 400 });

  // Compared without protocol or trailing slash: GSC stores the canonical form, and a user
  // pasting the address from a browser bar will not match it character for character.
  const norm = (u: string) => u.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  const target = norm(raw);
  const host = target.split("/")[0];

  const sites = await prisma.site.findMany({
    where: { userId },
    select: { id: true, url: true, siteId: true },
  });
  const owned = sites.filter(s => norm(s.url).includes(host) || host.includes(norm(s.url)));
  if (!owned.length) return NextResponse.json({ error: "not_your_site", queries: [] }, { status: 404 });

  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows = await prisma.dailyMetric.groupBy({
    by: ["query", "url"],
    where: { siteId: { in: owned.map(s => s.id) }, date: { gte: since } },
    _sum: { clicks: true, impressions: true },
    _avg: { position: true },
    orderBy: { _sum: { impressions: "desc" } },
    take: 2000,
  });

  const queries = (rows as unknown as {
    query: string; url: string;
    _sum: { clicks: number | null; impressions: number | null };
    _avg: { position: number | null };
  }[])
    .filter(r => norm(r.url) === target)
    .map(r => ({
      keyword: r.query,
      clicks: r._sum.clicks ?? 0,
      impressions: r._sum.impressions ?? 0,
      position: r._avg.position == null ? null : Math.round(r._avg.position * 10) / 10,
    }))
    .filter(q => q.keyword)
    .slice(0, limit);

  return NextResponse.json({ url: raw, days, total: queries.length, queries });
}
