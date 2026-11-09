import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { extAuth, extPreflight, extTablesMissing } from "@/lib/ext/auth";
import { addKeywords } from "@/lib/serpmon/store";
import { schemaMissing } from "@/lib/serpmon/store";
import { apexOf } from "@/lib/drops/registries";
import { createRun, setWatchedByDomains } from "@/lib/drops/store";
import { validateLocation } from "@/lib/seo/localPack";
import type { SerpAction, SerpActionResponse } from "@/lib/ext/types";

// POST /api/ext/serp/action — the overlay's buttons: track the query in Rank Tracker, add it to
// a SERP Monitor project, or put a host on drops-watch. One body shape per `kind`, all local
// writes, the same normalization the respective UI routes use.

export async function POST(req: Request) {
  const auth = await extAuth(req, "write");
  if (!auth.ok) return auth.response;

  let body: SerpAction;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: auth.auth.cors });
  }

  try {
    if (body?.kind === "rank_track") {
      const site = await prisma.site.findFirst({
        where: { id: String(body.siteId ?? ""), userId: auth.auth.userId },
        select: { id: true },
      });
      if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404, headers: auth.auth.cors });

      // the same normalization POST /api/rank/keywords applies
      const keyword = String(body.query ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
      if (!keyword) return NextResponse.json({ error: "no_keywords" }, { status: 400, headers: auth.auth.cors });
      const country = (String(body.country ?? "us").trim().toLowerCase() || "us").slice(0, 2);
      const lang = (String(body.lang ?? "en").trim().toLowerCase() || "en").slice(0, 5);
      const device = body.device === "mobile" ? "mobile" : "desktop";
      const locCheck = validateLocation(undefined);
      const location = locCheck.ok ? locCheck.value : "";

      try {
        const k = await prisma.trackedKeyword.create({
          data: { siteId: site.id, keyword, country, lang, device, location },
          select: { id: true },
        });
        const out: SerpActionResponse = { ok: true, kind: "rank_track", added: true, keywordId: k.id };
        return NextResponse.json(out, { headers: auth.auth.cors });
      } catch {
        // the @@unique (siteId, keyword, device, country, location) fired — already tracked
        const existing = await prisma.trackedKeyword.findFirst({
          where: { siteId: site.id, keyword, device, country, location },
          select: { id: true },
        });
        const out: SerpActionResponse = { ok: true, kind: "rank_track", added: false, keywordId: existing?.id ?? null };
        return NextResponse.json(out, { headers: auth.auth.cors });
      }
    }

    if (body?.kind === "serpmon_keyword") {
      const result = await addKeywords(auth.auth.userId, String(body.projectId ?? ""), String(body.query ?? ""), "add");
      if (!result) return NextResponse.json({ error: "project_not_found" }, { status: 404, headers: auth.auth.cors });
      const out: SerpActionResponse = { ok: true, kind: "serpmon_keyword", added: result.added > 0 };
      return NextResponse.json(out, { headers: auth.auth.cors });
    }

    if (body?.kind === "drops_watch") {
      const domain = apexOf(String(body.host ?? ""));
      if (!domain) return NextResponse.json({ error: "invalid_host" }, { status: 400, headers: auth.auth.cors });
      const existing = await prisma.dropCandidate.findFirst({
        where: { userId: auth.auth.userId, domain },
        select: { id: true },
      });
      let inserted = false;
      if (!existing) {
        const run = await createRun(auth.auth.userId, { raw: domain, label: "extension", source: "csv" });
        inserted = true;
        void run;
      }
      await setWatchedByDomains(auth.auth.userId, [domain], true);
      const out: SerpActionResponse = { ok: true, kind: "drops_watch", inserted, watched: true, domain };
      return NextResponse.json(out, { headers: auth.auth.cors });
    }

    return NextResponse.json({ error: "bad_action" }, { status: 400, headers: auth.auth.cors });
  } catch (e) {
    if (extTablesMissing(e) || schemaMissing(e)) {
      return NextResponse.json({ error: "not_migrated" }, { status: 200, headers: auth.auth.cors });
    }
    throw e;
  }
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
