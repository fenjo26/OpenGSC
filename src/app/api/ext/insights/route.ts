import { NextResponse } from "next/server";
import { extAuth, extPreflight, extTablesMissing } from "@/lib/ext/auth";
import { footprintSchemaMissing } from "@/lib/footprint";
import { normalizePageUrl } from "@/lib/ext/urlMatch";
import { pageInsights } from "@/lib/ext/insights";
import type { InsightsRequest } from "@/lib/ext/types";

// POST /api/ext/insights — the panel's OpenGSC tab: the page's main GSC query vs title/H1,
// sitemap membership, free meta suggestions, footprint across the network. Reads only; the
// LLM path lives in /api/ext/meta-fit and needs its own confirm.

export async function POST(req: Request) {
  const auth = await extAuth(req, "read");
  if (!auth.ok) return auth.response;

  let body: Partial<InsightsRequest>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: auth.auth.cors });
  }
  if (!body || typeof body.url !== "string" || !normalizePageUrl(body.url)) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400, headers: auth.auth.cors });
  }

  const clean: InsightsRequest = {
    url: String(body.url).slice(0, 2000),
    title: String(body.title ?? "").slice(0, 500),
    description: String(body.description ?? "").slice(0, 500),
    h1: String(body.h1 ?? "").slice(0, 500),
  };

  try {
    const data = await pageInsights(auth.auth.userId, clean);
    return NextResponse.json(data, { headers: auth.auth.cors });
  } catch (e) {
    if (extTablesMissing(e) || footprintSchemaMissing(e)) {
      return NextResponse.json({ notMigrated: true }, { status: 200, headers: auth.auth.cors });
    }
    throw e;
  }
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
