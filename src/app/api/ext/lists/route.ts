import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { extAuth, extPreflight, extTablesMissing } from "@/lib/ext/auth";
import { listProjects } from "@/lib/serpmon/store";
import type { ListsResponse } from "@/lib/ext/types";

// GET /api/ext/lists — the small catalogs the extension's options page needs: portfolio sites
// (id + label, the same label /api/ext/page shows) and SERP Monitor projects (id, name, market).
// Local reads only. A not-yet-migrated SerpProject table is not an error: the options page then
// offers free-text ID fields instead of the dropdowns.

export async function GET(req: Request) {
  const auth = await extAuth(req, "read");
  if (!auth.ok) return auth.response;

  try {
    const sites = await prisma.site.findMany({
      where: { userId: auth.auth.userId },
      select: { id: true, url: true },
      orderBy: { url: "asc" },
    });

    const body: ListsResponse = {
      sites: sites.map(s => ({
        id: s.id,
        label: s.url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/$/, ""),
      })),
      projects: [],
    };
    try {
      body.projects = (await listProjects(auth.auth.userId)).map(p => ({
        id: p.id, name: p.name, country: p.country, lang: p.lang,
      }));
    } catch {
      // SerpProject/SerpKeyword not migrated yet → projects: [] (the brief says exactly this)
    }

    return NextResponse.json(body, { headers: auth.auth.cors });
  } catch (e) {
    if (extTablesMissing(e)) {
      return NextResponse.json({ error: "not_migrated" }, { status: 200, headers: auth.auth.cors });
    }
    throw e;
  }
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
