import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { schemaMissing } from "@/lib/drops/store";
import { getAsset, setGscSite } from "@/lib/drops/activationStore";

export const dynamic = "force-dynamic";

/**
 * Submit the sitemap through the GSC API — the second half of the re-activation channel
 * (Google crawls sitemaps, but only the ones a property knows about).
 *
 * The token plumbing is the same as /api/indexing/sitemap/check-google: the user's Google
 * OAuth account row, refreshed in place when expired. The submit itself is the
 * webmasters v3 sitemaps.submit call — a PUT to sites/{siteUrl}/sitemaps/{feedpath}.
 *
 * Honesty rule: a 403/404 from Google (property not added / not verified — verification
 * of a freshly-acquired domain is manual DNS/HTML work no API call can do for you)
 * surfaces verbatim with the hint, never as a bare 500 of ours.
 */
export async function POST(req: Request, { params }: { params: Promise<{ domain: string }> }) {
  try {
    const userId = await workspaceUserId("act");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { domain: rawDomain } = await params;
    let domain = "";
    try {
      domain = decodeURIComponent(rawDomain).trim().toLowerCase();
    } catch {
      domain = "";
    }
    const data = domain ? await getAsset(userId, domain) : null;
    if (!data) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const siteUrl = typeof body?.siteUrl === "string" ? body.siteUrl.trim() : "";
    if (!siteUrl) return NextResponse.json({ error: "site_url_required" }, { status: 400 });
    let sitemapPath = typeof body?.sitemapPath === "string" ? body.sitemapPath.trim() : "";
    if (!sitemapPath) sitemapPath = "/sitemap.xml";
    if (!sitemapPath.startsWith("/")) sitemapPath = "/" + sitemapPath;

    // ── user's Google token (same as the URL-inspection route) ───────────────────
    const account = await prisma.account.findFirst({
      where: { userId, provider: "google" },
      select: { id: true, access_token: true, refresh_token: true, expires_at: true },
    });
    if (!account?.access_token) {
      return NextResponse.json({ error: "No Google account connected" }, { status: 400 });
    }
    let accessToken = account.access_token;
    const nowSec = Math.floor(Date.now() / 1000);
    if (account.expires_at && account.expires_at < nowSec + 60) {
      if (!account.refresh_token || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        return NextResponse.json(
          { error: "Access token expired and no refresh token available. Please reconnect your Google account." },
          { status: 401 },
        );
      }
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          refresh_token: account.refresh_token,
          grant_type: "refresh_token",
        }),
      });
      if (!tokenRes.ok) {
        return NextResponse.json(
          { error: "Failed to refresh Google access token. Please reconnect your Google account." },
          { status: 401 },
        );
      }
      const tokenData = await tokenRes.json();
      accessToken = tokenData.access_token;
      await prisma.account.update({
        where: { id: account.id },
        data: {
          access_token: tokenData.access_token,
          expires_at: Math.floor(Date.now() / 1000) + (tokenData.expires_in ?? 3600),
        },
      });
    }

    // ── sitemaps.submit ──────────────────────────────────────────────────────────
    const api = "https://searchconsole.googleapis.com/webmasters/v3/sites/" +
      encodeURIComponent(siteUrl) + "/sitemaps/" + encodeURIComponent(sitemapPath);
    const res = await fetch(api, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!res) return NextResponse.json({ error: "google_unreachable" }, { status: 502 });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let error: unknown = text;
      try {
        error = JSON.parse(text);
      } catch {
        // Not JSON — the raw body, verbatim.
      }
      const verifiedHint = "add the property in GSC first (verification is manual)";
      if (res.status === 403 || res.status === 404) {
        return NextResponse.json({ error, hint: verifiedHint }, { status: res.status });
      }
      return NextResponse.json({ error, hint: "google_api_error" }, { status: 502 });
    }

    await setGscSite(userId, data.asset.id, { siteUrl, sitemapPath });
    return NextResponse.json({ ok: true, siteUrl, sitemapPath });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
