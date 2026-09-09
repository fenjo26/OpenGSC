import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import {
  fetchBacklinkProfile, fetchBacklinkStats, estimateProfileUnits, estimateMajesticProfileUnits,
  parseMetricsProvider, REFDOMAIN_PAGE_SIZE, MetricsProvider,
} from "@/lib/seo/metrics";
import { readUsage, recordUsage, releaseUnusedUnits, withinCap, UsageState } from "@/lib/seo/metricsStore";
import {
  readRefDomains, syncRefDomains, writeSnapshot, readSnapshots, normDomain,
  RefDomainRecord,
} from "@/lib/seo/backlinkStore";

// POST /api/metrics/backlinks { siteId, shareToken?, view?, fetch?, creds?, minDr? }
//
// Same two-shape contract as the other metrics routes: a free read of what is stored, and an
// opt-in paid refresh. The stored side is what an imported CSV fills, so the whole tab works
// with no key at all.
//
// `view` picks which stored rows come back: "ahrefs" or "majestic" read one provider's rows,
// "all" (the default) merges both into unique domains — one row per domain carrying each
// provider's number in its own column. The refresh pulls whichever providers the view needs
// and the caller holds keys for; a merged refresh is two independent pulls, each metered and
// capped in its own currency.
//
// There is no `limit` any more. A refresh pulls every referring domain the provider will
// return, paging until the profile ends — a row ceiling here decides for an SEO how much of
// their own link profile they are allowed to see, which is not the product's call to make.

export interface MergedRefDomain {
  refDomain: string;
  /** Ahrefs Domain Rating, when Ahrefs has seen this donor. */
  dr: number | null;
  /** Majestic Trust Flow, when Majestic has seen this donor. */
  tf: number | null;
  cf: number | null;
  links: number | null;
  firstSeen: string;
  topic: string;
  ip: string;
  providers: string[];
  lost: boolean;
  lostAt: string;
  source: "api" | "csv";
}

/** Union across providers: one row per donor, each provider's metric in its own column. */
function mergeRefDomains(all: RefDomainRecord[]): MergedRefDomain[] {
  const byDomain = new Map<string, MergedRefDomain>();
  for (const r of all) {
    const cur = byDomain.get(r.refDomain);
    if (!cur) {
      byDomain.set(r.refDomain, {
        refDomain: r.refDomain,
        dr: r.provider === "ahrefs" ? r.dr : null,
        tf: r.provider === "majestic" ? r.dr : null,
        cf: r.cf,
        links: r.linksToTarget,
        firstSeen: r.firstSeen,
        topic: r.topic,
        ip: r.ip,
        providers: [r.provider],
        lost: r.lost,
        lostAt: r.lostAt,
        source: r.source,
      });
      continue;
    }
    if (r.provider === "ahrefs") cur.dr = r.dr; else cur.tf = r.dr;
    cur.cf = cur.cf ?? r.cf;
    cur.links = cur.links ?? r.linksToTarget;
    if (r.firstSeen && (!cur.firstSeen || r.firstSeen < cur.firstSeen)) cur.firstSeen = r.firstSeen;
    if (r.topic && !cur.topic) cur.topic = r.topic;
    if (r.ip && !cur.ip) cur.ip = r.ip;
    if (!cur.providers.includes(r.provider)) cur.providers.push(r.provider);
    // Live anywhere = live in the union; a domain only reads as lost when every provider that
    // has seen it now calls it lost. Per-provider tabs keep the strict per-pull verdicts.
    cur.lost = cur.lost && r.lost;
    if (r.lostAt > cur.lostAt) cur.lostAt = r.lostAt;
  }
  // Live first, then by whichever authority number exists — DR and TF are different scales, so
  // this ordering is a display heuristic, not a ranking.
  return [...byDomain.values()].sort((a, b) =>
    (a.lost ? 1 : 0) - (b.lost ? 1 : 0)
    || Math.max(b.dr ?? 0, b.tf ?? 0) - Math.max(a.dr ?? 0, a.tf ?? 0));
}

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

  const view = b.view === "ahrefs" || b.view === "majestic" ? b.view : "all";
  // Legacy body.provider still names a single-provider refresh for old clients.
  const fetchProvider: MetricsProvider = view === "all"
    ? parseMetricsProvider(b.provider ?? "ahrefs")
    : view;
  const wantFetch = !!b.fetch && !isGuest;
  const minDr = Math.max(0, Math.min(90, Number(b.minDr ?? 0)));

  // Per-provider credentials. The flat apiKey/baseUrl/cap triple keeps working and applies to
  // `fetchProvider` only — old clients never asked for more than one provider per call.
  const credsFor = (p: MetricsProvider): { apiKey: string; baseUrl?: string; cap: number } => {
    const c = b.creds?.[p];
    if (c) return { apiKey: String(c.apiKey ?? "").trim(), baseUrl: String(c.baseUrl ?? "").trim() || undefined, cap: Number(c.cap ?? 0) || 0 };
    if (p !== fetchProvider) return { apiKey: "", baseUrl: undefined, cap: 0 };
    return { apiKey: String(b.apiKey ?? "").trim(), baseUrl: String(b.baseUrl ?? "").trim() || undefined, cap: Number(b.cap ?? 0) || 0 };
  };

  const history = {
    ahrefs: await readSnapshots(target, 90, "ahrefs"),
    majestic: await readSnapshots(target, 90, "majestic"),
  };
  const usage: { ahrefs: UsageState | null; majestic: UsageState | null } = {
    ahrefs: userId ? await readUsage(userId, "ahrefs") : null,
    majestic: userId ? await readUsage(userId, "majestic") : null,
  };

  const readRows = () => {
    if (view === "all") {
      return readRefDomains(target, { provider: "all", includeLost: true, limit: 100000 })
        .then(mergeRefDomains);
    }
    return readRefDomains(target, { provider: view, includeLost: true, limit: 100000 });
  };

  const respond = async (extra: Record<string, unknown> = {}, status = 200) =>
    NextResponse.json({
      target,
      view,
      refDomains: await readRows(),
      history,
      usage,
      ...extra,
    }, { status });

  if (!wantFetch) return respond();
  if (view !== "all" && fetchProvider === "semrush") return respond({ error: "provider_unsupported" }, 400);

  // ── The refresh: one independent pull per provider the view needs. ──
  const pulls: MetricsProvider[] = view === "all"
    ? (["ahrefs", "majestic"] as MetricsProvider[]).filter(p => credsFor(p).apiKey)
    : [fetchProvider];
  if (!pulls.length) return respond({ error: "no_key" });

  // Price the real pull first: stats is one floored call and returns the live refdomain count,
  // so the reservation matches the profile's actual size instead of a made-up row count. Each
  // provider prices in its own currency: Ahrefs' two floored calls plus per-row refdomains,
  // Majestic's per-page analysis figure plus a retrieval unit a row.
  const errors: Record<string, string> = {};
  const perProvider: Record<string, { units: number; complete?: boolean; sync?: unknown; summary?: unknown }> = {};
  let pulledAny = false;

  for (const p of pulls) {
    const { apiKey, baseUrl, cap } = credsFor(p);
    const stats = await fetchBacklinkStats({ provider: p, apiKey, baseUrl }, target);
    if (!stats.ok) { errors[p] = stats.error; continue; }

    const units = p === "majestic"
      ? estimateMajesticProfileUnits(stats.totals.refDomainsTotal ?? REFDOMAIN_PAGE_SIZE)
      : estimateProfileUnits(stats.totals.refDomainsTotal ?? REFDOMAIN_PAGE_SIZE);
    if (!userId || !(await withinCap(userId, p, units, cap))) {
      errors[p] = "cap_exceeded";
      continue;
    }
    await recordUsage(userId, p, units);

    // The pull reuses the stats answer it was priced from — paying for backlinks-stats twice
    // to save an argument is not a trade either.
    const res = await fetchBacklinkProfile({ provider: p, apiKey, baseUrl }, target, { minDr, stats: stats.raw });

    // Whatever the gateway really billed is what stays on the meter — pages that never
    // happened (or were refused, which the gateway does not charge for) come back off the
    // reservation.
    const spent = res.unitsSpent ?? 0;
    if (userId) await releaseUnusedUnits(userId, p, units, spent);

    if (!res.items.length) { errors[p] = res.error ?? "empty"; continue; }
    pulledAny = true;

    const profile = res.items[0];
    // complete = saw the last row with no DR filter. A DR-filtered run is a deliberate subset
    // and can never prove an absent domain gone — same rule as everywhere else in this wave.
    const complete = minDr === 0 && res.sawEnd === true;
    const sync = await syncRefDomains(target, profile.refDomains, { provider: p, source: "api", complete });

    await writeSnapshot(target, {
      refDomains: profile.refDomainsTotal,
      backlinks: profile.backlinksTotal,
      dofollowPct: profile.dofollowPct,
    }, { provider: p, source: "api" });

    perProvider[p] = {
      units: spent, complete, sync,
      summary: {
        refDomainsTotal: profile.refDomainsTotal,
        backlinksTotal: profile.backlinksTotal,
        dofollowPct: profile.dofollowPct,
      },
    };
    if (res.error) errors[p] = res.error; // partial pull — pages kept, marked incomplete
  }

  // Usage moved during the pulls; the response carries the post-pull counters.
  const freshUsage: typeof usage = {
    ahrefs: userId ? await readUsage(userId, "ahrefs") : null,
    majestic: userId ? await readUsage(userId, "majestic") : null,
  };

  if (!pulledAny) {
    const first = errors[pulls[0]] ?? "empty";
    return respond({
      errors, perProvider, error: first,
      usage: freshUsage,
    }, 502);
  }

  return respond({
    units: Object.fromEntries(Object.entries(perProvider).map(([p, v]) => [p, v.units])),
    errors: Object.keys(errors).length ? errors : undefined,
    perProvider,
    usage: freshUsage,
    complete: view === "all"
      ? pulls.every(p => perProvider[p]?.complete === true)
      : perProvider[fetchProvider]?.complete === true,
  });
}
