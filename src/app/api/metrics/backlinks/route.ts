import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { fetchBacklinkProfile, estimateProfileUnits, MetricsProvider } from "@/lib/seo/metrics";
import { readUsage, recordUsage, withinCap } from "@/lib/seo/metricsStore";
import {
  readRefDomains, syncRefDomains, writeSnapshot, readSnapshots, normDomain,
} from "@/lib/seo/backlinkStore";

// POST /api/metrics/backlinks { siteId, apiKey?, baseUrl?, cap?, limit?, minDr?, fetch? }
//
// Same two-shape contract as the other metrics routes: a free read of what is stored, and an
// opt-in paid refresh. The stored side is what an imported CSV fills, so the whole tab works
// with no key at all.

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
  const limit = Math.max(10, Math.min(1000, Number(b.limit ?? 100)));
  const minDr = Math.max(0, Math.min(90, Number(b.minDr ?? 0)));

  const respond = async (extra: Record<string, unknown> = {}, status = 200) =>
    NextResponse.json({
      target,
      refDomains: await readRefDomains(target, { provider, includeLost: true, limit: 1000 }),
      history: await readSnapshots(target, 90, provider),
      usage: userId ? await readUsage(userId, provider) : null,
      ...extra,
    }, { status });

  if (!wantFetch || !apiKey) {
    return respond(wantFetch && !apiKey ? { error: "no_key" } : {});
  }

  const units = estimateProfileUnits(limit);
  if (!userId || !(await withinCap(userId, provider, units, cap))) {
    return respond({ error: "cap_exceeded", wouldSpend: units }, 429);
  }
  await recordUsage(userId, provider, units);

  const res = await fetchBacklinkProfile({ provider, apiKey, baseUrl }, target, { limit, minDr });
  if (res.error || !res.items.length) {
    return respond({ error: res.error ?? "empty" }, 502);
  }

  const profile = res.items[0];

  // A pull is only allowed to conclude "this link is gone" when it could have seen everything.
  // A DR filter or a row cap makes absence meaningless, and marking those as lost would invent
  // link losses — and then alert the user about them.
  const complete = minDr === 0 && profile.refDomains.length < limit;
  const sync = await syncRefDomains(target, profile.refDomains, { provider, source: "api", complete });

  await writeSnapshot(target, {
    refDomains: profile.refDomainsTotal,
    backlinks: profile.backlinksTotal,
    dofollowPct: profile.dofollowPct,
  }, { provider, source: "api" });

  return respond({ units, sync, complete, summary: {
    refDomainsTotal: profile.refDomainsTotal,
    backlinksTotal: profile.backlinksTotal,
    dofollowPct: profile.dofollowPct,
  } });
}
