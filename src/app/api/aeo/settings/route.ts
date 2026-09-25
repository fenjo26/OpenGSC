import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { AEO_DEFAULT_MODEL } from "@/lib/seo/aeo";
import { sentimentAutoEnabled, setSentimentAuto } from "@/lib/visibility/sentimentStore";

// Per-site AI Visibility settings: which model answers, where it answers from, whether the
// background scheduler is allowed to spend the user's credits unattended, and whether fresh
// answers get a sentiment pass automatically (N7 — off by default, like aeoAuto).

async function ownedSite(userId: string, siteId: string) {
  return prisma.site.findFirst({ where: { id: siteId, userId } });
}

async function getShape(site: {
  aeoModel?: string | null; market?: string | null; aeoCountry?: string | null;
  aeoCity?: string | null; aeoLanguage?: string | null; aeoAuto?: boolean;
}, userId: string, siteId: string) {
  return {
    model: site.aeoModel || AEO_DEFAULT_MODEL,
    // `market` is the fallback, surfaced as `inheritedCountry` so the UI can show the country
    // it will actually use without silently writing that guess back to the site.
    country: site.aeoCountry ?? null,
    inheritedCountry: site.market ?? null,
    city: site.aeoCity ?? null,
    language: site.aeoLanguage ?? null,
    auto: !!site.aeoAuto,
    sentimentAuto: await sentimentAutoEnabled(userId, siteId),
  };
}

// GET /api/aeo/settings?siteId=…
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") || "";
  const site = await ownedSite(userId, siteId);
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  return NextResponse.json(await getShape(site, userId, site.id));
}

// PUT /api/aeo/settings  { siteId, model?, country?, city?, language?, auto?, sentimentAuto? }
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

  // The sentiment toggle has no Site column in this wave (schema is N0's); it lives in
  // InstanceSetting under `aeoSentAuto:<siteId>` — written only after the ownership check above.
  if (b.sentimentAuto !== undefined) {
    try {
      await setSentimentAuto(userId, site.id, !!b.sentimentAuto);
    } catch (e) {
      const v = e as { code?: string; message?: string };
      if (v?.code === "P2025" || v?.code === "P2021" || /no such table/i.test(String(v?.message ?? ""))) {
        return NextResponse.json({ notMigrated: true });
      }
      throw e;
    }
  }

  return NextResponse.json({ ok: true, ...(await getShape(updated, userId, site.id)) });
}
