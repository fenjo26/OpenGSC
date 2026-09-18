import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { schemaMissing } from "@/lib/drops/store";
import { getAsset, setSitemapBuilt } from "@/lib/drops/activationStore";
import { NGINX_SNIPPET, buildRobotsTxt, buildSitemapXml, indexnowKeyFile } from "@/lib/drops/activation";

export const dynamic = "force-dynamic";

/**
 * The deploy bundle: everything that must be copied onto the asset host, as plain
 * strings in one JSON. The sitemap is built from the stored legacy URLs (the harvest is
 * the source of truth, not a live re-fetch — a deploy must be reproducible), the robots
 * file points at it, the key file authenticates IndexNow, and the nginx snippet orders
 * the three files before the catch-all 301.
 *
 * A successful build is also the first real progress marker: setSitemapBuilt moves an
 * empty-stage asset to `ready`.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ domain: string }> }) {
  try {
    const userId = await workspaceUserId("act");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { domain: rawDomain } = await params;
    const domain = decodeDomain(rawDomain);
    const data = domain ? await getAsset(userId, domain) : null;
    if (!data) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

    const urls = data.urls.map(r => r.url);
    const sitemapUrl = `https://${data.asset.domain}/sitemap.xml`;

    const payload = {
      sitemapXml: buildSitemapXml(urls),
      robotsTxt: buildRobotsTxt(sitemapUrl),
      // Rows created before ensureAsset backfilled keys (or by hand) deploy an empty key
      // file — IndexNow will reject it, visibly, which beats a fabricated key.
      keyFile: indexnowKeyFile(data.asset.indexnowKey ?? ""),
      nginxSnippet: NGINX_SNIPPET,
      sitemapUrl,
    };

    await setSitemapBuilt(userId, data.asset.id, { url: sitemapUrl, count: urls.length });
    return NextResponse.json(payload);
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
