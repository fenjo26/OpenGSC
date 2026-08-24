import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import {
  fetchBacklinkProfile, fetchBacklinkStats, estimateProfileUnits,
  REFDOMAIN_PAGE_SIZE, MetricsProvider,
} from "@/lib/seo/metrics";
import { readUsage, recordUsage, releaseUnusedUnits, withinCap } from "@/lib/seo/metricsStore";
import {
  readRefDomains, syncRefDomains, writeSnapshot, readSnapshots, normDomain,
} from "@/lib/seo/backlinkStore";

// POST /api/metrics/backlinks { siteId, apiKey?, baseUrl?, cap?, minDr?, fetch? }
//
// Same two-shape contract as the other metrics routes: a free read of what is stored, and an
// opt-in paid refresh. The stored side is what an imported CSV fills, so the whole tab works
// with no key at all.
//
// There is no `limit` any more. A refresh pulls every referring domain the provider will return,
// paging until the profile ends — a row ceiling here decides for an SEO how much of their own
// link profile they are allowed to see, which is not the product's call to make. The real row
// count is known from the stats call, so the price of "everything" is quoted before anything is
// spent, and the only ceiling left is the monthly unit cap the owner configured themselves.

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const shareToken = String(b.shareToken ?? "");

  // The target is derived from a site row, never taken from the request. Otherwise this
  // endpoint would happily spend the owner's credits profiling any domain on the internet.
  //
  // A share-link guest resolves through the token instead of a session — the same escape hatch
  // /api/dr already uses — but only ever reads. Guests must not be able to spend the owner's
  // credits, so `fetch` is forced off for them below rather than merely discouraged.
  let site: { url: string } | null = null;
  let isGuest = false;
  if (userId) {
    site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { url: true } });
  } else if (shareToken && siteId) {
    site = await prisma.site.findFirst({ where: { id: siteId, shareToken, shareEnabled: true }, select: { url: true } });
    isGuest = !!site;
  }
  if (!site) return NextResponse.json({ error: userId ? "Site not found" : "Unauthorized" }, { status: userId ? 404 : 401 });
  const target = normDomain(site.url.replace(/^sc-domain:/, ""));

  const provider = (b.provider === "semrush" ? "semrush" : "ahrefs") as MetricsProvider;
  const wantFetch = !!b.fetch && !isGuest;
  const apiKey = String(b.apiKey ?? "").trim();
  const baseUrl = String(b.baseUrl ?? "").trim() || undefined;
  const cap = Number(b.cap ?? 0);
  const minDr = Math.max(0, Math.min(90, Number(b.minDr ?? 0)));

  const respond = async (extra: Record<string, unknown> = {}, status = 200) =>
    NextResponse.json({
      target,
      refDomains: await readRefDomains(target, { provider, includeLost: true, limit: 100000 }),
      history: await readSnapshots(target, 90, provider),
      usage: userId ? await readUsage(userId, provider) : null,
      ...extra,
    }, { status });

  if (!wantFetch || !apiKey) {
    return respond(wantFetch && !apiKey ? { error: "no_key" } : {});
  }
  if (provider === "semrush") return respond({ error: "provider_unsupported" }, 400);

  // Price the real pull first: stats is one floored call and returns the live refdomain count,
  // so the reservation matches the profile's actual size instead of a made-up row count.
  const stats = await fetchBacklinkStats({ provider, apiKey, baseUrl }, target);
  if (!stats.ok) return respond({ error: stats.error }, 502);

  const units = estimateProfileUnits(stats.totals.refDomainsTotal ?? REFDOMAIN_PAGE_SIZE);
  if (!userId || !(await withinCap(userId, provider, units, cap))) {
    return respond({ error: "cap_exceeded", wouldSpend: units }, 429);
  }
  await recordUsage(userId, provider, units);

  // The pull reuses the stats answer it was priced from — paying for backlinks-stats twice to
  // save an argument is not a trade either.
  const res = await fetchBacklinkProfile({ provider, apiKey, baseUrl }, target, { minDr, stats: stats.raw });

  // Whatever the gateway really billed is what stays on the meter — pages that never happened
  // (or were refused, which the gateway does not charge for) come back off the reservation.
  const spent = res.unitsSpent ?? 0;
  if (userId) await releaseUnusedUnits(userId, provider, units, spent);

  // A pull that stopped midway keeps its fresh pages: they sync with complete=false, which is
  // the flag that stops a partial view from proving any domain lost. Only a run with no pages
  // at all is a failure.
  if (!res.items.length) {
    return respond({ error: res.error ?? "empty" }, 502);
  }

  const profile = res.items[0];
  // complete = saw the last row with no DR filter. A DR-filtered run is a deliberate subset and
  // can never prove an absent domain gone — same rule as everywhere else in this wave.
  const complete = minDr === 0 && res.sawEnd === true;
  const sync = await syncRefDomains(target, profile.refDomains, { provider, source: "api", complete });

  await writeSnapshot(target, {
    refDomains: profile.refDomainsTotal,
    backlinks: profile.backlinksTotal,
    dofollowPct: profile.dofollowPct,
  }, { provider, source: "api" });

  return respond({ units: spent, sync, complete, partialError: res.error || undefined, summary: {
    refDomainsTotal: profile.refDomainsTotal,
    backlinksTotal: profile.backlinksTotal,
    dofollowPct: profile.dofollowPct,
  } });
}
