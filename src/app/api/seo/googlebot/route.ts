import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { analyzeUrl } from "@/lib/seo/googlebot";
import { assertSafeTarget, SafeFetchError } from "@/lib/security/safeFetch";

// POST /api/seo/googlebot
// body: { url: string, desktop?: boolean, referer?: boolean, firecrawlKey?: string, wayback?: boolean }
// → { url, views, diff, renderedDiff?, wayback?: { available, url?, timestamp? } | null, gsc?: {...} | null, ownSite?: { id, url } | null }

async function assertPublicUrl(raw: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await assertSafeTarget(raw);
  } catch (error) {
    if (error instanceof SafeFetchError) {
      if (error.code === "private_address") return { ok: false, error: "private_host" };
      if (error.code === "dns_failed") return { ok: false, error: "dns_fail" };
    }
    return { ok: false, error: "bad_url" };
  }
  return { ok: true };
}

// ── GSC URL Inspection for own verified sites (googleCanonical / userCanonical …) ──
async function inspectOwnSite(userId: string, inspectUrl: string) {
  const host = (() => { try { return new URL(inspectUrl).hostname.toLowerCase(); } catch { return ""; } })();
  if (!host) return { ownSite: null, gsc: null };

  const sites = await prisma.site.findMany({ where: { userId }, select: { id: true, url: true, siteId: true } });
  const match = sites.find(s => {
    const bare = s.siteId.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
    const siteHost = (() => { try { return new URL(s.url).hostname.toLowerCase(); } catch { return bare; } })();
    return siteHost === host || bare === host || host.endsWith("." + bare);
  });
  if (!match) return { ownSite: null, gsc: null };

  const account = await prisma.account.findFirst({
    where: { userId, provider: "google" },
    select: { id: true, access_token: true, refresh_token: true, expires_at: true },
  });
  if (!account?.access_token) return { ownSite: { id: match.id, url: match.url }, gsc: null };

  // Refresh if expired
  let accessToken = account.access_token;
  const nowSec = Math.floor(Date.now() / 1000);
  if (account.expires_at && account.expires_at < nowSec + 60 && account.refresh_token) {
    try {
      const tr = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          refresh_token: account.refresh_token,
          grant_type: "refresh_token",
        }),
      });
      if (tr.ok) {
        const td = await tr.json();
        accessToken = td.access_token;
        await prisma.account.update({
          where: { id: account.id },
          data: { access_token: td.access_token, expires_at: Math.floor(Date.now() / 1000) + (td.expires_in ?? 3600) },
        });
      }
    } catch {}
  }

  // URL Inspection API doesn't support sc-domain: — convert to url-prefix form
  let siteUrl = match.siteId;
  if (siteUrl.startsWith("sc-domain:")) siteUrl = "https://" + siteUrl.slice("sc-domain:".length) + "/";

  try {
    const res = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionUrl: inspectUrl, siteUrl }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return { ownSite: { id: match.id, url: match.url }, gsc: null };
    const data = await res.json();
    const idx = data?.inspectionResult?.indexStatusResult;
    if (!idx) return { ownSite: { id: match.id, url: match.url }, gsc: null };
    return {
      ownSite: { id: match.id, url: match.url },
      gsc: {
        verdict: idx.verdict ?? null,
        coverageState: idx.coverageState ?? null,
        indexingState: idx.indexingState ?? null,
        robotsTxtState: idx.robotsTxtState ?? null,
        pageFetchState: idx.pageFetchState ?? null,
        crawledAs: idx.crawledAs ?? null,
        googleCanonical: idx.googleCanonical ?? null,
        userCanonical: idx.userCanonical ?? null,
        lastCrawlTime: idx.lastCrawlTime ?? null,
      },
    };
  } catch {
    return { ownSite: { id: match.id, url: match.url }, gsc: null };
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  let url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) return NextResponse.json({ error: "bad_url" }, { status: 400 });
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  const guard = await assertPublicUrl(url);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 400 });

  const result = await analyzeUrl(url, {
    desktop: !!body.desktop,
    referer: !!body.referer,
    firecrawlKey: typeof body.firecrawlKey === "string" ? body.firecrawlKey : undefined,
    wayback: !!body.wayback,
  });
  const { ownSite, gsc } = await inspectOwnSite(userId, url).catch(() => ({ ownSite: null, gsc: null }));

  return NextResponse.json({ ...result, ownSite, gsc });
}
