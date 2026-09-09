import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";
import { goanyTraffic, type DomainTraffic } from "@/lib/seo/goanyapi";
import { semrushTraffic } from "@/lib/seo/semrushTraffic";

// GET /api/traffic?domain=example.com&provider=auto — estimated visits, engagement, channels.
//
// The app's view of traffic it does not own. Everything else here measures a site the owner
// controls, via their own Search Console; this measures any domain, which is what makes it
// useful against competitors and useless to fake. It is also the only place the GenAI channel
// appears, and that number is the point: the AEO module already tracks whether a domain is
// cited in AI answers and has never been able to say whether those citations arrive as sessions.
//
// Two providers, one answer shape. GoAnyAPI returns everything in one request for credits;
// Semrush TA bills ~1 unit per report and is effectively free. `provider` picks who answers:
// `auto` (the default) prefers Semrush when its key travels, `semrush` and `goanyapi` are
// explicit. The cache keeps one row per (domain, provider) — two vendors estimating the same
// truth are two readings worth keeping, and switching sources must not refetch what either
// already answered.
//
// Cached in SQLite like /api/dr, but for 14 days rather than 7. The upstream figures are
// monthly — refetching inside the same month spends credits to receive identical numbers.
//
// Keys travel in headers, following the convention the rest of this app uses: SEO keys live
// in the browser's localStorage, not in server config, so a self-hosted instance never holds
// a credential its owner did not type on that machine.

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
  const goanyKey = (req.headers.get("x-goanyapi-key") || "").trim();
  const semrush = {
    apiKey: (req.headers.get("x-semrush-key") || "").trim(),
    baseUrl: (req.headers.get("x-semrush-baseurl") || "").trim() || undefined,
  };

  // `auto` is a preference, not a provider: it resolves to whoever has a key, Semrush first —
  // its answers are effectively free where GoAnyAPI spends credits.
  const wanted = searchParams.get("provider") === "goanyapi" || searchParams.get("provider") === "semrush"
    ? (searchParams.get("provider") as "goanyapi" | "semrush")
    : semrush.apiKey ? "semrush" : "goanyapi";

  const cacheRows: { provider: string; payload: string; checkedAt: string }[] = [];
  try {
    const rows: any[] = await rawQuery(
      `SELECT provider, payload, checkedAt FROM "TrafficCache" WHERE domain = ? ORDER BY checkedAt ASC`, domain);
    for (const r of rows ?? []) cacheRows.push(r);
  } catch { /* table missing until prisma db push — behave as a cache miss */ }

  // `provider` inside the payload travels with every answer; rows written before the field
  // existed can only be GoAnyAPI's.
  const fromPayload = (raw: string): DomainTraffic | null => {
    try {
      const payload = JSON.parse(raw);
      if (payload && typeof payload === "object") return payload;
      return null;
    } catch { return null; }
  };

  // Cache-hit rule: an explicit provider is only served by its own row; `auto` takes the
  // freshest row either provider has written.
  const hit = cacheRows
    .map(r => {
      const payload = fromPayload(r.payload);
      return payload ? { payload, provider: String(payload.provider ?? r.provider ?? "goanyapi"), checkedAt: r.checkedAt } : null;
    })
    .filter((r): r is { payload: DomainTraffic; provider: string; checkedAt: string } => r != null)
    .filter(r => r.provider === wanted)
    .sort((a, b) => new Date(b.checkedAt).getTime() - new Date(a.checkedAt).getTime())[0];

  if (hit) {
    const age = Date.now() - new Date(hit.checkedAt).getTime();
    if (age < TTL_MS || cacheOnly) {
      return NextResponse.json({
        traffic: hit.payload, cached: true, checkedAt: hit.checkedAt,
        provider: hit.payload.provider ?? hit.provider,
        // Reported so the UI can say "from 20 July" rather than implying this is live.
        stale: age >= TTL_MS,
      });
    }
  }

  if (cacheOnly) return NextResponse.json({ traffic: null, cached: false });
  if (wanted === "semrush" && !semrush.apiKey) return NextResponse.json({ traffic: null, cached: false, error: "no_key" });
  if (wanted === "goanyapi" && !goanyKey) return NextResponse.json({ traffic: null, cached: false, error: "no_key" });

  const fetchIt = async (): Promise<{ data: DomainTraffic | null; error?: string; extra?: Record<string, unknown> }> => {
    if (wanted === "semrush") {
      const r = await semrushTraffic({ apiKey: semrush.apiKey, baseUrl: semrush.baseUrl }, domain);
      return { data: r.data, error: r.error, extra: { units: r.units } };
    }
    const r = await goanyTraffic(goanyKey, domain);
    if (!r.data) {
      // The provider's own reason travels back untouched — `insufficient_credits` and `bad_key`
      // need different actions from the user, and one generic failure string makes them the same problem.
      return { data: null, error: r.error ?? "no_data" };
    }
    return { data: r.data };
  };

  const r = await fetchIt();
  if (!r.data) {
    return NextResponse.json({ traffic: null, cached: false, error: r.error ?? "no_data" }, { status: 502 });
  }

  try {
    await runUpsert({
      table: "TrafficCache",
      conflict: ["domain", "provider"],
      values: { domain, provider: wanted, payload: JSON.stringify(r.data), checkedAt: new Date().toISOString() },
      update: { payload: "set", checkedAt: "set" },
    });
  } catch { /* cache best-effort — the answer is already paid for and returned either way */ }

  return NextResponse.json({
    traffic: r.data,
    cached: false,
    checkedAt: new Date().toISOString(),
    provider: wanted,
    ...(r.extra ?? {}),
  });
}
