import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { verifyAuthOrShare } from "@/lib/authShare";
import { getOwnerEngineKey } from "@/lib/engineKeysServer";

// Bing returns errors as HTTP 400 with { ErrorCode, Message } (e.g. InvalidApiKey,
// InvalidSiteUrl). Surface them instead of silently returning empty data.
async function bingErrorFrom(res: Response, siteUrl: string): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const j = JSON.parse(raw);
    const msg = j?.Message || j?.message || raw;
    // Friendlier hint for the most common cause (wrong key type / bad key).
    if (/invalidapikey/i.test(String(msg))) return "Bing: InvalidApiKey — check you pasted an API Key (Bing → Settings → API Access → API Key), not an OAuth Client ID.";
    if (/invalidsiteurl/i.test(String(msg))) return `Bing: InvalidSiteUrl — this exact URL (${siteUrl}) isn't a verified site in this Bing account.`;
    return `Bing ${res.status}: ${String(msg).slice(0, 200)}`;
  } catch {
    return `Bing ${res.status}: ${raw.slice(0, 200) || "request failed"}`;
  }
}

// GET /api/indexing/bing?siteUrl=...&apiKey=...            (owner: key from browser)
//     /api/indexing/bing?siteUrl=...&siteId=...&shareToken=...  (guest: key resolved server-side)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const siteUrl = searchParams.get("siteUrl") || "";
  let apiKey = searchParams.get("apiKey") || "";
  const siteId = searchParams.get("siteId") || "";
  const shareToken = searchParams.get("shareToken") || "";

  // Authenticate as the logged-in owner OR via a valid share link for this site.
    let ownerId = await workspaceUserId();
  if (!ownerId && shareToken && siteId) {
    const auth = await verifyAuthOrShare(req, siteId);
    if (auth) ownerId = auth.userId;
  }
  if (!ownerId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Guests (and owners who didn't pass a key) get the key resolved from the owner's saved settings.
  if (!apiKey && siteId) apiKey = await getOwnerEngineKey(ownerId, "bing", siteId);

  if (!siteUrl || !apiKey) {
    return NextResponse.json({ error: "Missing siteUrl or apiKey" }, { status: 400 });
  }

  const api = (method: string) =>
    `https://ssl.bing.com/webmaster/api.svc/json/${method}?siteUrl=${encodeURIComponent(siteUrl)}&apikey=${encodeURIComponent(apiKey)}`;

  try {
    // 1. Get Rank and Traffic Stats (PRIMARY — its error is the whole call's error)
    const trafficRes = await fetch(api("GetRankAndTrafficStats"), { signal: AbortSignal.timeout(10000) });
    if (!trafficRes.ok) {
      return NextResponse.json({ error: await bingErrorFrom(trafficRes, siteUrl) }, { status: 200 });
    }
    const trafficData = (await trafficRes.json()).d || [];

    // 2. Get Query Stats (Top queries)
    const queryRes = await fetch(api("GetQueryStats"), { signal: AbortSignal.timeout(10000) });
    let queryData = null;
    if (queryRes.ok) {
      const json = await queryRes.json();
      queryData = json.d || [];
    }

    // 3. Top pages (GetPageStats) — best-effort, some accounts/sites don't expose it
    let pageData = null;
    try {
      const pageRes = await fetch(api("GetPageStats"), { signal: AbortSignal.timeout(10000) });
      if (pageRes.ok) pageData = (await pageRes.json()).d || [];
    } catch { /* optional */ }

    // 4. Crawl stats (pages in index, crawl errors) — best-effort
    let crawlData = null;
    try {
      const crawlRes = await fetch(api("GetCrawlStats"), { signal: AbortSignal.timeout(10000) });
      if (crawlRes.ok) {
        const arr = (await crawlRes.json()).d || [];
        crawlData = Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null; // latest day
      }
    } catch { /* optional */ }

    return NextResponse.json({
      traffic: trafficData,
      queries: queryData,
      pages: pageData,
      crawl: crawlData,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Failed to query Bing Webmaster API" }, { status: 500 });
  }
}

// POST /api/indexing/bing -> Submit sitemap to Bing
export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { siteUrl, sitemapUrl, apiKey } = body;

    if (!sitemapUrl) {
      return NextResponse.json({ error: "Missing sitemapUrl" }, { status: 400 });
    }

    // An API key is now the only way in. This used to fall back to https://www.bing.com/ping,
    // the anonymous sitemap submission endpoint, which Bing shut down in 2022 over spam — it
    // answers 410 Gone. The fallback therefore never worked, and worse, it swallowed the real
    // problem: a bad key produced "Bing ping failed with status 410" instead of InvalidApiKey.
    if (!apiKey || !siteUrl) {
      return NextResponse.json(
        { error: "Bing needs an API key to accept a sitemap — anonymous submission was retired in 2022. Add one in Settings → Bing Webmaster, or list the sitemap in robots.txt." },
        { status: 400 },
      );
    }

    const url = `https://ssl.bing.com/webmaster/api.svc/json/SubmitSitemap?siteUrl=${encodeURIComponent(siteUrl)}&sitemapUrl=${encodeURIComponent(sitemapUrl)}&apikey=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      return NextResponse.json({ error: await bingErrorFrom(response, siteUrl) }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Unknown error" }, { status: 500 });
  }
}
