import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import {
  estimateSerpIndexCheck, serpIndexCheckUrls, listSerpIndexRows,
  SERP_INDEX_MAX_URLS, type SerpIndexRow,
} from "@/lib/indexing/serpIndex";

// site: index estimation (N6) — for URLs Google's URL Inspection cannot reach (drops, foreign
// sites, PBN domains without a verified property).
//
//   GET  ?siteId=            — read. The panel's table (rows with site: verdicts) plus the
//                               URLs a run would target (never inspected by Google).
//   POST { urls[], confirm }  — spend. confirm absent → price only, no query sent; confirm true
//                               → run, and persist verdicts into SitemapUrl.serpIndex* for the
//                               URLs that belong to this user's sites.
//
// A captcha or auth failure is `error`, never `not_indexed` — the same rule SERP Monitor runs on.

/** SitemapUrl predates this feature, but an instance that pulled the code without `db push`
 *  still lacks the serpIndex* columns: that is `notMigrated`, not a 500. */
function serpIndexColumnsMissing(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" || value?.code === "P2022" ||
    /SitemapUrl.*(?:does not exist|no such table|no such column)|(?:does not exist|no such table|no such column).*SitemapUrl|serpIndex.*no such column/i.test(String(value?.message ?? ""))
  );
}

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const siteId = new URL(req.url).searchParams.get("siteId") ?? "";
  if (!siteId) return NextResponse.json({ error: "no_site" }, { status: 400 });

  // The table on the panel's card belongs to one of the user's own sites (a sitemap inventory
  // row). A foreign URL — a drop, someone else's page — never comes through GET: it goes
  // straight to POST, where it is checked and returned without any persistence.
  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });

  try {
    const { rows, pendingUrls } = await listSerpIndexRows(siteId);
    return NextResponse.json({ rows, pendingUrls });
  } catch (e) {
    if (serpIndexColumnsMissing(e)) return NextResponse.json({ notMigrated: true });
    console.error("[serp-check:list]", e);
    return NextResponse.json({ error: "list_failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const urls: string[] = Array.isArray(b.urls) ? b.urls.map((u: unknown) => String(u ?? "").trim()).filter(Boolean) : [];
  if (!urls.length) return NextResponse.json({ error: "no_urls" }, { status: 400 });
  if (urls.length > SERP_INDEX_MAX_URLS) {
    return NextResponse.json({ error: "too_many_urls", limit: SERP_INDEX_MAX_URLS }, { status: 400 });
  }

  try {
    // Estimate branch: provider, count, price — and NOT ONE SERP query (CONTRACT.md §0.5).
    if (b.confirm !== true) {
      const est = await estimateSerpIndexCheck(userId, urls);
      if (est.error) return NextResponse.json(est, { status: 400 });
      return NextResponse.json(est);
    }

    const out = await serpIndexCheckUrls(userId, urls, { cap: b.cap });
    if (!out.ok && out.error === "no_serp_key") {
      return NextResponse.json({ error: "no_serp_key" }, { status: 400 });
    }
    if (!out.ok && out.error === "cap_exceeded") {
      return NextResponse.json({ error: "cap_exceeded", wouldSpendUsd: out.costUsd, provider: out.provider }, { status: 429 });
    }
    if (!out.ok && out.error === "provider_failed") {
      // Provider down: per-URL error rows ride along, but the response says what happened.
      return NextResponse.json(
        { error: "provider_failed", detail: out.detail ?? "", provider: out.provider, results: out.results },
        { status: 502 },
      );
    }

    const rows: SerpIndexRow[] = out.results.map((r) => ({
      url: r.url,
      googleChecked: null,
      googleStatus: null,
      serpIndexStatus: r.status,
      serpIndexChecked: new Date().toISOString(),
      serpIndexProvider: r.provider,
    }));
    const counts = out.results.reduce(
      (acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; },
      {} as Record<string, number>,
    );
    return NextResponse.json({
      ok: true,
      provider: out.provider,
      queries: out.queries,
      attempted: out.attempted,
      errors: out.errors,
      costUsd: out.costUsd,
      counts,
      results: out.results,
      rows,
    });
  } catch (e) {
    if (serpIndexColumnsMissing(e)) return NextResponse.json({ notMigrated: true });
    console.error("[serp-check:run]", e);
    return NextResponse.json({ error: "check_failed" }, { status: 500 });
  }
}
