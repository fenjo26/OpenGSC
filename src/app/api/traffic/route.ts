import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";
import { goanyTraffic, type DomainTraffic } from "@/lib/seo/goanyapi";

// GET /api/traffic?domain=example.com — estimated visits, engagement and channel mix.
//
// The app's first traffic provider. Everything else here measures a site the owner controls, via
// their own Search Console; this measures any domain, which is what makes it useful against
// competitors and useless to fake. It is also the only place the GenAI channel appears, and that
// number is the point: the AEO module already tracks whether a domain is cited in AI answers and
// has never been able to say whether those citations arrive as sessions.
//
// Cached in SQLite like /api/dr, but for 14 days rather than 7. The upstream figures are monthly
// — refetching inside the same month spends credits to receive the identical numbers.
//
// The key travels in a header, following the convention the rest of this app uses: SEO keys live
// in the browser's localStorage, not in server config, so a self-hosted instance never holds a
// credential its owner did not type on that machine.

const TTL_MS = 14 * 24 * 3600 * 1000;

const normalize = (d: string) =>
  d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/^www\./, "").split("/")[0];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const shareToken = searchParams.get("shareToken");

  const ownerId = await workspaceUserId();
  let isAuthorized = !!ownerId;
  // A share link is a read-only window onto one site. Guests get whatever is already cached and
  // never trigger a paid call — the owner's credits are not theirs to spend.
  let guestOnly = false;
  if (!isAuthorized && shareToken) {
    const site = await prisma.site.findFirst({ where: { shareToken, shareEnabled: true } });
    if (site) { isAuthorized = true; guestOnly = true; }
  }
  if (!isAuthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const domain = normalize(String(searchParams.get("domain") ?? ""));
  if (!domain || !domain.includes(".")) return NextResponse.json({ error: "bad_domain" }, { status: 400 });

  const cacheOnly = guestOnly || searchParams.get("cacheOnly") === "1";
  const apiKey = (req.headers.get("x-goanyapi-key") || "").trim();

  let cached: any = null;
  try {
    const rows: any[] = await rawQuery(
      `SELECT domain, payload, checkedAt FROM "TrafficCache" WHERE domain = ?`, domain);
    cached = rows?.[0] ?? null;
  } catch { /* table missing until prisma db push — behave as a cache miss */ }

  if (cached) {
    const age = Date.now() - new Date(cached.checkedAt).getTime();
    if (age < TTL_MS || cacheOnly) {
      let payload: DomainTraffic | null = null;
      try { payload = JSON.parse(cached.payload); } catch { /* corrupt row — refetch below */ }
      if (payload) {
        return NextResponse.json({
          traffic: payload, cached: true, checkedAt: cached.checkedAt,
          // Reported so the UI can say "from 20 July" rather than implying this is live.
          stale: age >= TTL_MS,
        });
      }
    }
  }

  if (cacheOnly) return NextResponse.json({ traffic: null, cached: false });
  if (!apiKey) return NextResponse.json({ traffic: null, cached: false, error: "no_key" });

  const r = await goanyTraffic(apiKey, domain);
  if (!r.data) {
    // The provider's own reason travels back untouched — `insufficient_credits` and `bad_key` need
    // different actions from the user, and one generic failure string makes them the same problem.
    return NextResponse.json({ traffic: null, cached: false, error: r.error ?? "no_data" }, { status: 502 });
  }

  try {
    await runUpsert({
      table: "TrafficCache",
      conflict: ["domain"],
      values: { domain, payload: JSON.stringify(r.data), checkedAt: new Date().toISOString() },
      update: { payload: "set", checkedAt: "set" },
    });
  } catch { /* cache best-effort — the answer is already paid for and returned either way */ }

  return NextResponse.json({
    traffic: r.data,
    cached: false,
    checkedAt: new Date().toISOString(),
    credits: r.credits,
    remainingCredits: r.remaining,
  });
}
