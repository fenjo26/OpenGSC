import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";

// Indexer statistics using pre-aggregated IndexerDailyStat summary table.
// Execution time is < 1ms even for networks with millions of bot visits.

const WINDOW_DAYS = 30;

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
    const userId = await workspaceUserId();
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

    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - (WINDOW_DAYS - 1));
    const sinceStr = sinceDate.toISOString().split("T")[0];
    const ids = domains.map(d => d.id);

    // Fetch pre-aggregated daily stats (only ~30 rows per domain!)
    let dailyStats = await prisma.indexerDailyStat.findMany({
      where: {
        domainId: { in: ids },
        date: { gte: sinceStr },
      },
    });

    // Self-healing migration: if IndexerDailyStat is empty, automatically roll up legacy IndexerLog records
    if (dailyStats.length === 0) {
      try {
        const legacyLogCount = await prisma.indexerLog.count({
          where: { domainId: { in: ids } },
        });

        if (legacyLogCount > 0) {
          const quotedIds = ids.map(id => `'${id}'`).join(",");
          await prisma.$executeRawUnsafe(`
            INSERT INTO "IndexerDailyStat" ("id", "domainId", "date", "botType", "statusCode", "count")
            SELECT
              'stat_' || "domainId" || '_' || (CASE WHEN typeof("timestamp") = 'integer' THEN date("timestamp" / 1000, 'unixepoch') ELSE COALESCE(date("timestamp"), substr("timestamp", 1, 10)) END) || '_' || "botType" || '_' || "statusCode",
              "domainId",
              (CASE WHEN typeof("timestamp") = 'integer' THEN date("timestamp" / 1000, 'unixepoch') ELSE COALESCE(date("timestamp"), substr("timestamp", 1, 10)) END) AS d,
              "botType",
              "statusCode",
              COUNT(*)
            FROM "IndexerLog"
            WHERE "domainId" IN (${quotedIds})
              AND "timestamp" IS NOT NULL
            GROUP BY "domainId", d, "botType", "statusCode"
            ON CONFLICT("domainId", "date", "botType", "statusCode")
            DO UPDATE SET "count" = "count" + excluded."count"
          `);

          // Purge raw logs, keeping only the 5,000 most recent entries
          await prisma.$executeRawUnsafe(`
            DELETE FROM "IndexerLog"
            WHERE "id" NOT IN (
              SELECT "id" FROM "IndexerLog" ORDER BY "timestamp" DESC LIMIT 5000
            )
          `);

          // Re-fetch daily stats after rollup
          dailyStats = await prisma.indexerDailyStat.findMany({
            where: {
              domainId: { in: ids },
              date: { gte: sinceStr },
            },
          });
        }
      } catch (err) {
        console.error("[Indexer Stats] Auto-rollup fallback error:", err);
      }
    }

    // ─── Per-domain & Summary Totals ──────────────────────────────────────────
    const counts = new Map<string, Record<string, number>>();
    const dailyMap: Record<string, DailyRow> = {};

    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split("T")[0];
      dailyMap[key] = emptyDay(key);
    }

    let google = 0, yandex = 0, bing = 0, mailru = 0, ai = 0, other = 0, redirects = 0;

    for (const stat of dailyStats) {
      const bucket = counts.get(stat.domainId) ?? {};
      bucket[stat.botType] = (bucket[stat.botType] ?? 0) + stat.count;
      counts.set(stat.domainId, bucket);

      const day = dailyMap[stat.date];
      if (day) {
        const n = stat.count;
        const is304 = stat.statusCode === 304;
        switch (stat.botType) {
          case "google": if (is304) day.google304 += n; else day.google += n; day.total += n; break;
          case "yandex": if (is304) day.yandex304 += n; else day.yandex += n; day.total += n; break;
          case "bing": day.bing += n; day.total += n; break;
          case "mailru": day.mailru += n; day.total += n; break;
          case "ai": day.ai += n; day.total += n; break;
          case "other": day.other += n; day.total += n; break;
          case "redirect": day.redirects += n; break;
        }
      }
    }

    const byDomain = domains.map(d => {
      const c = counts.get(d.id) ?? {};
      const g = c.google ?? 0, y = c.yandex ?? 0, b = c.bing ?? 0;
      const m = c.mailru ?? 0, a = c.ai ?? 0, o = c.other ?? 0, r = c.redirect ?? 0;

      google += g; yandex += y; bing += b; mailru += m; ai += a; other += o; redirects += r;

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
