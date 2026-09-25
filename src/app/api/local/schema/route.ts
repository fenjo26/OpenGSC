import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { safeFetch, SafeFetchError } from "@/lib/security/safeFetch";
import { getProfile, getSite, localSchemaMissing } from "@/lib/local/store";
import { buildLocalBusinessSchema, diffSchemas, validateLocalBusinessSchema } from "@/lib/local/schema";
import { homepageUrl, localBusinessNode } from "@/lib/local/nap";

// GET /api/local/schema?siteId=…          → generated JSON-LD + Google-requirements validation (read, local)
// GET /api/local/schema?siteId=…&compare=1 → + fetch the homepage, diff generated vs the site's own
//                                            LocalBusiness node (read, net: one safeFetch)
//
// The image hint (og:image / JSON-LD image of the homepage) is only resolved on the compare pass —
// that is the one call which already has the HTML in hand. The audit tables store no logo URL, so
// the homepage is the honest source.

function imageFromPage(html: string): string {
  const node = localBusinessNode(html);
  const fromLd = node?.image;
  const ldImage = typeof fromLd === "string" ? fromLd : Array.isArray(fromLd) && typeof fromLd[0] === "string" ? fromLd[0] : "";
  if (ldImage) return ldImage;
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return og ? og[1] : "";
}

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const siteId = url.searchParams.get("siteId") ?? "";
  const compare = url.searchParams.get("compare") === "1";
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });

  try {
    const site = await getSite(userId, siteId);
    if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    const profile = await getProfile(userId, siteId);
    if (!profile) return NextResponse.json({ error: "profile_required" }, { status: 400 });

    const home = homepageUrl(site.url);
    // Pass 1 without network: schema + validation with whatever we know locally.
    let schema = buildLocalBusinessSchema(profile, { url: home });
    let validation = validateLocalBusinessSchema(schema, profile.businessType);

    if (!compare) {
      return NextResponse.json({ schema, validation, siteUrl: home });
    }

    // Compare pass: one fetch, then rebuild with the image hint so the generated markup is final.
    let html: string | null = null;
    let fetchError: string | null = null;
    try {
      const res = await safeFetch(home, { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });
      html = res.ok ? await res.text() : null;
      if (!res.ok) fetchError = `http_${res.status}`;
    } catch (e) {
      fetchError = e instanceof SafeFetchError ? e.code : "network_error";
    }

    let image = "";
    let siteNode: Record<string, unknown> | null = null;
    let diffs: ReturnType<typeof diffSchemas> = [];
    if (html != null) {
      image = imageFromPage(html);
      schema = buildLocalBusinessSchema(profile, { url: home, ...(image ? { image } : {}) });
      validation = validateLocalBusinessSchema(schema, profile.businessType);
      siteNode = localBusinessNode(html);
      diffs = diffSchemas(schema, siteNode);
    }
    return NextResponse.json({ schema, validation, siteUrl: home, compare: { fetchError, siteNode, diffs } });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] schema generate failed:", error);
    return NextResponse.json({ error: "schema_failed" }, { status: 500 });
  }
}
