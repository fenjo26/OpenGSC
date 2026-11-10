// wave-ext E5 — the DB half of /api/ext/hosts: everything OpenGSC knows about up to 100 hosts
// (plus the query itself, when the overlay sent one) in a FIXED number of queries — one
// findMany with `in` per source, never per host. Local reads only; the paid paths (refdomains)
// are not touched here. enrichHosts is the free age/DR fill-in.
//
// A partially missing schema (an instance that pulled the code but pushed only some tables)
// must not kill the whole answer: every optional source degrades to null/[] with one warn.

import { prisma } from "@/lib/prisma";
import { apexOf } from "@/lib/drops/registries";
import { calcAgeMonths, domainTags } from "@/lib/serpmon/domains";
import { ignorePredicate, parseHostList } from "@/lib/serpmon/hosts";
import { normaliseKeyword } from "@/lib/serpmon/keywords";
import { ensureHosts } from "@/lib/serpmon/store";
import { enrichPendingHosts } from "@/lib/serpmon/enrich";
import { withCallContext } from "@/lib/providerLog/context";
import { resolveCaptureBodies } from "@/lib/providerLog/bodies";
import { YOUNG_HOST_MONTHS } from "@/lib/serpmon/types";
import { matchPortfolioSite, normalizePageUrl } from "@/lib/ext/urlMatch";
import { normaliseHosts, pickDr, rankProjects, weightedPosition } from "./hostIntelPure";
import {
  EXT_ENRICH_DEADLINE_MS, EXT_ENRICH_MAX, EXT_HOSTS_MAX, EXT_QUERY_WINDOW_DAYS,
  type EnrichResponse, type HostIntel, type HostsRequest, type HostsResponse, type QueryIntel,
} from "./types";

const siteLabel = (url: string): string =>
  url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/$/, "");

function normalizePageLikeUrl(host: string) {
  return normalizePageUrl(`https://${host}/`);
}

async function maybe<T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (e) {
    console.warn(`[ext-hosts] ${label} unavailable:`, e instanceof Error ? e.message : e);
    return fallback;
  }
}

/** One call, every source. The number of SQL statements does not depend on host count. */
export async function hostIntel(userId: string, req: HostsRequest): Promise<HostsResponse> {
  const hosts = normaliseHosts(req.hosts ?? [], EXT_HOSTS_MAX);
  const registrables = [...new Set(hosts.map(h => apexOf(h)).filter((r): r is string => !!r))];
  const wantHosts = [...new Set([...hosts, ...registrables])]; // lookups by host AND apex
  const now = new Date();

  if (!hosts.length) {
    return { hosts: [], query: null, missing: { age: 0, dr: 0 } };
  }

  // ── one query per source ────────────────────────────────────────────────────────
  const [sites, pbnSites, serpHostRows, metricRows, drRows, projects, backlinks, prospects, dropRows, assetRows] =
    await Promise.all([
      maybe("Site", () => prisma.site.findMany({
        where: { userId },
        select: { id: true, siteId: true, url: true },
      }), [] as { id: string; siteId: string; url: string }[]),
      maybe("PbnSite", () => prisma.pbnSite.findMany({
        where: { userId, domain: { in: registrables } },
        select: { id: true, domain: true, status: true },
      }), [] as { id: string; domain: string; status: string }[]),
      maybe("SerpHost", () => prisma.serpHost.findMany({
        where: { host: { in: hosts } },
        select: { id: true, host: true, registrable: true, registeredAt: true, dr: true, drCheckedAt: true, refdomains: true },
      }), [] as { id: number; host: string; registrable: string; registeredAt: Date | null; dr: number | null; drCheckedAt: Date | null; refdomains: number | null }[]),
      maybe("DomainMetricCache", () => prisma.domainMetricCache.findMany({
        where: { domain: { in: registrables } },
        orderBy: { checkedAt: "desc" },
        select: { domain: true, provider: true, dr: true, refDomains: true, checkedAt: true },
      }), [] as { domain: string; provider: string; dr: number | null; refDomains: number | null; checkedAt: Date }[]),
      maybe("DrCache", () => prisma.drCache.findMany({
        where: { domain: { in: registrables } },
        select: { domain: true, dr: true },
      }), [] as { domain: string; dr: number | null }[]),
      maybe("SerpProject", () => prisma.serpProject.findMany({
        where: { userId },
        select: {
          id: true, name: true, country: true, lang: true,
          ownDomains: true, ignoreHosts: true, firstRunAt: true,
        },
      }), [] as { id: string; name: string; country: string; lang: string; ownDomains: string; ignoreHosts: string; firstRunAt: Date | null }[]),
      maybe("SiteBacklink", () => prisma.siteBacklink.findMany({
        where: { site: { userId }, domainFrom: { in: wantHosts } },
        select: { siteId: true, domainFrom: true, apiLost: true },
      }), [] as { siteId: string; domainFrom: string; apiLost: boolean }[]),
      maybe("OutreachProspect", () => prisma.outreachProspect.findMany({
        where: { userId, domain: { in: wantHosts } },
        select: { id: true, domain: true, stage: true },
      }), [] as { id: string; domain: string; stage: string }[]),
      maybe("DropCandidate", () => prisma.dropCandidate.findMany({
        where: { userId, domain: { in: registrables } },
        select: { id: true, domain: true, stage: true, watched: true },
      }), [] as { id: string; domain: string; stage: string; watched: boolean }[]),
      maybe("DropAsset", () => prisma.dropAsset.findMany({
        where: { userId, domain: { in: registrables } },
        select: { id: true, domain: true, stage: true },
      }), [] as { id: string; domain: string; stage: string }[]),
    ]);

  // SERP Monitor standings: project hosts for the hosts we have ids for.
  const hostIds = [...new Set(serpHostRows.map(h => h.id))];
  const projectHosts = hostIds.length
    ? await maybe("SerpProjectHost", () => prisma.serpProjectHost.findMany({
        where: { hostId: { in: hostIds } },
        select: {
          projectId: true, hostId: true, firstSeenAt: true, keywords: true,
          prevKeywords: true, top10: true, top30: true, bestPos: true, avgPos: true, bounces: true,
        },
      }), [] as { projectId: string; hostId: number; firstSeenAt: Date; keywords: number; prevKeywords: number; top10: number; top30: number; bestPos: number | null; avgPos: number | null; bounces: number }[])
    : [];

  // per-lookup indexes
  const metricByDomain = new Map<string, { dr: number | null; refDomains: number | null; checkedAt: Date }>();
  for (const m of metricRows) {
    const cur = metricByDomain.get(m.domain); // orderBy checkedAt desc → first wins
    if (!cur) metricByDomain.set(m.domain, { dr: m.dr, refDomains: m.refDomains, checkedAt: m.checkedAt });
  }
  const drByDomain = new Map(drRows.map(d => [d.domain, d.dr]));
  const pbnByDomain = new Map(pbnSites.map(p => [p.domain, p]));
  const prospectByDomain = new Map(prospects.map(p => [p.domain, p]));
  const dropByDomain = new Map(dropRows.map(d => [d.domain, d]));
  const assetByDomain = new Map(assetRows.map(a => [a.domain, a]));

  // links-to-us grouped by site
  const linksBySite = new Map<string, { links: number; live: number; domains: Set<string> }>();
  for (const b of backlinks) {
    const cur = linksBySite.get(b.siteId) ?? { links: 0, live: 0, domains: new Set<string>() };
    cur.links++;
    if (!b.apiLost) cur.live++;
    cur.domains.add(b.domainFrom);
    linksBySite.set(b.siteId, cur);
  }
  const siteById = new Map(sites.map(s => [s.id, s]));

  const serpHostByHost = new Map(serpHostRows.map(h => [h.host, h]));

  const out: HostIntel[] = hosts.map(host => {
    const registrable = apexOf(host) ?? "";
    const serpHost = serpHostByHost.get(host);
    const metric = metricByDomain.get(registrable) ?? null;

    // own portfolio site?
    let own: HostIntel["own"] = null;
    const nu = normalizePageLikeUrl(host);
    if (nu) {
      const site = matchPortfolioSite(sites as { id: string; siteId: string; url: string }[], nu);
      if (site) own = { siteId: site.id, label: siteLabel(site.url), openPath: `/site/${site.id}` };
    }

    const pbn = registrable ? pbnByDomain.get(registrable) : undefined;
    const dr = pickDr({
      serpmon: serpHost?.dr != null ? { dr: serpHost.dr, at: serpHost.drCheckedAt ?? null } : null,
      metric: metric ? { dr: metric.dr, at: metric.checkedAt } : null,
      drCache: registrable && drByDomain.has(registrable) ? { dr: drByDomain.get(registrable) ?? null, at: null } : null,
    });

    // SERP Monitor projects tracking this host (≤3, matching country/lang first)
    const ownDomainsByProject = new Map(projects.map(p => [p.id, parseHostList(p.ownDomains)]));
    const ignoreByProject = new Map(projects.map(p => [p.id, parseHostList(p.ignoreHosts)]));
    const standings = projectHosts
      .filter(ph => serpHost && ph.hostId === serpHost.id)
      .map(ph => {
        const project = projects.find(p => p.id === ph.projectId);
        return project
          ? {
              project,
              ph,
              keywords: ph.keywords,
              country: project.country,
              lang: project.lang,
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    const ranked = rankProjects(standings, String(req.country ?? ""), String(req.lang ?? ""), 3);
    const serpmon = ranked.map(({ project, ph }) => {
      const tags = domainTags(
        {
          hostId: serpHost?.id ?? 0,
          host,
          registrable,
          firstSeenAt: ph.firstSeenAt.toISOString(),
          lastSeenAt: ph.firstSeenAt.toISOString(),
          registeredAt: serpHost?.registeredAt ? serpHost.registeredAt.toISOString() : null,
          ageMonths: serpHost?.registeredAt ? calcAgeMonths(serpHost.registeredAt, now) : null,
          ageError: null,
          dr: dr.dr,
          refdomains: serpHost?.refdomains ?? null,
          keywords: ph.keywords,
          prevKeywords: ph.prevKeywords,
          top10: ph.top10,
          top30: ph.top30,
          bestPos: ph.bestPos,
          avgPos: ph.avgPos,
          bounces: ph.bounces,
        },
        {
          now,
          firstRunAt: project.firstRunAt,
          ownDomains: ownDomainsByProject.get(project.id) ?? [],
          isPlatform: ignorePredicate(ignoreByProject.get(project.id) ?? []),
          maxAgeMonths: YOUNG_HOST_MONTHS,
        },
      );
      return {
        projectId: project.id,
        projectName: project.name,
        keywords: ph.keywords,
        top10: ph.top10,
        bestPos: ph.bestPos,
        firstSeenAt: ph.firstSeenAt.toISOString(),
        tags,
      };
    });

    const intel: HostIntel = {
      host,
      registrable,
      own,
      ownPbn: pbn ? { pbnSiteId: pbn.id, status: pbn.status } : null,
      dr: dr.dr,
      drSource: dr.source,
      drCheckedAt: dr.at ? dr.at.toISOString() : null,
      refdomains: serpHost?.refdomains ?? metric?.refDomains ?? null,
      ageMonths: serpHost?.registeredAt ? calcAgeMonths(serpHost.registeredAt, now) : null,
      serpmon,
      linksToUs: (linksBySite.get("") ? [] : [...linksBySite.entries()])
        .filter(([, v]) => [...v.domains].some(d => d === host || d === registrable || apexOf(d) === registrable))
        .map(([siteId, v]) => ({
          siteId,
          label: siteById.get(siteId) ? siteLabel(siteById.get(siteId)!.url) : siteId,
          links: v.links,
          live: v.live,
        })),
      outreach: (prospectByDomain.get(host) ?? prospectByDomain.get(registrable) ?? undefined)
        ? {
            prospectId: (prospectByDomain.get(host) ?? prospectByDomain.get(registrable))!.id,
            stage: (prospectByDomain.get(host) ?? prospectByDomain.get(registrable))!.stage,
          }
        : null,
      drops: registrable && dropByDomain.has(registrable)
        ? {
            candidateId: dropByDomain.get(registrable)!.id,
            stage: dropByDomain.get(registrable)!.stage,
            watched: dropByDomain.get(registrable)!.watched,
          }
        : null,
      asset: registrable && assetByDomain.has(registrable)
        ? { assetId: assetByDomain.get(registrable)!.id, stage: assetByDomain.get(registrable)!.stage }
        : null,
    };
    return intel;
  });

  const query = req.query ? await queryIntel(userId, req, sites as { id: string; siteId: string; url: string }[]) : null;

  const missing = {
    age: out.filter(i => i.ageMonths == null).length,
    dr: out.filter(i => i.dr == null).length,
  };

  return { hosts: out, query, missing };
}

/** The query half: own GSC rows, Rank Tracker, SERP Monitor keyword state, cached metrics. */
async function queryIntel(
  userId: string,
  req: HostsRequest,
  sites: { id: string; siteId: string; url: string }[],
): Promise<QueryIntel | null> {
  const keyword = normaliseKeyword(String(req.query ?? ""));
  if (!keyword) return null;
  const country = String(req.country ?? "").trim().toLowerCase();
  const since = new Date(Date.now() - EXT_QUERY_WINDOW_DAYS * 86_400_000);
  const siteIds = sites.map(s => s.id);
  const labelOf = new Map(sites.map(s => [s.id, siteLabel(s.url)]));

  const [pageRows, trackedRows, keywords, metricRow] = await Promise.all([
    maybe("QueryPageDaily", () => prisma.queryPageDaily.findMany({
      where: { siteId: { in: siteIds }, query: keyword, date: { gte: since } },
      select: { siteId: true, url: true, clicks: true, impressions: true, position: true },
    }), [] as { siteId: string; url: string; clicks: number; impressions: number; position: number }[]),
    maybe("TrackedKeyword", () => prisma.trackedKeyword.findMany({
      where: { siteId: { in: siteIds }, keyword },
      select: {
        id: true, siteId: true, lastPosition: true, lastUrl: true, lastCheckedAt: true,
      },
    }), [] as { id: string; siteId: string; lastPosition: number | null; lastUrl: string | null; lastCheckedAt: Date | null }[]),
    maybe("SerpKeyword", () => prisma.serpKeyword.findMany({
      where: { keyword, project: { userId } },
      select: { id: true, projectId: true, lastStatus: true, lastOkAt: true },
    }), [] as { id: string; projectId: string; lastStatus: string; lastOkAt: Date | null }[]),
    maybe("KeywordMetricCache", () => prisma.keywordMetricCache.findFirst({
      where: { keyword, country: country || "us" },
      orderBy: { checkedAt: "desc" },
      select: { volume: true, difficulty: true, cpc: true, checkedAt: true, provider: true },
    }), null),
  ]);

  // group GSC rows by site+url
  const byPage = new Map<string, { siteId: string; url: string; rows: { impressions: number; position: number }[]; clicks: number }>();
  for (const r of pageRows) {
    const key = `${r.siteId}\u0000${r.url}`;
    const cur = byPage.get(key) ?? { siteId: r.siteId, url: r.url, rows: [], clicks: 0 };
    cur.rows.push({ impressions: r.impressions, position: r.position });
    cur.clicks += r.clicks;
    byPage.set(key, cur);
  }
  const own = [...byPage.values()]
    .map(v => {
      const impressions = v.rows.reduce((s, r) => s + r.impressions, 0);
      return {
        siteId: v.siteId,
        label: labelOf.get(v.siteId) ?? v.siteId,
        url: v.url,
        clicks: v.clicks,
        impressions,
        position: weightedPosition(v.rows) ?? 0,
      };
    })
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, 10);

  const tracked = trackedRows.map(t => ({
    siteId: t.siteId,
    label: labelOf.get(t.siteId) ?? t.siteId,
    keywordId: t.id,
    lastPosition: t.lastPosition,
    lastUrl: t.lastUrl,
    lastCheckedAt: t.lastCheckedAt ? t.lastCheckedAt.toISOString() : null,
  }));

  // project names + last done run storm
  const projects = await maybe("SerpProject", () => prisma.serpProject.findMany({
    where: { userId },
    select: { id: true, name: true, country: true, lang: true },
  }), [] as { id: string; name: string; country: string; lang: string }[]);
  const projectById = new Map(projects.map(p => [p.id, p]));
  const projectIds = [...new Set(keywords.map(k => k.projectId))];
  const runs = projectIds.length
    ? await maybe("SerpRun", () => prisma.serpRun.findMany({
        where: { projectId: { in: projectIds }, status: "done" },
        orderBy: { startedAt: "desc" },
        select: { projectId: true, storm: true, startedAt: true },
      }), [])
    : [];
  const lastStormByProject = new Map<string, boolean>();
  for (const r of runs) if (!lastStormByProject.has(r.projectId)) lastStormByProject.set(r.projectId, !!r.storm);

  const serpmon = keywords.map(k => {
    const p = projectById.get(k.projectId);
    return {
      projectId: k.projectId,
      projectName: p?.name ?? k.projectId,
      keywordId: k.id,
      lastStatus: k.lastStatus,
      lastOkAt: k.lastOkAt ? k.lastOkAt.toISOString() : null,
      lastRunStorm: lastStormByProject.get(k.projectId) ?? false,
    };
  });

  const intel: QueryIntel = {
    query: keyword,
    windowDays: EXT_QUERY_WINDOW_DAYS,
    own,
    tracked,
    serpmon,
    metrics: metricRow
      ? {
          volume: metricRow.volume,
          difficulty: metricRow.difficulty,
          cpc: metricRow.cpc,
          checkedAt: metricRow.checkedAt.toISOString(),
        }
      : null, // cache only — the provider is never fetched from here
  };
  return intel;
}

/** Age (RDAP/WHOIS) + free DR for hosts lacking them. Network, but public sources — no units. */
export async function enrichHosts(userId: string, hosts: string[]): Promise<EnrichResponse> {
  const clean = normaliseHosts(hosts ?? [], EXT_ENRICH_MAX);
  const result: EnrichResponse = { age: 0, dr: 0, errors: 0, remaining: 0 };
  if (!clean.length) return result;

  const before = await maybe("SerpHost(before)", () => prisma.serpHost.findMany({
    where: { host: { in: clean } },
    select: { host: true, registeredAt: true, dr: true },
  }), [] as { host: string; registeredAt: Date | null; dr: number | null }[]);
  const beforeByHost = new Map(before.map(b => [b.host, b]));

  const hostMap = await ensureHosts(clean);
  const hostIds = [...hostMap.values()];
  const captureBodies = await resolveCaptureBodies(userId);
  await withCallContext({ userId, feature: "serpmon-cron", captureBodies }, () =>
    enrichPendingHosts({
      // userId is required for the DR half: without it enrichPendingHosts silently fetched
      // age only, and every overlay row stayed at "DR —".
      userId,
      hostIds,
      limit: EXT_ENRICH_MAX,
      deadline: Date.now() + EXT_ENRICH_DEADLINE_MS,
      what: "both",
    }),
  ).catch(() => { /* the enrichment loop logs its own errors; the answer stays honest below */ });

  const after = await maybe("SerpHost(after)", () => prisma.serpHost.findMany({
    where: { host: { in: clean } },
    select: { host: true, registeredAt: true, dr: true },
  }), [] as { host: string; registeredAt: Date | null; dr: number | null }[]);
  const afterByHost = new Map(after.map(a => [a.host, a]));

  for (const host of clean) {
    const b = beforeByHost.get(host);
    const a = afterByHost.get(host);
    if (!a) { result.errors++; continue; }
    if (a.registeredAt && (!b || !b.registeredAt)) result.age++;
    if (a.dr != null && (!b || b.dr == null)) result.dr++;
    if (!a.registeredAt || a.dr == null) result.remaining++;
  }
  return result;
}
