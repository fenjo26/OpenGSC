import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Indexer statistics.
//
// PERFORMANCE NOTE. This route used to `include` every IndexerLog row for every domain — with no
// date filter — and then count them in JavaScript. On an active network that is hundreds of
// thousands of rows hydrated into Prisma objects on every page open, to produce about forty
// numbers. The 30-day cutoff existed only as an `if` inside the loop, so the
// `@@index([domainId, timestamp])` the schema already declares was never used.
//
// Everything is now aggregated in SQL behind that index: the database returns one row per
// (domain, bot) and per (day, bot, 304) instead of one row per crawler hit.

const WINDOW_DAYS = 30;

// Short-lived in-memory cache. The app runs as a single PM2 process (see docs/ARCHITECTURE.md), so
// a module-level map is the whole mechanism — no store to configure, nothing to invalidate on
// deploy. Bot logs arrive continuously and nobody needs second-accurate totals; `?refresh=1`
// bypasses it for an explicit refresh.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; payload: unknown }>();

type DailyRow = {
  date: string; google: number; google304: number; yandex: number; yandex304: number;
  bing: number; mailru: number; ai: number; other: number; total: number; redirects: number;
};

const emptyDay = (date: string): DailyRow => ({
  date, google: 0, google304: 0, yandex: 0, yandex304: 0,
  bing: 0, mailru: 0, ai: 0, other: 0, total: 0, redirects: 0,
});

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id as string | undefined;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const refresh = new URL(req.url).searchParams.get("refresh") === "1";
    const hit = cache.get(userId);
    if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return NextResponse.json(hit.payload);
    }

    const domains = await prisma.indexerDomain.findMany({
      where: { userId },
      select: { id: true, domain: true, status: true, pagesCount: true, subdomainsCount: true },
    });

    if (domains.length === 0) {
      const empty = {
        summary: { google: 0, yandex: 0, bing: 0, mailru: 0, ai: 0, other: 0, redirects: 0 },
        byDomain: [], daily: [],
      };
      cache.set(userId, { at: Date.now(), payload: empty });
      return NextResponse.json(empty);
    }

    const since = new Date();
    since.setDate(since.getDate() - (WINDOW_DAYS - 1));
    since.setHours(0, 0, 0, 0);
    const ids = domains.map(d => d.id);

    // ─── Per-domain totals ────────────────────────────────────────────────────
    // One grouped query replaces loading every row. This counts a Google 304 as a Google hit,
    // matching the previous behaviour — the 304 split exists only in the daily table below.
    const perDomain = await prisma.indexerLog.groupBy({
      by: ["domainId", "botType"],
      where: { domainId: { in: ids }, timestamp: { gte: since } },
      _count: { _all: true },
    });

    const counts = new Map<string, Record<string, number>>();
    for (const row of perDomain) {
      const bucket = counts.get(row.domainId) ?? {};
      bucket[row.botType] = (bucket[row.botType] ?? 0) + row._count._all;
      counts.set(row.domainId, bucket);
    }

    let google = 0, yandex = 0, bing = 0, mailru = 0, ai = 0, other = 0, redirects = 0;

    const byDomain = domains.map(d => {
      const c = counts.get(d.id) ?? {};
      const g = c.google ?? 0, y = c.yandex ?? 0, b = c.bing ?? 0;
      const m = c.mailru ?? 0, a = c.ai ?? 0, o = c.other ?? 0, r = c.redirect ?? 0;

      google += g; yandex += y; bing += b; mailru += m; ai += a; other += o; redirects += r;

      // Redirects are humans bounced to the money site, not crawls — excluded, as before.
      const totalBots = g + y + b + m + a + o;
      return {
        id: d.id,
        domain: d.domain,
        status: d.status,
        google: g,
        ai: a,
        totalBots,
        googleShare: totalBots > 0 ? Math.round((g / totalBots) * 100) : 0,
        pagesCount: d.pagesCount,
        subdomainsCount: d.subdomainsCount,
      };
    });
    byDomain.sort((x, y2) => y2.totalBots - x.totalBots);

    // ─── Daily breakdown ──────────────────────────────────────────────────────
    // Raw SQL because day bucketing needs a date function Prisma's groupBy cannot express. The
    // typeof() switch handles both ways a DateTime can sit in SQLite (integer milliseconds or an
    // ISO string), so this keeps working if the column representation ever differs.
    const dailyMap: Record<string, DailyRow> = {};
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split("T")[0];
      dailyMap[key] = emptyDay(key);
    }

    try {
      const rows = await prisma.$queryRaw<{ day: string; botType: string; is304: number; c: bigint | number }[]>`
        SELECT
          strftime('%Y-%m-%d',
            CASE WHEN typeof("timestamp") = 'integer' THEN "timestamp" / 1000
                 ELSE strftime('%s', "timestamp") END,
            'unixepoch') AS day,
          "botType" AS botType,
          CASE WHEN "statusCode" = 304 THEN 1 ELSE 0 END AS is304,
          COUNT(*) AS c
        FROM "IndexerLog"
        WHERE "domainId" IN (SELECT "id" FROM "IndexerDomain" WHERE "userId" = ${userId})
          AND "timestamp" >= ${since}
        GROUP BY day, botType, is304`;

      for (const row of rows) {
        const day = dailyMap[row.day];
        if (!day) continue;
        const n = Number(row.c);
        const is304 = Number(row.is304) === 1;
        switch (row.botType) {
          case "google": if (is304) day.google304 += n; else day.google += n; day.total += n; break;
          case "yandex": if (is304) day.yandex304 += n; else day.yandex += n; day.total += n; break;
          case "bing": day.bing += n; day.total += n; break;
          case "mailru": day.mailru += n; day.total += n; break;
          case "ai": day.ai += n; day.total += n; break;
          case "other": day.other += n; day.total += n; break;
          case "redirect": day.redirects += n; break;
        }
      }
    } catch (e) {
      // Degrade rather than 500 the page: the summary and per-domain tables are already computed,
      // so an unavailable daily chart is a partial view, not a broken one.
      console.error("[Indexer Stats] daily aggregation failed", e);
    }

    const payload = {
      summary: { google, yandex, bing, mailru, ai, other, redirects },
      byDomain,
      daily: Object.values(dailyMap).sort((a, b) => b.date.localeCompare(a.date)),
    };
    cache.set(userId, { at: Date.now(), payload });
    return NextResponse.json(payload);
  } catch (e: any) {
    console.error("[Indexer Stats Error]", e);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
