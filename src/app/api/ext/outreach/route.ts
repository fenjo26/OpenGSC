import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { extAuth, extPreflight, extTablesMissing } from "@/lib/ext/auth";
import { matchPortfolioSite, normalizePageUrl } from "@/lib/ext/urlMatch";
import { createOutreachProspect } from "@/lib/outreach/service";

// POST /api/ext/outreach { url, note? } — "Send to OpenGSC" on somebody ELSE'S page: save it
// as an Outreach prospect through the exact service the MCP tool save_outreach_prospect uses
// (local write only: no fetch, no message, no spend; saving the same domain again returns the
// existing row). A portfolio URL is rejected with "own_site" — the popup decides which of the
// two send paths to offer, and the server keeps a link campaign from ever ingesting the
// operator's own site by mistake.

export async function POST(req: Request) {
  const auth = await extAuth(req, "act");
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const nu = normalizePageUrl(String(body.url ?? ""));
  if (!nu) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400, headers: auth.auth.cors });
  }
  const note = String(body.note ?? "").slice(0, 2000);

  try {
    const sites = await prisma.site.findMany({
      where: { userId: auth.auth.userId },
      select: { id: true, siteId: true, url: true },
    });
    if (matchPortfolioSite(sites, nu)) {
      return NextResponse.json({ error: "own_site" }, { status: 400, headers: auth.auth.cors });
    }

    const result = await createOutreachProspect(auth.auth.userId, {
      domain: nu.host,
      sourceUrl: nu.href,
      notes: note,
    });
    return NextResponse.json({ ok: true, created: result.created, prospect: result.prospect }, { headers: auth.auth.cors });
  } catch (e) {
    if (extTablesMissing(e)) return NextResponse.json({ notMigrated: true }, { status: 200, headers: auth.auth.cors });
    // The service throws short machine codes (campaign_not_found, prospect_domain_required…);
    // pass them through — the popup maps them to one honest sentence.
    const message = String((e as { message?: string })?.message ?? e ?? "");
    if (/prospect_domain_required|invalid_source_url/.test(message)) {
      return NextResponse.json({ error: message }, { status: 400, headers: auth.auth.cors });
    }
    throw e;
  }
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
