import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { marketFor } from "@/lib/seo/market";

// PATCH /api/gsc/market  { siteId: string, market: string }
//
// Sets — or clears — the search market a site targets. Same shape and same guards as
// `/api/gsc/tags`, which is the other per-site field edited straight from a card.
//
// An empty string clears the column rather than storing "". The distinction matters: a cleared
// market falls back to whatever the ccTLD implies, which for `foo.gr` is Greece and for `foo.com`
// is nothing at all. Storing an empty string would look like an answer while meaning the opposite.
export async function PATCH(req: NextRequest) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { siteId, market } = await req.json().catch(() => ({}));
  if (!siteId) return NextResponse.json({ error: "Missing siteId" }, { status: 400 });

  const value = String(market ?? "").trim().toLowerCase();
  // Two letters or nothing. A free-text market would be filed into the keyword cache verbatim and
  // never match a real request again.
  if (value && !/^[a-z]{2}$/.test(value)) {
    return NextResponse.json({ error: "bad_market" }, { status: 400 });
  }

  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  await prisma.site.update({
    where: { id: siteId },
    data: { market: value || null },
  });

  // Echoed back resolved, so the caller can render the effective market without repeating the
  // ccTLD rules in the browser.
  return NextResponse.json({
    ok: true,
    market: value || null,
    effective: marketFor({ url: site.url, siteId: site.siteId, market: value || null }),
  });
}
