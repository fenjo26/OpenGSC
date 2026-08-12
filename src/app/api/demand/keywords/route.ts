import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import {
  discoverKeywords, estimateDemandCost, providerFor,
  type DemandMode, type DemandRow,
} from "@/lib/seo/demand";
import { writeKeywordCache, readUsage, recordUsage, withinCap, normalizeKeyword } from "@/lib/seo/metricsStore";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";

// POST /api/demand/keywords { seed, siteId?, country?, language?, mode?, limit?, clickstream?, apiKey?, cap?, fetch? }
//
// Keyword discovery, joined against the site's own Search Console history.
//
// Two call shapes, the same contract the metrics routes already use:
//
//   fetch: false (default) — free. Returns a previous search for this seed if one is still
//     fresh, otherwise nothing but a price. Safe to call on render, and it is what an install
//     with no DataForSEO key sees.
//
//   fetch: true — the user pressed the button. The call is priced, checked against the monthly
//     cap, charged, and sent.
//
// The join is the point of this endpoint. Ahrefs can tell you a keyword has 2 400 searches;
// only your own GSC data can tell you that you already appear for it on position 34 with a
// blog post that was never meant to rank for it. Those are different jobs and the verdict
// column names which one this is.

/** Discovery results go stale slowly — the market moves in weeks, not hours. */
const SEARCH_TTL_DAYS = 14;

/** How far back the GSC side of the join looks. Matches `/api/metrics/gap`. */
const GSC_LOOKBACK_DAYS = 90;

/**
 * Top 30 is "you have a page and it is findable, improve it". Below that, showing up at all is
 * mostly incidental — the page exists but Google is not treating it as an answer to this query.
 */
const REACH_POSITION = 30;

/**
 * `ApiUsage.units` is an integer, and DataForSEO bills in fractions of a dollar. One unit here
 * is one thousandth of a dollar, so a $0.025 research call records 25 and a $10 monthly cap is
 * entered as 10000. The UI divides by 1000 and shows dollars; nothing else needs to know.
 */
const UNITS_PER_USD = 1000;
const toUnits = (usd: number) => Math.max(1, Math.round(usd * UNITS_PER_USD));

const PROVIDER = "dataforseo";

type Verdict = "reach" | "wrong_page" | "none";

interface DemandApiRow extends DemandRow {
  /** Our own best average position from GSC, or null when we have never been shown for it. */
  ourPosition: number | null;
  ourUrl: string | null;
  ourImpressions: number;
  verdict: Verdict;
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const seed = String(b.seed ?? "").trim();
  const country = String(b.country ?? "us").toLowerCase();
  const language = String(b.language ?? "en").toLowerCase();
  const mode = (["auto", "related", "suggestions", "ideas"].includes(String(b.mode))
    ? String(b.mode)
    : "auto") as DemandMode;
  const limit = Math.max(10, Math.min(1000, Number(b.limit ?? 150)));
  const clickstream = !!b.clickstream;
  const apiKey = String(b.apiKey ?? "").trim();
  const cap = Number(b.cap ?? 0);
  const wantFetch = !!b.fetch;
  const siteId = String(b.siteId ?? "");

  if (!seed) return NextResponse.json({ error: "no_seed" }, { status: 400 });

  // The site is optional: researching a market you do not yet have a site for is a legitimate
  // use, and the join simply degrades to "we rank for nothing", which is the truth.
  const site = siteId
    ? await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true, url: true } })
    : null;

  const provider = providerFor(country);
  const priceUsd = estimateDemandCost(provider, limit, clickstream);

  // ── Our own side of the join ──
  const ourQueries = async (): Promise<Map<string, { position: number; url: string; impressions: number }>> => {
    const out = new Map<string, { position: number; url: string; impressions: number }>();
    if (!site) return out;
    try {
      const since = new Date();
      since.setDate(since.getDate() - GSC_LOOKBACK_DAYS);
      const rows = await prisma.dailyMetric.groupBy({
        by: ["query", "url"],
        where: { siteId: site.id, date: { gte: since } },
        _sum: { impressions: true },
        _avg: { position: true },
      });
      for (const r of rows) {
        const q = String(r.query ?? "").trim().toLowerCase();
        if (!q) continue;
        const pos = Number(r._avg.position ?? 0);
        const prev = out.get(q);
        // Best position wins: one query can be served by several URLs, and the question here is
        // "how close are we", not "how many pages tried".
        if (!prev || pos < prev.position) {
          out.set(q, {
            position: pos,
            url: String(r.url ?? ""),
            impressions: Number(r._sum.impressions ?? 0),
          });
        }
      }
    } catch { /* no GSC data yet — every row reads as "no content", which is accurate */ }
    return out;
  };

  const decorate = async (rows: DemandRow[]): Promise<DemandApiRow[]> => {
    const ours = await ourQueries();
    return rows.map((r) => {
      const mine = ours.get(normalizeKeyword(r.keyword));
      const ourPosition = mine ? Math.round(mine.position * 10) / 10 : null;
      const verdict: Verdict =
        ourPosition == null ? "none" : ourPosition <= REACH_POSITION ? "reach" : "wrong_page";
      return {
        ...r,
        ourPosition,
        ourUrl: mine?.url ?? null,
        ourImpressions: mine?.impressions ?? 0,
        verdict,
      };
    });
  };

  // ── Search cache ──
  const cacheKey = `${normalizeKeyword(seed)}|${country}|${language}|${mode}|${limit}|${clickstream ? 1 : 0}`;

  const readCache = async (): Promise<{ rows: DemandRow[]; source: string; at: string } | null> => {
    try {
      const rows: any[] = await rawQuery(
        `SELECT rows, source, createdAt FROM "DemandSearch" WHERE userId = ? AND cacheKey = ?`,
        userId, cacheKey,
      );
      const hit = rows?.[0];
      if (!hit) return null;
      const age = Date.now() - new Date(hit.createdAt).getTime();
      if (age > SEARCH_TTL_DAYS * 24 * 3600 * 1000) return null;
      return {
        rows: JSON.parse(hit.rows) as DemandRow[],
        source: String(hit.source ?? ""),
        at: new Date(hit.createdAt).toISOString(),
      };
    } catch {
      // Table missing until `prisma db push`. A cache miss is not a failure — the route still works.
      return null;
    }
  };

  const writeCache = async (rows: DemandRow[], source: string) => {
    try {
      await runUpsert({
        table: "DemandSearch",
        conflict: ["userId", "cacheKey"],
        values: {
          userId, cacheKey, seed: normalizeKeyword(seed), country, language, mode, source,
          rows: JSON.stringify(rows), createdAt: new Date().toISOString(),
        },
        update: { source: "set", rows: "set", createdAt: "set" },
      });
    } catch { /* best effort */ }
  };

  const usage = async () => {
    const u = await readUsage(userId, PROVIDER);
    return { ...u, spentUsd: u.units / UNITS_PER_USD };
  };

  // ── Free read ──
  if (!wantFetch || !apiKey) {
    const cached = await readCache();
    return NextResponse.json({
      seed, country, language, mode, provider,
      rows: cached ? await decorate(cached.rows) : [],
      source: cached?.source ?? null,
      cachedAt: cached?.at ?? null,
      priceUsd,
      usage: await usage(),
      ...(wantFetch && !apiKey ? { error: "no_key" } : {}),
    });
  }

  // ── Paid fetch ──
  const units = toUnits(priceUsd);
  if (!(await withinCap(userId, PROVIDER, units, cap))) {
    const cached = await readCache();
    return NextResponse.json({
      seed, country, language, mode, provider,
      rows: cached ? await decorate(cached.rows) : [],
      error: "cap_exceeded",
      wouldSpendUsd: priceUsd,
      priceUsd,
      usage: await usage(),
    }, { status: 429 });
  }

  const res = await discoverKeywords(apiKey, seed, {
    gl: country, hl: language, limit, mode, clickstream,
  });

  if (res.error && !res.rows.length) {
    return NextResponse.json({
      seed, country, language, mode, provider,
      rows: [], error: res.error, priceUsd, usage: await usage(),
    }, { status: 502 });
  }

  // Charged against what actually came back, not the ceiling quoted before the call.
  await recordUsage(userId, PROVIDER, toUnits(res.cost || priceUsd));
  await writeCache(res.rows, res.source);

  // Every discovered keyword also lands in the shared metric cache, so weights show up for free
  // in Striking Distance and Rank Tracker without anyone paying twice for the same number.
  await writeKeywordCache(
    res.rows.map((r) => ({
      keyword: r.keyword,
      volume: r.volume,
      difficulty: r.difficulty,
      cpc: r.cpc,
      intents: r.intent === "unknown" ? null : JSON.stringify([r.intent]),
      payload: r.trend.length ? { trend: r.trend } : null,
    })),
    country,
    PROVIDER,
    "api",
  );

  return NextResponse.json({
    seed, country, language, mode, provider,
    rows: await decorate(res.rows),
    source: res.source,
    usedFallback: res.usedFallback,
    spentUsd: res.cost,
    priceUsd,
    usage: await usage(),
    ...(res.error ? { warning: res.error } : {}),
  });
}
