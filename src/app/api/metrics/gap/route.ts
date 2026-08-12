import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import {
  fetchOrganicCompetitors, fetchOrganicKeywords,
  estimateCompetitorUnits, estimateOrganicKeywordUnits,
  SEMRUSH_COMPETITOR_UNITS_PER_ROW, SEMRUSH_ORGANIC_KEYWORD_UNITS_PER_ROW,
  DEFAULT_BASE_URL, MetricsProvider,
} from "@/lib/seo/metrics";
import { readUsage, recordUsage, releaseUnusedUnits, withinCap, learnFieldSupport, unsupportedFields } from "@/lib/seo/metricsStore";
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
  const userId = await workspaceUserId("spend");
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
  // The host is what a field verdict belongs to: an official key and a reseller key are different
  // gateways with different coverage, and one must not speak for the other.
  const gatewayHost = (baseUrl || DEFAULT_BASE_URL[provider]).replace(/\/+$/, "");
  const ORGANIC_ENDPOINT = "site-explorer/organic-keywords";

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
      // So the screen can stop offering — and stop charging for — a column this gateway does not
      // forward. Empty means "nothing known against it", which is the assume-it-works default.
      unsupported: [...await unsupportedFields(gatewayHost, ORGANIC_ENDPOINT)],
      ...extra,
    }, { status });
  };

  if (action === "read" || !apiKey) {
    return respond(action !== "read" && !apiKey ? { error: "no_key" } : {});
  }

  // ── Discover competitors ──
  if (action === "competitors") {
    const limit = Math.max(5, Math.min(50, Number(b.limit ?? 20)));
    // Semrush prices `domain_organic_organic` at a flat 40 units/line regardless of columns —
    // the Ahrefs per-field formula would under-quote it, and a cap that lets the cheaper price
    // through is the one failure mode here (the call lands and the real bill breaches the cap).
    const units = provider === "semrush"
      ? SEMRUSH_COMPETITOR_UNITS_PER_ROW * limit
      : estimateCompetitorUnits(limit);
    if (!(await withinCap(userId, provider, units, cap))) {
      return respond({ error: "cap_exceeded", wouldSpend: units }, 429);
    }
    await recordUsage(userId, provider, units);

    try {
      const res = await fetchOrganicCompetitors({ provider, apiKey, baseUrl }, norm(site.url), { limit, country });
      if (res.error) return respond({ error: res.error }, 502);
      // Reserved `limit` competitors, billed for the ones that came back. Ahrefs returns far
      // fewer for a small domain, and the unused reservation must not eat the monthly cap.
      // Priced with the same formula the reservation used, or the refund would be computed at
      // Ahrefs rates against a Semrush charge and hand back the wrong amount.
      const got = Math.max(1, res.items.length);
      await releaseUnusedUnits(userId, provider, units, provider === "semrush"
        ? SEMRUSH_COMPETITOR_UNITS_PER_ROW * got
        : estimateCompetitorUnits(got));
      // Returned, not stored: this list is a menu the user picks from, and the expensive step is
      // the next one. Persisting it would suggest work has been done that has not.
      return respond({ units, found: res.items });
    } catch (e: any) {
      // A thrown error is a bug or a provider change, not an empty result. Surfacing it as a
      // message beats a silent 500 where the UI shows nothing and the user re-clicks to no effect.
      return respond({ error: `internal: ${String(e?.message ?? e).slice(0, 300)}` }, 500);
    }
  }

  // ── Pull one competitor's keywords ──
  if (action === "keywords") {
    const competitor = norm(String(b.competitor ?? ""));
    if (!competitor.includes(".")) return NextResponse.json({ error: "bad_competitor" }, { status: 400 });
    if (competitor === norm(site.url)) return NextResponse.json({ error: "self" }, { status: 400 });

    const limit = Math.max(50, Math.min(1000, Number(b.limit ?? 200)));
    const withDifficulty = !!b.withDifficulty;
    const maxPosition = Math.max(1, Math.min(100, Number(b.maxPosition ?? 20)));

    // Semrush `domain_organic` is 10 units/line flat; Ahrefs' per-field formula matches that when
    // KD is off and exceeds it when KD is on (10 extra). Using the provider's own rate keeps the
    // cap check honest either way.
    const units = provider === "semrush"
      ? SEMRUSH_ORGANIC_KEYWORD_UNITS_PER_ROW * limit
      : estimateOrganicKeywordUnits(limit, withDifficulty);
    if (!(await withinCap(userId, provider, units, cap))) {
      return respond({ error: "cap_exceeded", wouldSpend: units }, 429);
    }
    await recordUsage(userId, provider, units);

    let res;
    try {
      res = await fetchOrganicKeywords({ provider, apiKey, baseUrl }, competitor, {
        limit, country, withDifficulty, maxPosition,
      });
    } catch (e: any) {
      // Same rationale as the competitors block: a throw here is a bug, and a silent 500 reads as
      // "nothing happened" — exactly the symptom that sent this route here in the first place.
      return respond({ error: `internal: ${String(e?.message ?? e).slice(0, 300)}` }, 500);
    }
    if (res.error) return respond({ error: res.error }, 502);

    // A provider that answers "no keywords" is not the same thing as a tool nobody has used yet,
    // and until now both rendered as the same neutral "nothing loaded" panel. For a small or new
    // competitor Ahrefs legitimately returns an empty organic list — but the pull was already
    // charged in full, so leaving the screen unchanged means the user pays, learns nothing, and
    // presses again. Said out loud instead, naming the two filters that usually explain it.
    // Priced at `limit` rows, billed at what arrived. Done before the early return too: an empty
    // answer is the case where the gap between reserved and actual is largest, and charging the
    // full pull for zero rows is what made this screen feel like it was eating money.
    // Learn what this gateway actually forwards. `difficulty` is the field that costs extra, so
    // it is the one worth checking: 200 rows came back with it null on a pull priced *with* the
    // surcharge, which is money spent on a column the host does not proxy.
    if (withDifficulty) {
      await learnFieldSupport(gatewayHost, ORGANIC_ENDPOINT, ["difficulty"], res.items as any[],
        { witnessField: "volume", minRows: 20 });
    }

    const gotKw = Math.max(1, res.items.length);
    await releaseUnusedUnits(userId, provider, units, provider === "semrush"
      ? SEMRUSH_ORGANIC_KEYWORD_UNITS_PER_ROW * gotKw
      : estimateOrganicKeywordUnits(gotKw, withDifficulty));

    if (!res.items.length) {
      return respond({ error: "no_competitor_keywords", competitor, maxPosition: 20 }, 200);
    }

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
