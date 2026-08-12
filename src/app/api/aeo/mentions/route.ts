import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import {
  brandMentions, shareOfVoice, BRAND_LOOKUP_COST, SHARE_OF_VOICE_COST,
  type LlmPlatform,
} from "@/lib/seo/llmMentions";
import { normDomain } from "@/lib/seo/demand";
import { readUsage, recordUsage, withinCap } from "@/lib/seo/metricsStore";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";

// POST /api/aeo/mentions { siteId, action, platform?, kind?, brand?, competitors?, country?, language?, apiKey?, cap?, fetch? }
//
// Brand visibility inside AI answers, from DataForSEO's LLM Mentions index — the second source
// alongside the AEO Tracker's live per-question checks.
//
//   action "lookup" — how often the brand comes up, in which questions, and which of its pages
//                     get cited. ~$0.06.
//   action "share"  — the brand against up to 9 competitors in one call. ~$0.02. This is the
//                     number the live tracker cannot produce: it only ever asks on your behalf,
//                     so it has no idea how often a competitor was named instead of you.
//
// Cached in DemandSearch under an `llm:` prefix rather than a table of its own. The index behind
// it refreshes roughly monthly, so a 7-day cache is conservative, and the shape stored is a whole
// result replayed intact — the same reason DemandSearch exists at all.

const MENTIONS_TTL_DAYS = 7;
const UNITS_PER_USD = 1000;
const toUnits = (usd: number) => Math.max(1, Math.round(usd * UNITS_PER_USD));
const PROVIDER = "dataforseo";

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const site = await prisma.site.findFirst({
    where: { id: siteId, userId },
    select: { id: true, url: true, brandedKeywords: true },
  });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const action = String(b.action ?? "lookup");
  const platform: LlmPlatform = b.platform === "google" ? "google" : "chat_gpt";
  const kind = b.kind === "brand" ? "brand" : "domain";
  const country = String(b.country ?? "us").toLowerCase();
  const language = String(b.language ?? "en").toLowerCase();
  const apiKey = String(b.apiKey ?? "").trim();
  const cap = Number(b.cap ?? 0);
  const wantFetch = !!b.fetch;

  // The brand defaults to what the site already knows about itself: its domain, or the first of
  // its configured branded keywords. Asking the user to retype either would be asking for data
  // the app is already holding.
  const domain = normDomain(site.url);
  const firstBranded = String(site.brandedKeywords ?? "").split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)[0] ?? "";
  const value = String(b.brand ?? "").trim() || (kind === "domain" ? domain : firstBranded || domain);

  const competitors: string[] = Array.isArray(b.competitors)
    ? b.competitors.map((c: unknown) => String(c).trim()).filter(Boolean)
    : String(b.competitors ?? "").split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);

  const priceUsd = action === "share" ? SHARE_OF_VOICE_COST : BRAND_LOOKUP_COST;
  const usage = async () => {
    const u = await readUsage(userId, PROVIDER);
    return { ...u, spentUsd: u.units / UNITS_PER_USD };
  };

  const cacheKey = action === "share"
    ? `llm:share|${site.id}|${platform}|${kind}|${[value, ...competitors].join(",")}|${country}`
    : `llm:lookup|${site.id}|${platform}|${kind}|${value}|${country}`;

  const readCache = async () => {
    try {
      const rows: any[] = await rawQuery(
        `SELECT rows, createdAt FROM "DemandSearch" WHERE userId = ? AND cacheKey = ?`,
        userId, cacheKey,
      );
      const hit = rows?.[0];
      if (!hit) return null;
      if (Date.now() - new Date(hit.createdAt).getTime() > MENTIONS_TTL_DAYS * 86_400_000) return null;
      return { data: JSON.parse(hit.rows), at: new Date(hit.createdAt).toISOString() };
    } catch { return null; }
  };

  const writeCache = async (data: unknown) => {
    try {
      await runUpsert({
        table: "DemandSearch",
        conflict: ["userId", "cacheKey"],
        values: {
          userId, cacheKey, seed: value, country, language,
          mode: `llm_${action}`, source: platform,
          rows: JSON.stringify(data), createdAt: new Date().toISOString(),
        },
        update: { rows: "set", createdAt: "set" },
      });
    } catch { /* best effort */ }
  };

  // ── Free read ──
  if (!wantFetch || !apiKey) {
    const cached = await readCache();
    return NextResponse.json({
      action, platform, kind, brand: value, domain, country,
      ...(cached?.data ?? {}),
      cachedAt: cached?.at ?? null,
      priceUsd,
      usage: await usage(),
      ...(wantFetch && !apiKey ? { error: "no_key" } : {}),
    });
  }

  // ── Paid ──
  const units = toUnits(priceUsd);
  if (!(await withinCap(userId, PROVIDER, units, cap))) {
    const cached = await readCache();
    return NextResponse.json({
      action, platform, kind, brand: value,
      ...(cached?.data ?? {}),
      error: "cap_exceeded", wouldSpendUsd: priceUsd, priceUsd,
      usage: await usage(),
    }, { status: 429 });
  }

  if (action === "share") {
    const res = await shareOfVoice(apiKey, {
      kind, values: [value, ...competitors], platform, gl: country, hl: language,
    });
    if (res.error) {
      return NextResponse.json({
        action, platform, error: res.error, priceUsd, usage: await usage(),
      }, { status: res.error === "need_two" || res.error === "too_many" ? 400 : 502 });
    }
    await recordUsage(userId, PROVIDER, toUnits(res.cost || priceUsd));
    await writeCache({ rows: res.rows });
    return NextResponse.json({
      action, platform, kind, brand: value, country,
      rows: res.rows, spentUsd: res.cost, priceUsd, usage: await usage(),
    });
  }

  const res = await brandMentions(apiKey, {
    kind, value, platform, gl: country, hl: language, limit: Number(b.limit ?? 100),
  });
  if (res.error && !res.totals.length) {
    return NextResponse.json({
      action, platform, error: res.error, priceUsd, usage: await usage(),
    }, { status: 502 });
  }

  await recordUsage(userId, PROVIDER, toUnits(res.cost || priceUsd));
  await writeCache({ totals: res.totals, mentions: res.mentions, topPages: res.topPages });

  return NextResponse.json({
    action, platform, kind, brand: value, domain, country,
    totals: res.totals, mentions: res.mentions, topPages: res.topPages,
    spentUsd: res.cost, priceUsd, usage: await usage(),
    ...(res.error ? { warning: res.error } : {}),
  });
}
