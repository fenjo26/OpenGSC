import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { extAuth, extPreflight, extTablesMissing } from "@/lib/ext/auth";
import { matchPortfolioSite, normalizePageUrl, urlVariants } from "@/lib/ext/urlMatch";
import { parseIndexInspect } from "@/lib/indexing/inspect";
import { kickIndexScheduler } from "@/lib/indexing/scheduler";

// POST /api/ext/index-queue { url } — "Send to OpenGSC" on one of YOUR pages: push the URL to
// the front of the auto-inspection queue (wave-oct T4) by resetting SitemapUrl.googleNextCheck
// to now, then wake the loop so it runs within moments instead of at the next 10-minute tick.
// The extension never spends anything itself: the inspection draws on Google's free URL
// Inspection quota exactly as the October queue does, under the site's own daily budget.
//
// Right "act" — the queue equivalent of the October "check now" button.
// A foreign URL is a 404-ish answer, not an outreach action: the popup decides which of the
// two to offer, and the server keeps the two writes impossible to confuse.

export async function POST(req: Request) {
  const auth = await extAuth(req, "act");
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const nu = normalizePageUrl(String(body.url ?? ""));
  if (!nu) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400, headers: auth.auth.cors });
  }

  try {
    // indexInspect rides along for the auto-check test below; matchPortfolioSite only needs
    // the PortfolioSite shape, and the wider rows are assignable to it.
    const sites: ({ id: string; siteId: string; url: string; indexInspect: string | null })[] =
      await prisma.site.findMany({
        where: { userId: auth.auth.userId },
        select: { id: true, siteId: true, url: true, indexInspect: true },
      });
    const site = matchPortfolioSite(sites, nu);
    if (!site) {
      return NextResponse.json({ queued: false, reason: "not_in_portfolio", url: nu.href }, { headers: auth.auth.cors });
    }

    // With auto-check off there is no queue to prioritize — the reset would be a silent no-op,
    // and "queued" would be a lie. Say what would happen instead.
    if (!parseIndexInspect(site.indexInspect).on) {
      return NextResponse.json({ queued: false, reason: "auto_check_off", siteId: site.id }, { headers: auth.auth.cors });
    }

    // "Due now": a timestamp in the past qualifies on the next classifyPriority pass whatever
    // its comparison direction — the same convention a due date anywhere in the queue uses.
    const dueNow = new Date(Date.now() - 1_000);
    const updated = await prisma.sitemapUrl.updateMany({
      where: { siteId: site.id, url: { in: urlVariants(nu) }, inventoryStatus: "active" },
      data: { googleNextCheck: dueNow },
    });
    if (updated.count === 0) {
      return NextResponse.json({ queued: false, reason: "not_in_inventory", siteId: site.id }, { headers: auth.auth.cors });
    }

    kickIndexScheduler();
    return NextResponse.json({ queued: true, siteId: site.id, reset: updated.count }, { headers: auth.auth.cors });
  } catch (e) {
    if (extTablesMissing(e)) return NextResponse.json({ notMigrated: true }, { status: 200, headers: auth.auth.cors });
    throw e;
  }
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
