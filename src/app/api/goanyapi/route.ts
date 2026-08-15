import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { goanyKeywordDifficulty, goanyBacklinks } from "@/lib/seo/goanyapi";

// POST /api/goanyapi — the two GoAnyAPI datasets that have no home of their own yet.
//
// Traffic has `/api/traffic`, SERP goes through `runSerp`, Domain Rating rides on `/api/dr`.
// Keyword difficulty and the backlink summary are the remainder: both are useful, neither fits an
// existing abstraction without distorting it, and both are therefore reachable here as plain
// lookups rather than being forced into a router that would then have to lie about them.
//
// Why they do not fit, briefly, because it is the kind of thing that gets "fixed" later by
// someone who does not know:
//
//   • Keyword difficulty is NOT a keyword-data source. `enrichKeywords` promises volume, KD and
//     CPC on a shared row type backed by a shared cache; this endpoint returns difficulty and
//     nothing else. Registering it as a `KwSource` would mean writing rows whose volume is null
//     into a cache other providers read, and "no volume" is indistinguishable from "no demand"
//     the moment it leaves this file.
//
//   • The backlink summary is NOT a backlink profile. `fetchBacklinkProfile` feeds
//     `syncRefDomains`, which decides what is LOST by diffing against the stored profile. This
//     endpoint returns a sample of top links with no pagination and no first-seen dates; diffing
//     a sample would report every referring domain outside it as lost. That is not a smaller
//     answer, it is a wrong one.
//
// Both spend credits, so both require an explicit call — nothing here runs on page load.

export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("act");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = (req.headers.get("x-goanyapi-key") || "").trim();
  if (!apiKey) return NextResponse.json({ error: "no_key" }, { status: 400 });

  const b = await req.json().catch(() => ({}));
  const op = String(b?.op ?? "");

  if (op === "kd") {
    const keyword = String(b?.keyword ?? "").trim();
    if (!keyword) return NextResponse.json({ error: "no_keyword" }, { status: 400 });
    const r = await goanyKeywordDifficulty(apiKey, keyword, String(b?.country ?? "us"));
    if (!r.data) return NextResponse.json({ error: r.error ?? "no_data" }, { status: 502 });
    return NextResponse.json({
      keyword: r.data.keyword,
      difficulty: r.data.difficulty,
      shortage: r.data.shortage,
      // Passed through rather than hidden: this SERP is served from a cache, and a difficulty
      // score computed from a week-old top ten deserves to be read as one.
      lastUpdate: r.data.lastUpdate,
      serp: r.data.rows.filter(x => x.type === "organic").slice(0, 10).map(x => ({
        position: x.position, url: x.url, title: x.title,
        domainRating: x.metrics?.domainRating ?? null,
        urlRating: x.metrics?.urlRating ?? null,
        traffic: x.metrics?.traffic ?? null,
      })),
      credits: r.credits,
      remainingCredits: r.remaining,
    });
  }

  if (op === "backlinks") {
    const domain = String(b?.domain ?? "").trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    if (!domain.includes(".")) return NextResponse.json({ error: "bad_domain" }, { status: 400 });
    const r = await goanyBacklinks(apiKey, domain);
    if (!r.data) return NextResponse.json({ error: r.error ?? "no_data" }, { status: 502 });
    return NextResponse.json({
      ...r.data,
      // The one thing this source knows that Ahrefs does not: whether a link survives without
      // JavaScript. A link only present after rendering is a link Google may never count, and
      // counting it as equal to a server-rendered one overstates a profile.
      renderOnlyLinks: r.data.topBacklinks.filter(l => l.inRendered && !l.inRaw).length,
      credits: r.credits,
      remainingCredits: r.remaining,
    });
  }

  return NextResponse.json({ error: `unknown op "${op}" — expected "kd" or "backlinks"` }, { status: 400 });
}
