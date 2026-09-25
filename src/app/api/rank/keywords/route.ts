import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { verifyAuthOrShare } from "@/lib/authShare";
import { getUserSerpCreds } from "@/lib/rank";
import { getUserGoogleAccounts, queryGsc, isoDaysAgo } from "@/lib/gscQuery";
import { validateLocation } from "@/lib/seo/localPack";

async function ownedSite(userId: string, siteId: string) {
  return prisma.site.findFirst({ where: { id: siteId, userId } });
}

// GET /api/rank/keywords?siteId=…&gsc=1
// List tracked keywords with recent check history (sparkline) and, when gsc=1,
// the matching GSC average position/clicks for the last 7 days.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") || "";
  const withGsc = searchParams.get("gsc") === "1";
  
  const shareToken = searchParams.get("shareToken");
  let userId: string;
  let site: any = null;
  let whereClause: any = {};

  if (shareToken) {
    site = await prisma.site.findFirst({ where: { shareToken, shareEnabled: true } });
    if (!site) return NextResponse.json({ error: "Invalid share token" }, { status: 403 });
    userId = site.userId;
    whereClause = { siteId: site.id };
  } else {
        const loggedInId = await workspaceUserId();
    if (!loggedInId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    userId = loggedInId;

    if (siteId === "all" || !siteId) {
      const sites = await prisma.site.findMany({ where: { userId }, select: { id: true } });
      whereClause = { siteId: { in: sites.map(s => s.id) } };
    } else {
      site = await ownedSite(userId, siteId);
      if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });
      whereClause = { siteId };
    }
  }

  const keywords = await prisma.trackedKeyword.findMany({
    where: whereClause,
    orderBy: { createdAt: "desc" },
    include: {
      checks: {
        orderBy: { checkedAt: "desc" },
        take: 30,
        select: { checkedAt: true, position: true, error: true, provider: true, localPack: true, hasLocalPack: true },
      },
    },
  });

  // GSC comparison: one query for all keywords (top 500 by clicks, last 7 finalized days)
  let gscMap: Record<string, { pos: number; clicks: number; impressions: number }> = {};
  if (withGsc && keywords.length && site) {
    const accounts = await getUserGoogleAccounts(userId);
    const rows = await queryGsc(accounts, site.siteId, {
      startDate: isoDaysAgo(9),
      endDate: isoDaysAgo(2),
      dimensions: ["query"],
      rowLimit: 500,
    });
    for (const r of rows) {
      const q = (r.keys?.[0] ?? "").toLowerCase();
      if (q) gscMap[q] = {
        pos: +((r.position ?? 0).toFixed(1)),
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
      };
    }
  }

  const creds = await getUserSerpCreds(userId);

  return NextResponse.json({
    provider: creds?.provider ?? null,
    fallbackProvider: creds?.fallback?.provider ?? null,
    hasSerpKey: !!creds,
    keywords: keywords.map(k => ({
      id: k.id,
      keyword: k.keyword,
      country: k.country,
      lang: k.lang,
      device: k.device,
      // wave-nov N3: "" = country-level keyword (as before) | city | "lat,lng"
      location: k.location,
      createdAt: k.createdAt,
      lastCheckedAt: k.lastCheckedAt,
      position: k.lastPosition,
      prevPosition: k.prevPosition,
      bestPosition: k.bestPosition,
      url: k.lastUrl,
      lastError: k.checks[0]?.error ?? null,
      lastProvider: k.checks[0]?.provider ?? null,
      // Map pack, kept OUTSIDE `position` (wave-nov §0.2): our place 1..3 or null = not in pack.
      localPack: k.lastLocalPack,
      // What the last check said about the pack itself: true = pack existed, we are not in it;
      // false = no pack on that SERP; null = provider does not report packs.
      lastHasLocalPack: k.checks[0]?.hasLocalPack ?? null,
      // sparkline: oldest → newest
      history: [...k.checks].reverse().map(c => ({ date: c.checkedAt, position: c.position })),
      gsc: gscMap[k.keyword.toLowerCase()] ?? null,
    })),
  });
}

// POST /api/rank/keywords  { siteId, keywords: string[], country?, lang?, device?, location? }
// wave-nov N3: `location` ("" | city | "lat,lng") is part of the keyword's IDENTITY — the same
// query from Thessaloniki and from Athens is two rows. A line may carry its own location as a
// CSV second column ("taxi thessaloniki airport,Thessaloniki, Greece"), overriding the field.
export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const site = await ownedSite(userId, siteId);
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const country = (String(b.country ?? "us").trim().toLowerCase() || "us").slice(0, 2);
  const lang = (String(b.lang ?? "en").trim().toLowerCase() || "en").slice(0, 5);
  const device = b.device === "mobile" ? "mobile" : "desktop";

  const locCheck = validateLocation(b.location);
  if (!locCheck.ok) return NextResponse.json({ error: locCheck.error }, { status: 400 });
  const defaultLocation = locCheck.value;

  const raw: string[] = Array.isArray(b.keywords) ? b.keywords : [String(b.keywords ?? "")];
  const invalid: { keyword: string; error: string }[] = [];
  const parsed: { keyword: string; location: string }[] = [];
  for (const line of raw.flatMap(s => String(s).split("\n"))) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // "keyword,location": the first comma starts the location column. A comma inside a keyword
    // is not a query anyone searches, so it is read as the CSV separator, not punished.
    const comma = trimmed.indexOf(",");
    const kwPart = comma > 0 ? trimmed.slice(0, comma) : trimmed;
    const locPart = comma > 0 ? trimmed.slice(comma + 1).trim() : "";
    const keyword = kwPart.trim().toLowerCase().replace(/\s+/g, " ");
    if (!keyword || keyword.length > 200) continue;
    let location = defaultLocation;
    if (locPart !== "") {
      const perLine = validateLocation(locPart);
      if (!perLine.ok) { invalid.push({ keyword, error: perLine.error }); continue; }
      location = perLine.value;
    }
    parsed.push({ keyword, location });
  }

  const seen = new Set<string>();
  const list: { keyword: string; location: string }[] = [];
  for (const p of parsed) {
    const key = `${p.keyword}\u0000${p.location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(p);
    if (list.length >= 200) break;
  }

  if (!list.length) {
    // With only invalid lines, say WHY (the location error is fixable); with nothing at all,
    // keep the old "no_keywords" contract.
    return invalid.length
      ? NextResponse.json({ error: invalid[0].error, invalid }, { status: 400 })
      : NextResponse.json({ error: "no_keywords" }, { status: 400 });
  }

  let added = 0, existing = 0;
  const ids: string[] = [];
  for (const { keyword, location } of list) {
    try {
      const k = await prisma.trackedKeyword.create({
        data: { siteId, keyword, country, lang, device, location },
      });
      ids.push(k.id);
      added++;
    } catch {
      existing++; // unique constraint (now incl. location) — already tracked
    }
  }
  return NextResponse.json({ ok: true, added, existing, invalid, ids });
}

// DELETE /api/rank/keywords  { siteId, ids: string[] }
export async function DELETE(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const site = await ownedSite(userId, siteId);
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String) : [];
  if (!ids.length) return NextResponse.json({ error: "no_ids" }, { status: 400 });

  const r = await prisma.trackedKeyword.deleteMany({ where: { id: { in: ids }, siteId } });
  return NextResponse.json({ ok: true, deleted: r.count });
}
