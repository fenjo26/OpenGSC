import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { domainOverview, estimateDomainCost, providerFor, normDomain } from "@/lib/seo/demand";
import {
  writeDomainCache, readDomainCache, writeKeywordCache,
  readUsage, recordUsage, withinCap, normalizeKeyword,
} from "@/lib/seo/metricsStore";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";

// POST /api/demand/domain { domain, siteId?, country?, language?, keywordLimit?, pageLimit?, apiKey?, cap?, fetch? }
//
// What a domain already owns: estimated organic traffic, its ranking keywords ordered by the
// traffic they actually bring, and the pages carrying them.
//
// This deliberately overlaps with `/api/metrics/gap` without duplicating it. Gap answers "what
// does this competitor have that I do not", and needs one of my sites to mean anything. This
// answers "what is this domain", for any domain, including one I am thinking of buying or a
// client I have not onboarded. Passing `siteId` adds the comparison; leaving it out is a normal
// call, not a degraded one.
//
// Same two shapes as every other paid route here: `fetch: false` reads the cache for free,
// `fetch: true` prices the call, checks the cap, charges, and sends it.

/** A domain's footprint moves slowly; re-buying it weekly is waste. Matches DOMAIN_TTL_DAYS. */
const OVERVIEW_TTL_DAYS = 7;
const GSC_LOOKBACK_DAYS = 90;
const REACH_POSITION = 30;

/** See `/api/demand/keywords`: one ApiUsage unit is one thousandth of a dollar. */
const UNITS_PER_USD = 1000;
const toUnits = (usd: number) => Math.max(1, Math.round(usd * UNITS_PER_USD));

const PROVIDER = "dataforseo";

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const domain = normDomain(String(b.domain ?? ""));
  const country = String(b.country ?? "us").toLowerCase();
  const language = String(b.language ?? "en").toLowerCase();
  const keywordLimit = Math.max(10, Math.min(1000, Number(b.keywordLimit ?? 200)));
  const pageLimit = Math.max(10, Math.min(500, Number(b.pageLimit ?? 50)));
  const apiKey = String(b.apiKey ?? "").trim();
  const cap = Number(b.cap ?? 0);
  const wantFetch = !!b.fetch;
  const siteId = String(b.siteId ?? "");

  if (!domain.includes(".")) return NextResponse.json({ error: "bad_domain" }, { status: 400 });

  const priceUsd = estimateDomainCost(keywordLimit, pageLimit);
  const usage = async () => {
    const u = await readUsage(userId, PROVIDER);
    return { ...u, spentUsd: u.units / UNITS_PER_USD };
  };

  // ── Our own side, when a site was given ──
  const site = siteId
    ? await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true, url: true } })
    : null;

  const ourQueries = async () => {
    const out = new Map<string, { position: number; url: string }>();
    if (!site) return out;
    try {
      const since = new Date();
      since.setDate(since.getDate() - GSC_LOOKBACK_DAYS);
      const rows = await prisma.dailyMetric.groupBy({
        by: ["query", "url"],
        where: { siteId: site.id, date: { gte: since } },
        _avg: { position: true },
      });
      for (const r of rows) {
        const q = String(r.query ?? "").trim().toLowerCase();
        if (!q) continue;
        const pos = Number(r._avg.position ?? 0);
        const prev = out.get(q);
        if (!prev || pos < prev.position) out.set(q, { position: pos, url: String(r.url ?? "") });
      }
    } catch { /* no GSC data — the comparison column simply stays empty */ }
    return out;
  };

  /**
   * Attach our own position to each of the domain's keywords. Only meaningful with a site, and
   * `ourPosition: null` there means Search Console has never shown us for it — the same reading
   * as everywhere else in Demand.
   */
  const decorate = async (keywords: any[]) => {
    const ours = await ourQueries();
    if (!ours.size) return keywords.map(k => ({ ...k, ourPosition: null, ourUrl: null, verdict: null }));
    return keywords.map(k => {
      const mine = ours.get(normalizeKeyword(k.keyword));
      const ourPosition = mine ? Math.round(mine.position * 10) / 10 : null;
      return {
        ...k,
        ourPosition,
        ourUrl: mine?.url ?? null,
        verdict: ourPosition == null ? "none" : ourPosition <= REACH_POSITION ? "reach" : "wrong_page",
      };
    });
  };

  // ── Cache ──
  const cacheKey = `${domain}|${country}|${language}`;

  const readCache = async () => {
    try {
      const rows: any[] = await rawQuery(
        `SELECT rows, createdAt FROM "DemandSearch" WHERE userId = ? AND cacheKey = ?`,
        userId, `domain:${cacheKey}`,
      );
      const hit = rows?.[0];
      if (!hit) return null;
      if (Date.now() - new Date(hit.createdAt).getTime() > OVERVIEW_TTL_DAYS * 86_400_000) return null;
      return { data: JSON.parse(hit.rows), at: new Date(hit.createdAt).toISOString() };
    } catch { return null; }
  };

  const writeCache = async (data: unknown) => {
    try {
      await runUpsert({
        table: "DemandSearch",
        conflict: ["userId", "cacheKey"],
        values: {
          userId, cacheKey: `domain:${cacheKey}`, seed: domain, country, language,
          mode: "domain", source: "labs",
          rows: JSON.stringify(data), createdAt: new Date().toISOString(),
        },
        update: { rows: "set", createdAt: "set" },
      });
    } catch { /* best effort */ }
  };

  // ── Free read ──
  if (!wantFetch || !apiKey) {
    const cached = await readCache();
    // Domain Rating and referring domains come from a different source entirely (the free
    // `/api/dr` endpoint and the Ahrefs cache), so they are worth surfacing even when nobody has
    // ever paid for a Demand overview of this domain.
    const known = await readDomainCache([domain], "ahrefs");
    return NextResponse.json({
      domain, country, language,
      summary: cached?.data?.summary ?? null,
      keywords: cached ? await decorate(cached.data.keywords ?? []) : [],
      pages: cached?.data?.pages ?? [],
      known: known[domain] ?? null,
      cachedAt: cached?.at ?? null,
      priceUsd,
      labsOnly: providerFor(country) === "google_ads",
      usage: await usage(),
      ...(wantFetch && !apiKey ? { error: "no_key" } : {}),
    });
  }

  if (providerFor(country) === "google_ads") {
    return NextResponse.json({
      domain, country, error: "labs_only", labsOnly: true, priceUsd, usage: await usage(),
    }, { status: 400 });
  }

  // ── Paid fetch ──
  const units = toUnits(priceUsd);
  if (!(await withinCap(userId, PROVIDER, units, cap))) {
    const cached = await readCache();
    return NextResponse.json({
      domain, country, language,
      summary: cached?.data?.summary ?? null,
      keywords: cached ? await decorate(cached.data.keywords ?? []) : [],
      pages: cached?.data?.pages ?? [],
      error: "cap_exceeded", wouldSpendUsd: priceUsd, priceUsd,
      usage: await usage(),
    }, { status: 429 });
  }

  const res = await domainOverview(apiKey, domain, { gl: country, hl: language, keywordLimit, pageLimit });

  if (res.error && !res.summary.organicKeywords) {
    return NextResponse.json({
      domain, country, error: res.error, priceUsd, usage: await usage(),
    }, { status: 502 });
  }

  await recordUsage(userId, PROVIDER, toUnits(res.cost || priceUsd));
  await writeCache({ summary: res.summary, keywords: res.keywords, pages: res.pages });

  // The two shared caches get filled as a side effect, so this purchase also improves screens
  // that never call this route: DR badges and the Backlinks panel read DomainMetricCache, and
  // Striking Distance reads KeywordMetricCache.
  await writeDomainCache(
    [{ domain, orgTraffic: res.summary.organicTraffic, orgKeywords: res.summary.organicKeywords }],
    PROVIDER, "api",
  );
  await writeKeywordCache(
    res.keywords.map(k => ({ keyword: k.keyword, volume: k.volume, difficulty: k.difficulty, cpc: k.cpc })),
    country, PROVIDER, "api",
  );

  return NextResponse.json({
    domain, country, language,
    summary: res.summary,
    keywords: await decorate(res.keywords),
    pages: res.pages,
    spentUsd: res.cost,
    priceUsd,
    usage: await usage(),
    ...(res.error ? { warning: res.error } : {}),
  });
}
