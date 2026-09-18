import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { schemaMissing } from "@/lib/drops/store";
import { addLegacyUrls, ensureAsset, getAsset, setAssetStage } from "@/lib/drops/activationStore";
import { capLegacyUrls, fetchWaybackUrls, gscPageUrls, normalizeUrlSet } from "@/lib/drops/legacyUrls";
import { getUserGoogleAccounts, isoDaysAgo, queryGsc } from "@/lib/gscQuery";

export const dynamic = "force-dynamic";

/// Search Analytics keeps 16 months and no more; asking for 480 days just means "all of
/// it" — the pages list must be every page GSC ever saw, not the last month's.
const GSC_LOOKBACK_DAYS = 480;
/// The Search Analytics API's own per-query row ceiling (25 000). "No row cap below the
/// API's own" means exactly this number, no lower.
const GSC_ROW_LIMIT = 25_000;

/**
 * The legacy-URL harvest: what to put in the sitemap. Wayback answers "what pages did
 * this domain ever have" for a host Google has already forgotten; GSC answers "what is
 * it still serving". Both converge on one per-asset URL list — a URL seen in both keeps
 * its first source and flips `inGsc` (addLegacyUrls upserts by (assetId, url)).
 *
 * The asset is ensured on demand — the first harvest IS the act of adopting a domain
 * into activation — and an empty asset moves to `harvesting` while the first rows land.
 */
export async function POST(req: Request, { params }: { params: Promise<{ domain: string }> }) {
  try {
    const userId = await workspaceUserId("act");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { domain: rawDomain } = await params;
    const domain = decodeDomain(rawDomain);
    if (!domain) return NextResponse.json({ error: "bad_domain" }, { status: 400 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const source = typeof body?.source === "string" ? body.source : "";
    if (source !== "wayback" && source !== "gsc" && source !== "all") {
      return NextResponse.json({ error: "bad_source" }, { status: 400 });
    }

    const ensured = await ensureAsset(userId, domain, {
      candidateId: typeof body?.candidateId === "string" && body.candidateId ? body.candidateId : null,
    });
    const current = await getAsset(userId, domain);
    if (!current) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
    const assetId = ensured.id;

    const urlsBefore = current.urls.length;
    if (urlsBefore === 0) await setAssetStage(userId, domain, "harvesting");

    let capped = false;
    let wayback: { added: number; updated: number } | null = null;

    if (source === "wayback" || source === "all") {
      // "all" aborts on a Wayback failure rather than half-harvesting: the client can
      // always re-run with source "gsc" alone, while a silently missing half is exactly
      // the "everything looks done, nothing happens" failure this module exists to avoid.
      const out = await fetchWaybackUrls(domain);
      if (!out.ok) {
        return NextResponse.json(out.reason === "throttled"
          ? { error: "wayback_throttled", hint: "web.archive.org is rate-limiting this server's IP; retry in a few minutes." }
          : { error: "wayback_unreachable", hint: "web.archive.org could not be reached; retry later." }, { status: 502 });
      }
      const cap = capLegacyUrls(urlsBefore, normalizeUrlSet(out.urls, domain));
      capped = capped || cap.capped;
      wayback = await addLegacyUrls(userId, assetId, cap.urls.map(url => ({ url, source: "wayback" })));
    }

    let gsc: { added: number; updated: number } | null = null;

    if (source === "gsc" || source === "all") {
      const siteUrl = (typeof body?.gscSiteUrl === "string" ? body.gscSiteUrl.trim() : "") || current.asset.gscSiteUrl;
      if (!siteUrl) {
        return NextResponse.json(
          { error: "gsc_site_url_required", hint: "Pass gscSiteUrl (\"sc-domain:…\" or \"https://…/\") or record one via gsc-submit first." },
          { status: 400 },
        );
      }
      const accounts = await getUserGoogleAccounts(userId);
      if (!accounts.length) return NextResponse.json({ error: "no_google_account" }, { status: 400 });

      const rows = await queryGsc(accounts, siteUrl, {
        startDate: isoDaysAgo(GSC_LOOKBACK_DAYS),
        endDate: isoDaysAgo(0),
        dimensions: ["page"],
        rowLimit: GSC_ROW_LIMIT,
      });
      // The cap counts what Wayback just wrote too — one 50 000 ceiling per asset.
      const cap = capLegacyUrls(urlsBefore + (wayback?.added ?? 0), normalizeUrlSet(gscPageUrls(rows), domain));
      capped = capped || cap.capped;
      gsc = await addLegacyUrls(userId, assetId, cap.urls.map(url => ({ url, source: "gsc" })), { markInGsc: true });
    }

    const added = (wayback?.added ?? 0) + (gsc?.added ?? 0);
    const updated = (wayback?.updated ?? 0) + (gsc?.updated ?? 0);
    return NextResponse.json({
      added,
      updated,
      // Exact without re-reading up to 50 000 rows: `updated` never changes the count,
      // only `added` does, and this route is the only writer in the request.
      urlsTotal: urlsBefore + added,
      bySource: { wayback, gsc },
      ...(capped ? { capped: true } : {}),
    });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/** `[domain]` arrives percent-encoded when it carries anything unusual; junk stays junk. */
function decodeDomain(raw: string): string {
  try {
    return decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    return "";
  }
}
