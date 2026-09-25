import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { safeFetch, SafeFetchError } from "@/lib/security/safeFetch";
import { getProfile, getSite, localSchemaMissing } from "@/lib/local/store";
import { fillFromSite, homepageUrl } from "@/lib/local/nap";

// POST /api/local/profile/fill { siteId } (act, net) — "Fill from the site": fetch the homepage,
// harvest what its JSON-LD/meta offer, return a DRAFT. Nothing is saved — the user confirms.

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { siteId?: string };
  const siteId = String(body?.siteId ?? "");
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });

  try {
    const site = await getSite(userId, siteId);
    if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    const profile = await getProfile(userId, siteId);
    const url = homepageUrl(site.url);
    try {
      const res = await safeFetch(url, { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });
      if (!res.ok) return NextResponse.json({ error: `http_${res.status}` }, { status: 502 });
      const html = await res.text();
      const country = profile?.country || "";
      return NextResponse.json({ draft: fillFromSite(html, country), sourceUrl: url });
    } catch (e) {
      if (e instanceof SafeFetchError) return NextResponse.json({ error: e.code }, { status: 502 });
      return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
    }
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] fill failed:", error);
    return NextResponse.json({ error: "fill_failed" }, { status: 500 });
  }
}
