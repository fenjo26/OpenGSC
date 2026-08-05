import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  fetchOrganicCompetitors, fetchOrganicKeywords,
  estimateCompetitorUnits, estimateOrganicKeywordUnits, MetricsProvider,
} from "@/lib/seo/metrics";
import { readUsage, recordUsage, withinCap } from "@/lib/seo/metricsStore";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery, rawExec } from "@/lib/db/raw";

// POST /api/metrics/gap { siteId, action, ... }
//
//   action "read"        — the stored gap, free. What an unconfigured install sees.
//   action "competitors" — discover who ranks for the same things (cheap: 1 unit a row).
//   action "keywords"    — pull one competitor's organic keywords (the expensive part).
//
// The gap itself is computed here on every read rather than stored, because it is a join
// between slow-moving competitor data and the user's own GSC numbers, which change daily.
// Freezing the join would mean re-buying competitor keywords every time your own rank moved.

const norm = (d: string) =>
  d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/^www\./, "").split("/")[0];

interface GapRow {
  keyword: string;
  competitor: string;
  competitorPosition: number | null;
  volume: number | null;
  difficulty: number | null;
  competitorUrl: string;
  /** Our own best position from GSC, or null when we do not rank for it at all. */
  ourPosition: number | null;
  ourUrl: string | null;
  ourImpressions: number;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true, url: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const action = String(b.action ?? "read");
  const country = String(b.country ?? "us").toLowerCase();
  const provider = (b.provider === "semrush" ? "semrush" : "ahrefs") as MetricsProvider;
  const apiKey = String(b.apiKey ?? "").trim();
  const baseUrl = String(b.baseUrl ?? "").trim() || undefined;
  const cap = Number(b.cap ?? 0);

  // ── Read: the stored competitor keywords, joined against our own GSC performance ──
  const buildGap = async (): Promise<{ rows: GapRow[]; competitors: string[] }> => {
    let stored: any[] = [];
    try {
      stored = await rawQuery(
        `SELECT competitor, keyword, position, volume, difficulty, url
           FROM "CompetitorKeyword" WHERE siteId = ? AND country = ?
          ORDER BY volume DESC LIMIT 3000`,
        site.id, country,
      );
    } catch { return { rows: [], competitors: [] }; }
    if (!stored.length) return { rows: [], competitors: [] };

    // Our own side comes from GSC, which knows about queries we have ever been shown for —
    // including ones we rank 40th on. That is the whole point: "they rank, we have a page but
    // it is buried" is a different task from "we have nothing", and only this join separates them.
    const ours = new Map<string, { position: number; url: string; impressions: number }>();
    try {
      const since = new Date();
      since.setDate(since.getDate() - 90);
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
        const prev = ours.get(q);
        if (!prev || pos < prev.position) {
          ours.set(q, { position: pos, url: String(r.url ?? ""), impressions: Number(r._sum.impressions ?? 0) });
        }
      }
    } catch { /* no GSC data yet — every row simply reads as "we don't rank" */ }

    const rows: GapRow[] = stored.map(r => {
      const mine = ours.get(String(r.keyword));
      return {
        keyword: r.keyword,
        competitor: r.competitor,
        competitorPosition: r.position == null ? null : Number(r.position),
        volume: r.volume == null ? null : Number(r.volume),
        difficulty: r.difficulty == null ? null : Number(r.difficulty),
        competitorUrl: r.url ?? "",
        ourPosition: mine ? Math.round(mine.position * 10) / 10 : null,
        ourUrl: mine?.url ?? null,
        ourImpressions: mine?.impressions ?? 0,
      };
    });

    const competitors = [...new Set(stored.map(r => String(r.competitor)))];
    return { rows, competitors };
  };

  const respond = async (extra: Record<string, unknown> = {}, status = 200) => {
    const { rows, competitors } = await buildGap();
    return NextResponse.json({
      target: norm(site.url), country, rows, competitors,
      usage: await readUsage(userId, provider),
      ...extra,
    }, { status });
  };

  if (action === "read" || !apiKey) {
    return respond(action !== "read" && !apiKey ? { error: "no_key" } : {});
  }

  // ── Discover competitors ──
  if (action === "competitors") {
    const limit = Math.max(5, Math.min(50, Number(b.limit ?? 20)));
    const units = estimateCompetitorUnits(limit);
    if (!(await withinCap(userId, provider, units, cap))) {
      return respond({ error: "cap_exceeded", wouldSpend: units }, 429);
    }
    await recordUsage(userId, provider, units);

    const res = await fetchOrganicCompetitors({ provider, apiKey, baseUrl }, norm(site.url), { limit, country });
    if (res.error) return respond({ error: res.error }, 502);
    // Returned, not stored: this list is a menu the user picks from, and the expensive step is
    // the next one. Persisting it would suggest work has been done that has not.
    return respond({ units, found: res.items });
  }

  // ── Pull one competitor's keywords ──
  if (action === "keywords") {
    const competitor = norm(String(b.competitor ?? ""));
    if (!competitor.includes(".")) return NextResponse.json({ error: "bad_competitor" }, { status: 400 });
    if (competitor === norm(site.url)) return NextResponse.json({ error: "self" }, { status: 400 });

    const limit = Math.max(50, Math.min(1000, Number(b.limit ?? 200)));
    const withDifficulty = !!b.withDifficulty;
    const maxPosition = Math.max(1, Math.min(100, Number(b.maxPosition ?? 20)));

    const units = estimateOrganicKeywordUnits(limit, withDifficulty);
    if (!(await withinCap(userId, provider, units, cap))) {
      return respond({ error: "cap_exceeded", wouldSpend: units }, 429);
    }
    await recordUsage(userId, provider, units);

    const res = await fetchOrganicKeywords({ provider, apiKey, baseUrl }, competitor, {
      limit, country, withDifficulty, maxPosition,
    });
    if (res.error) return respond({ error: res.error }, 502);

    // Replace rather than merge: a keyword the competitor no longer ranks for should disappear
    // from the gap, and an upsert alone would keep it forever.
    try {
      await rawExec(
        `DELETE FROM "CompetitorKeyword" WHERE siteId = ? AND competitor = ? AND country = ?`,
        site.id, competitor, country,
      );
      for (const k of res.items) {
        await runUpsert({
          table: "CompetitorKeyword",
          conflict: ["siteId", "competitor", "keyword", "country"],
          values: {
            siteId: site.id, competitor, keyword: k.keyword, country,
            position: k.position ?? null, volume: k.volume ?? null,
            difficulty: k.difficulty ?? null, url: k.url,
            source: "api", fetchedAt: new Date().toISOString(),
          },
          // Difficulty is the one field kept rather than overwritten: it is optional on the
          // request and costs extra, so a pull made without it must not erase a value a previous
          // pull paid for.
          update: {
            position: "set", volume: "set", difficulty: "keep",
            url: "set", fetchedAt: "set",
          },
        });
      }
    } catch {
      return respond({ error: "not_migrated" }, 500);
    }

    // Written, then read straight back. If the provider returned keywords and the table still
    // reads empty, the write and the read are not looking at the same database — which is what
    // a relative `DATABASE_URL` produces: Prisma CLI resolves it against the schema directory,
    // the running app against its working directory, and the two quietly diverge into separate
    // files. Everything here would otherwise succeed in silence and the screen would show its
    // ordinary "nothing loaded yet" state, which is how this costs an afternoon to find.
    const after = await buildGap();
    if (res.items.length > 0 && after.rows.length === 0) {
      return respond({ error: "write_not_visible", imported: res.items.length, competitor }, 500);
    }

    return respond({ units, imported: res.items.length, competitor });
  }

  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}
