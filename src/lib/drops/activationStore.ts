// Database side of drops activation. Same rules as store.ts: this is the only
// activation module that talks to Prisma; everything else stays pure.
// Contract: docs/tasks/drops-activation/CONTRACT.md.

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  ACTIVATION_STAGES, DOORWAY_WINDOW_DAYS, GOOGLE_CRAWL_MIN_HITS, isDonorAllowed,
  type ActivationStage,
} from "./activation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema (see store.ts)
const db = prisma as any;

/** Rows per statement — the SQLite parameter ceiling, same number as store.ts. */
const CHUNK = 400;

export interface AssetSummary {
  id: string;
  domain: string;
  stage: string;
  candidateId: string | null;
  urlsTotal: number;
  urlsWayback: number;
  urlsGsc: number;
  donors: number;
  placementsActive: number;
  sitemapBuiltAt: Date | null;
  sitemapUrl: string | null;
  indexnowPushedAt: Date | null;
  indexnowCount: number;
  indexnowLastStatus: string | null;
  gscSiteUrl: string | null;
  gscSitemapSubmittedAt: Date | null;
  lastGoogleHitAt: Date | null;
  googleHits7d: number;
  createdAt: Date;
}

const newKey = () => randomUUID().replace(/-/g, "");

/**
 * Upsert by (userId, domain). The IndexNow key is generated exactly once — the key
 * file deployed on the host goes stale the moment the key changes, so re-ensuring
 * never regenerates it and never resets any progress field.
 */
export async function ensureAsset(
  userId: string,
  domain: string,
  opts?: { candidateId?: string | null },
): Promise<{ id: string; indexnowKey: string }> {
  const existing = (await db.dropAsset.findUnique({
    where: { userId_domain: { userId, domain } },
  })) as { id: string; indexnowKey: string | null } | null;
  if (existing) {
    if (existing.indexnowKey) return { id: existing.id, indexnowKey: existing.indexnowKey };
    // Rows created before the key existed (or by hand) get one exactly here.
    const key = newKey();
    await db.dropAsset.update({ where: { id: existing.id }, data: { indexnowKey: key } });
    return { id: existing.id, indexnowKey: key };
  }
  const created = (await db.dropAsset.create({
    data: {
      userId,
      domain,
      candidateId: opts?.candidateId ?? null,
      indexnowKey: newKey(),
    },
  })) as { id: string; indexnowKey: string };
  return { id: created.id, indexnowKey: created.indexnowKey };
}

export async function listAssets(userId: string): Promise<AssetSummary[]> {
  const assets = (await db.dropAsset.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  })) as AssetSummary[];
  if (!assets.length) return [];

  const ids = assets.map(a => a.id);
  const bySource = new Map<string, { wayback: number; gsc: number; total: number }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const rows = (await db.dropLegacyUrl.groupBy({
      by: ["assetId"],
      where: { assetId: { in: part } },
      _count: { _all: true },
    })) as { assetId: string; _count: { _all: number } }[];
    for (const r of rows) {
      bySource.set(r.assetId, { ...(bySource.get(r.assetId) ?? { wayback: 0, gsc: 0, total: 0 }), total: r._count._all });
    }
    const srcRows = (await db.dropLegacyUrl.groupBy({
      by: ["assetId", "source"],
      where: { assetId: { in: part } },
      _count: { _all: true },
    })) as { assetId: string; source: string; _count: { _all: number } }[];
    for (const r of srcRows) {
      const cur = bySource.get(r.assetId) ?? { wayback: 0, gsc: 0, total: 0 };
      if (r.source === "wayback") cur.wayback = r._count._all;
      if (r.source === "gsc") cur.gsc = r._count._all;
      bySource.set(r.assetId, cur);
    }
  }

  const donorRows = (await db.dropDonor.groupBy({
    by: ["assetId"],
    where: { assetId: { in: ids } },
    _count: { _all: true },
  })) as { assetId: string; _count: { _all: number } }[];
  const donorCounts = new Map(donorRows.map(r => [r.assetId, r._count._all]));

  const placementRows = (await db.dropDonorPlacement.groupBy({
    by: ["assetId"],
    where: { assetId: { in: ids }, active: true },
    _count: { _all: true },
  })) as { assetId: string; _count: { _all: number } }[];
  const placementCounts = new Map(placementRows.map(r => [r.assetId, r._count._all]));

  return assets.map(a => {
    const urls = bySource.get(a.id) ?? { wayback: 0, gsc: 0, total: 0 };
    return {
      ...a,
      urlsTotal: urls.total,
      urlsWayback: urls.wayback,
      urlsGsc: urls.gsc,
      donors: donorCounts.get(a.id) ?? 0,
      placementsActive: placementCounts.get(a.id) ?? 0,
    };
  });
}

export async function getAsset(userId: string, domain: string): Promise<{
  asset: {
    id: string; domain: string; stage: string; indexnowKey: string | null;
    gscSiteUrl: string | null; gscSitemapPath: string | null; gscSitemapSubmittedAt: Date | null;
    sitemapUrl: string | null; sitemapBuiltAt: Date | null;
    indexnowPushedAt: Date | null; indexnowCount: number; indexnowLastStatus: string | null;
    lastGoogleHitAt: Date | null; googleHits7d: number;
    note: string | null; createdAt: Date;
  };
  urls: { url: string; source: string; inGsc: boolean; lastSeenAt: Date | null }[];
  donors: { url: string }[];
  placements: { doorway: string; donorUrl: string; placedAt: Date; active: boolean }[];
} | null> {
  const row = (await db.dropAsset.findUnique({
    where: { userId_domain: { userId, domain } },
    include: {
      urls: { orderBy: { createdAt: "asc" } },
      donors: { orderBy: { createdAt: "asc" } },
      placements: { orderBy: { placedAt: "desc" } },
    },
  })) as null | {
    id: string; domain: string; stage: string; indexnowKey: string | null;
    gscSiteUrl: string | null; gscSitemapPath: string | null; gscSitemapSubmittedAt: Date | null;
    sitemapUrl: string | null; sitemapBuiltAt: Date | null;
    indexnowPushedAt: Date | null; indexnowCount: number; indexnowLastStatus: string | null;
    lastGoogleHitAt: Date | null; googleHits7d: number;
    note: string | null; createdAt: Date;
    urls: { url: string; source: string; inGsc: boolean; lastSeenAt: Date | null }[];
    donors: { url: string }[];
    placements: { doorway: string; donorUrl: string; placedAt: Date; active: boolean }[];
  };
  if (!row) return null;
  const { urls, donors, placements, ...asset } = row;
  return { asset, urls, donors, placements };
}

export async function setAssetStage(userId: string, domain: string, stage: ActivationStage): Promise<void> {
  if (!ACTIVATION_STAGES.includes(stage)) throw new Error("bad_stage");
  await db.dropAsset.update({ where: { userId_domain: { userId, domain } }, data: { stage } });
}

export async function setAssetNote(userId: string, domain: string, note: string): Promise<void> {
  await db.dropAsset.update({ where: { userId_domain: { userId, domain } }, data: { note } });
}

/**
 * Upsert legacy URLs by (assetId, url). `markInGsc` is the GSC harvest's way of saying
 * "seen in the property": an existing row flips inGsc + lastSeenAt instead of
 * duplicating, which is what makes the two sources converge on one URL list.
 */
export async function addLegacyUrls(
  userId: string,
  assetId: string,
  rows: { url: string; source: "wayback" | "gsc" | "manual" }[],
  opts?: { markInGsc?: boolean },
): Promise<{ added: number; updated: number }> {
  await assertAsset(userId, assetId);

  const seen = new Set<string>();
  const fresh: { url: string; source: string }[] = [];
  for (const r of rows) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    fresh.push({ url: r.url, source: r.source });
  }

  let added = 0;
  let updated = 0;
  const now = new Date();
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const part = fresh.slice(i, i + CHUNK);
    const existing = (await db.dropLegacyUrl.findMany({
      where: { assetId, url: { in: part.map(r => r.url) } },
      select: { url: true },
    })) as { url: string }[];
    const have = new Set(existing.map(r => r.url));
    updated += existing.length;
    const create = part.filter(r => !have.has(r.url));
    if (create.length) {
      const res = (await db.dropLegacyUrl.createMany({
        data: create.map(r => ({
          assetId, url: r.url, source: r.source,
          inGsc: opts?.markInGsc && r.source === "gsc" ? true : false,
          lastSeenAt: opts?.markInGsc && r.source === "gsc" ? now : null,
        })),
      })) as { count: number };
      added += res.count;
    }
    if (opts?.markInGsc && existing.length) {
      await db.dropLegacyUrl.updateMany({
        where: { assetId, url: { in: existing.map(r => r.url) } },
        data: { inGsc: true, lastSeenAt: now },
      });
    }
  }
  return { added, updated };
}

/** A built sitemap is the first real progress marker: empty-stage assets become "ready". */
export async function setSitemapBuilt(
  userId: string,
  assetId: string,
  p: { url: string; count: number },
): Promise<void> {
  const asset = await assertAsset(userId, assetId);
  await db.dropAsset.update({
    where: { id: assetId },
    data: {
      sitemapUrl: p.url,
      sitemapBuiltAt: new Date(),
      ...(asset.stage === "new" || asset.stage === "harvesting" ? { stage: "ready" } : {}),
    },
  });
}

export async function setGscSite(
  userId: string,
  assetId: string,
  p: { siteUrl: string; sitemapPath: string },
): Promise<void> {
  await assertAsset(userId, assetId);
  await db.dropAsset.update({
    where: { id: assetId },
    data: { gscSiteUrl: p.siteUrl, gscSitemapPath: p.sitemapPath, gscSitemapSubmittedAt: new Date() },
  });
}

/** Cumulative count, latest status. `count` = URLs actually accepted this run. */
export async function recordIndexnowPush(
  userId: string,
  assetId: string,
  p: { count: number; status: string },
): Promise<void> {
  await assertAsset(userId, assetId);
  await db.dropAsset.update({
    where: { id: assetId },
    data: {
      indexnowCount: { increment: p.count },
      indexnowPushedAt: new Date(),
      indexnowLastStatus: p.status,
    },
  });
}

/**
 * Replace-all donor list. Validation happens for the WHOLE list before any write —
 * a rejected donor must not leave a half-applied list behind.
 */
export async function setDonors(
  userId: string,
  assetId: string,
  urls: string[],
): Promise<{ added: number; removed: number }> {
  const asset = await assertAsset(userId, assetId);
  const clean = [...new Set(urls.map(u => u.trim()).filter(Boolean))];
  const rejected = clean.filter(u => !isDonorAllowed(asset.domain, u));
  if (rejected.length) {
    const err = new Error("donor_not_allowed") as Error & { rejected?: string[] };
    err.rejected = rejected;
    throw err;
  }

  const existing = (await db.dropDonor.findMany({
    where: { assetId },
    select: { url: true },
  })) as { url: string }[];
  const have = new Set(existing.map(r => r.url));
  const want = new Set(clean);

  const toRemove = [...have].filter(u => !want.has(u));
  const toAdd = clean.filter(u => !have.has(u));

  for (let i = 0; i < toRemove.length; i += CHUNK) {
    await db.dropDonor.deleteMany({ where: { assetId, url: { in: toRemove.slice(i, i + CHUNK) } } });
  }
  for (let i = 0; i < toAdd.length; i += CHUNK) {
    await db.dropDonor.createMany({
      data: toAdd.slice(i, i + CHUNK).map(url => ({ assetId, url })),
    });
  }
  return { added: toAdd.length, removed: toRemove.length };
}

/**
 * Doorways with confirmed Google crawl, computed fresh from IndexerDailyStat on every
 * call. Never stored — a stored list rots within a month as crawl patterns shift.
 */
export async function eligibleDoorways(userId: string, opts?: {
  days?: number;
  minGoogleHits?: number;
}): Promise<{ domainId: string; domain: string; googleHits: number }[]> {
  const days = opts?.days ?? DOORWAY_WINDOW_DAYS;
  const min = opts?.minGoogleHits ?? GOOGLE_CRAWL_MIN_HITS;
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const grouped = (await db.indexerDailyStat.groupBy({
    by: ["domainId"],
    where: { botType: "google", date: { gte: from } },
    _sum: { count: true },
  })) as { domainId: string; _sum: { count: number | null } }[];

  const hitIds = grouped
    .map(g => ({ domainId: g.domainId, hits: g._sum.count ?? 0 }))
    .filter(g => g.hits >= min);
  if (!hitIds.length) return [];

  const domains = (await db.indexerDomain.findMany({
    where: { userId, id: { in: hitIds.map(g => g.domainId) }, status: "active" },
    select: { id: true, domain: true },
  })) as { id: string; domain: string }[];
  const nameById = new Map(domains.map(d => [d.id, d.domain]));

  return hitIds
    .filter(g => nameById.has(g.domainId))
    .map(g => ({ domainId: g.domainId, domain: nameById.get(g.domainId)!, googleHits: g.hits }))
    .sort((a, b) => b.googleHits - a.googleHits);
}

/**
 * Record (doorway × donor) placements AND enqueue the donor URLs into the doorway's
 * IndexerQueue — the queue is the live injection the deployed scripts already read.
 * The footprint rule is re-checked here against the stored asset domain: the route
 * validates, this validates again, so a caller cannot forget half of the rule.
 */
export async function addPlacements(
  userId: string,
  assetId: string,
  doorwayDomain: string,
  donorUrls: string[],
): Promise<{ added: number }> {
  const asset = await assertAsset(userId, assetId);
  const urls = [...new Set(donorUrls.map(u => u.trim()).filter(Boolean))];
  const rejected = urls.filter(u => !isDonorAllowed(asset.domain, u));
  if (rejected.length) {
    const err = new Error("donor_not_allowed") as Error & { rejected?: string[] };
    err.rejected = rejected;
    throw err;
  }

  const doorway = (await db.indexerDomain.findFirst({
    where: { userId, domain: doorwayDomain },
    select: { id: true },
  })) as { id: string } | null;
  if (!doorway) throw new Error("doorway_not_found");

  const now = new Date();
  let added = 0;
  for (let i = 0; i < urls.length; i += CHUNK) {
    const part = urls.slice(i, i + CHUNK);
    const res = (await db.dropDonorPlacement.createMany({
      data: part.map(donorUrl => ({
        assetId, doorway: doorwayDomain, donorUrl, placedAt: now, active: true,
      })),
      skipDuplicates: true,
    })) as { count: number };
    added += res.count;
    // Reactivate rows that already existed (a re-run must refresh placedAt, not skip it).
    await db.dropDonorPlacement.updateMany({
      where: { assetId, doorway: doorwayDomain, donorUrl: { in: part } },
      data: { active: true, placedAt: now },
    });
    // Idempotent enqueue: existing queue rows keep their crawledAt rotation state.
    await db.indexerQueue.createMany({
      data: part.map(url => ({ domainId: doorway.id, url })),
      skipDuplicates: true,
    });
  }
  return { added };
}

export async function recordCrawlLog(
  userId: string,
  assetId: string,
  p: { lastGoogleHitAt: Date | null; googleHits7d: number },
): Promise<void> {
  await assertAsset(userId, assetId);
  await db.dropAsset.update({
    where: { id: assetId },
    data: { lastGoogleHitAt: p.lastGoogleHitAt, googleHits7d: p.googleHits7d },
  });
}

/** Internal guard: every writer resolves the asset through the caller's userId first. */
async function assertAsset(
  userId: string,
  assetId: string,
): Promise<{ id: string; domain: string; stage: string }> {
  const row = (await db.dropAsset.findFirst({
    where: { id: assetId, userId },
    select: { id: true, domain: true, stage: true },
  })) as { id: string; domain: string; stage: string } | null;
  if (!row) throw new Error("asset_not_found");
  return row;
}
