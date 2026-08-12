import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { AEO_DEFAULT_MODEL } from "@/lib/seo/aeo";

// Per-site AI Visibility settings: which model answers, where it answers from, and whether the
// background scheduler is allowed to spend the user's credits unattended.

async function ownedSite(userId: string, siteId: string) {
  return prisma.site.findFirst({ where: { id: siteId, userId } });
}

function shape(site: any) {
  return {
    model: site.aeoModel || AEO_DEFAULT_MODEL,
    // `market` is the fallback, surfaced as `inheritedCountry` so the UI can show the country
    // it will actually use without silently writing that guess back to the site.
    country: site.aeoCountry ?? null,
    inheritedCountry: site.market ?? null,
    city: site.aeoCity ?? null,
    language: site.aeoLanguage ?? null,
    auto: !!site.aeoAuto,
  };
}

// GET /api/aeo/settings?siteId=…
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const site = await ownedSite(userId, searchParams.get("siteId") || "");
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  return NextResponse.json(shape(site));
}

// PUT /api/aeo/settings  { siteId, model?, country?, city?, language?, auto? }
// Empty string clears a field back to null — "ask without a location" has to be expressible,
// otherwise a country picked once could never be un-picked.
export async function PUT(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const site = await ownedSite(userId, String(b.siteId ?? ""));
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const str = (v: unknown, max: number) => {
    if (v === undefined) return undefined;
    const s = String(v ?? "").trim().slice(0, max);
    return s || null;
  };

  const data: Record<string, unknown> = {};
  const model = str(b.model, 60); if (model !== undefined) data.aeoModel = model;
  const country = str(b.country, 2); if (country !== undefined) data.aeoCountry = country ? country.toLowerCase() : null;
  const city = str(b.city, 80); if (city !== undefined) data.aeoCity = city;
  const language = str(b.language, 8); if (language !== undefined) data.aeoLanguage = language ? language.toLowerCase() : null;
  if (b.auto !== undefined) data.aeoAuto = !!b.auto;

  const updated = Object.keys(data).length
    ? await prisma.site.update({ where: { id: site.id }, data })
    : site;

  return NextResponse.json({ ok: true, ...shape(updated) });
}
