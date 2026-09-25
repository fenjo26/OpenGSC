// Local SEO — Prisma access (N4). Everything DB lives here so the pure modules (nap, schema,
// gbpParse, phone) stay importable without a generated client. Table-missing → the routes answer
// { notMigrated: true } (wave-oct README §5), the pattern of drops/store.ts's schemaMissing.

import { prisma } from "@/lib/prisma";
import { directoryLabelFromUrl } from "./citations";
import { isKnownBusinessType, DEFAULT_BUSINESS_TYPE, normaliseHours } from "./schema";
import type { CitationStatus, LocalProfileData, NapDiff, OpeningHoursDay } from "./types";

/** True when the wave-nov Local* / Gbp* tables are not in the DB yet (pulled but not pushed). */
export function localSchemaMissing(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" ||
    /(?:LocalProfile|LocalCitation|GbpPost|GbpReview).*(?:does not exist|no such table)/i.test(String(value?.message ?? ""))
  );
}

// ─── profile ───────────────────────────────────────────────────────────────────

function lines(value: string | null | undefined): string[] {
  return String(value ?? "").split(/\n+/).map(s => s.trim()).filter(Boolean);
}

export function rowToProfileData(row: {
  siteId: string; name: string; businessType: string; street: string; locality: string;
  region: string; postalCode: string; country: string; phone: string; email: string;
  lat: number | null; lng: number | null; hours: string | null; priceRange: string;
  sameAs: string; serviceAreas: string; gbpAccount: string | null; gbpLocation: string | null;
}): LocalProfileData {
  let hours: OpeningHoursDay[] = [];
  try {
    hours = Array.isArray(JSON.parse(row.hours ?? "[]")) ? JSON.parse(row.hours ?? "[]") : [];
  } catch { /* stored garbage degrades to "no hours" */ }
  return {
    siteId: row.siteId,
    name: row.name,
    businessType: isKnownBusinessType(row.businessType) ? row.businessType : DEFAULT_BUSINESS_TYPE,
    street: row.street, locality: row.locality, region: row.region,
    postalCode: row.postalCode, country: (row.country || "").toUpperCase(), phone: row.phone,
    email: row.email, lat: row.lat, lng: row.lng,
    hours: normaliseHours(hours),
    priceRange: row.priceRange,
    sameAs: lines(row.sameAs),
    serviceAreas: lines(row.serviceAreas),
    gbpAccount: row.gbpAccount, gbpLocation: row.gbpLocation,
  };
}

/** Sites of the workspace with a hasProfile flag — the /local page's site selector.
 *  All sites, like /api/gsc/sites: a hidden or archived property can still have a business
 *  profile worth editing. */
export async function listLocalSites(userId: string): Promise<{ id: string; url: string; hasProfile: boolean }[]> {
  const sites = await prisma.site.findMany({
    where: { userId },
    select: { id: true, url: true, localProfile: { select: { id: true } } },
    orderBy: { createdAt: "asc" },
  });
  return sites.map(s => ({ id: s.id, url: s.url, hasProfile: !!s.localProfile }));
}

/** One site row (ownership check included) or null. */
export async function getSite(userId: string, siteDbId: string) {
  return prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true, url: true, siteId: true } });
}

// undefined = no such site in this workspace (the caller's 404); null = the site exists but
// the profile is not filled in yet — a normal state the UI renders an empty form for, never
// an error. Collapsing the two made the first visit to a fresh site answer 404.
export async function getProfile(userId: string, siteDbId: string): Promise<LocalProfileData | null | undefined> {
  const site = await getSite(userId, siteDbId);
  if (!site) return undefined;
  const row = await prisma.localProfile.findUnique({ where: { siteId: site.id } });
  return row ? rowToProfileData(row) : null;
}

export interface ProfilePatch {
  name: string; businessType: string; street: string; locality: string; region: string;
  postalCode: string; country: string; phone: string; email: string;
  lat: number | null; lng: number | null; hours: OpeningHoursDay[]; priceRange: string;
  sameAs: string[]; serviceAreas: string[];
}

export async function saveProfile(userId: string, siteDbId: string, patch: ProfilePatch): Promise<LocalProfileData> {
  const site = await getSite(userId, siteDbId);
  if (!site) throw new Error("site_not_found");
  const data = {
    name: patch.name.trim().slice(0, 200),
    businessType: isKnownBusinessType(patch.businessType) ? patch.businessType : DEFAULT_BUSINESS_TYPE,
    street: patch.street.trim(), locality: patch.locality.trim(), region: patch.region.trim(),
    postalCode: patch.postalCode.trim(), country: patch.country.trim().toUpperCase(),
    phone: patch.phone.trim(), email: patch.email.trim(),
    lat: patch.lat, lng: patch.lng,
    hours: JSON.stringify(normaliseHours(patch.hours)),
    priceRange: patch.priceRange.trim(),
    sameAs: patch.sameAs.join("\n"),
    serviceAreas: patch.serviceAreas.join("\n"),
  };
  if (!data.name) throw new Error("name_required");
  const row = await prisma.localProfile.upsert({ where: { siteId: site.id }, update: data, create: { siteId: site.id, ...data } });
  return rowToProfileData(row);
}

/**
 * Persist the GBP account/location choice (brief §6: выбор аккаунта и локации → gbpAccount/
 * gbpLocation). A null pair clears the selection. The profile must exist — the UI creates it
 * first, and a selection without NAP data has nothing to publish for.
 */
export async function setGbpSelection(
  userId: string, siteDbId: string, gbpAccount: string | null, gbpLocation: string | null,
): Promise<void> {
  const site = await getSite(userId, siteDbId);
  if (!site) throw new Error("site_not_found");
  await prisma.localProfile.update({
    where: { siteId: site.id },
    data: { gbpAccount, gbpLocation },
  });
}

// ─── citations ─────────────────────────────────────────────────────────────────

export interface CitationRow {
  id: string; url: string; directory: string; status: CitationStatus;
  found: { name?: string; phone?: string; address?: string } | null;
  diffs: NapDiff[]; checkedAt: string | null; createdAt: string;
}

function toCitationRow(r: {
  id: string; url: string; directory: string; status: string; found: string | null;
  diffs: string | null; checkedAt: Date | null; createdAt: Date;
}): CitationRow {
  let found: CitationRow["found"] = null;
  let diffs: NapDiff[] = [];
  try { found = r.found ? JSON.parse(r.found) : null; } catch { /* degrade */ }
  try { diffs = r.diffs ? JSON.parse(r.diffs) : []; } catch { /* degrade */ }
  return {
    id: r.id, url: r.url, directory: r.directory, status: r.status as CitationStatus,
    found, diffs, checkedAt: r.checkedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
  };
}

export async function listCitations(userId: string, siteDbId: string): Promise<CitationRow[]> {
  const site = await getSite(userId, siteDbId);
  if (!site) throw new Error("site_not_found");
  const rows = await prisma.localCitation.findMany({ where: { siteId: site.id }, orderBy: { createdAt: "desc" } });
  return rows.map(toCitationRow);
}

export async function addCitation(userId: string, siteDbId: string, url: string): Promise<CitationRow> {
  const site = await getSite(userId, siteDbId);
  if (!site) throw new Error("site_not_found");
  const clean = url.trim();
  if (!/^https?:\/\/\S+$/i.test(clean)) throw new Error("bad_url");
  const existing = await prisma.localCitation.findUnique({ where: { siteId_url: { siteId: site.id, url: clean } } });
  if (existing) return toCitationRow(existing);
  const row = await prisma.localCitation.create({
    data: { siteId: site.id, url: clean, directory: directoryLabelFromUrl(clean), status: "unchecked" },
  });
  return toCitationRow(row);
}

export async function deleteCitation(userId: string, id: string): Promise<void> {
  const row = await prisma.localCitation.findUnique({ where: { id }, select: { id: true, site: { select: { userId: true } } } });
  if (!row || row.site.userId !== userId) throw new Error("citation_not_found");
  await prisma.localCitation.delete({ where: { id } });
}

export async function saveCitationCheck(
  id: string,
  check: { status: CitationStatus; found: CitationRow["found"]; diffs: NapDiff[]; note?: string },
): Promise<void> {
  await prisma.localCitation.update({
    where: { id },
    data: {
      status: check.status,
      found: JSON.stringify(check.found ?? null),
      diffs: JSON.stringify(check.diffs),
      checkedAt: new Date(),
    },
  });
}

/** Citations due for a re-check (checkedAt older than `staleMs`, or never), oldest first. */
export async function dueCitations(staleMs: number, limit: number): Promise<{ id: string; url: string; siteId: string; userId: string }[]> {
  const cutoff = new Date(Date.now() - staleMs);
  const rows = await prisma.localCitation.findMany({
    where: { OR: [{ checkedAt: null }, { checkedAt: { lt: cutoff } }] },
    orderBy: [{ checkedAt: "asc" }, { createdAt: "asc" }],
    take: limit,
    select: { id: true, url: true, siteId: true, site: { select: { userId: true } } },
  });
  return rows.map(r => ({ id: r.id, url: r.url, siteId: r.siteId, userId: r.site.userId }));
}

// ─── GBP posts ─────────────────────────────────────────────────────────────────

export interface GbpPostRow {
  id: string; summary: string; ctaType: string | null; ctaUrl: string | null; mediaUrl: string | null;
  scheduledAt: string; status: string; gbpName: string | null; error: string | null; createdAt: string;
}

export async function listPosts(userId: string, siteDbId: string): Promise<GbpPostRow[]> {
  const site = await getSite(userId, siteDbId);
  if (!site) throw new Error("site_not_found");
  const rows = await prisma.gbpPost.findMany({ where: { siteId: site.id }, orderBy: { scheduledAt: "desc" }, take: 100 });
  return rows.map(r => ({
    id: r.id, summary: r.summary, ctaType: r.ctaType, ctaUrl: r.ctaUrl, mediaUrl: r.mediaUrl,
    scheduledAt: r.scheduledAt.toISOString(), status: r.status, gbpName: r.gbpName, error: r.error,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function createPost(
  userId: string, siteDbId: string,
  input: { summary: string; ctaType: string | null; ctaUrl: string | null; mediaUrl: string | null; scheduledAt: Date; status: "draft" | "scheduled" },
): Promise<GbpPostRow> {
  const site = await getSite(userId, siteDbId);
  if (!site) throw new Error("site_not_found");
  const summary = input.summary.trim();
  if (!summary) throw new Error("summary_required");
  const row = await prisma.gbpPost.create({
    data: {
      siteId: site.id, summary: summary.slice(0, 1500),
      ctaType: input.ctaType, ctaUrl: input.ctaUrl, mediaUrl: input.mediaUrl,
      scheduledAt: input.scheduledAt, status: input.status,
    },
  });
  return { ...row, scheduledAt: row.scheduledAt.toISOString(), createdAt: row.createdAt.toISOString() };
}

export async function deletePost(userId: string, id: string): Promise<void> {
  const row = await prisma.gbpPost.findUnique({ where: { id }, select: { id: true, site: { select: { userId: true } } } });
  if (!row || row.site.userId !== userId) throw new Error("post_not_found");
  await prisma.gbpPost.delete({ where: { id } });
}

/** Posts due for publication (scheduled, scheduledAt in the past), oldest first. */
export async function duePosts(limit: number): Promise<{ id: string; siteId: string; userId: string }[]> {
  const rows = await prisma.gbpPost.findMany({
    where: { status: "scheduled", scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: "asc" },
    take: limit,
    select: { id: true, siteId: true, site: { select: { userId: true } } },
  });
  return rows.map(r => ({ id: r.id, siteId: r.siteId, userId: r.site.userId }));
}

export async function setPostStatus(id: string, status: "published" | "failed", extra: { gbpName?: string | null; error?: string | null } = {}): Promise<void> {
  await prisma.gbpPost.update({ where: { id }, data: { status, gbpName: extra.gbpName ?? null, error: extra.error ?? null } });
}

// ─── GBP reviews ───────────────────────────────────────────────────────────────

export interface GbpReviewStoreRow {
  id: string; reviewId: string; author: string; rating: number; comment: string;
  createTime: string; replyText: string | null; replyTime: string | null; notifiedAt: string | null;
}

export async function listReviews(userId: string, siteDbId: string): Promise<GbpReviewStoreRow[]> {
  const site = await getSite(userId, siteDbId);
  if (!site) throw new Error("site_not_found");
  const rows = await prisma.gbpReview.findMany({ where: { siteId: site.id }, orderBy: { createTime: "desc" }, take: 200 });
  return rows.map(r => ({
    id: r.id, reviewId: r.reviewId, author: r.author, rating: r.rating, comment: r.comment,
    createTime: r.createTime.toISOString(), replyText: r.replyText,
    replyTime: r.replyTime?.toISOString() ?? null, notifiedAt: r.notifiedAt?.toISOString() ?? null,
  }));
}

/**
 * Upsert reviews (SQLite has no createMany+skipDuplicates — the wave-oct §5 rule): read existing
 * review ids, split into inserts and updates, run in one transaction-shaped sequence. Returns the
 * rows that were NEW in this sync (the scheduler notifies about exactly those).
 */
export async function upsertReviews(
  siteDbId: string,
  rows: { reviewId: string; author: string; rating: number; comment: string; createTime: string; replyText: string | null }[],
): Promise<{ inserted: number; updated: number; fresh: typeof rows }> {
  const existing = await prisma.gbpReview.findMany({ where: { siteId: siteDbId }, select: { reviewId: true, replyText: true } });
  const byId = new Map(existing.map(r => [r.reviewId, r]));
  const fresh: typeof rows = [];
  for (const r of rows) {
    if (!byId.has(r.reviewId)) fresh.push(r);
    else {
      const replyChanged = (byId.get(r.reviewId)?.replyText ?? null) !== (r.replyText ?? null);
      await prisma.gbpReview.update({
        where: { siteId_reviewId: { siteId: siteDbId, reviewId: r.reviewId } },
        data: {
          author: r.author, rating: r.rating, comment: r.comment,
          ...(r.createTime ? { createTime: new Date(r.createTime) } : {}),
          fetchedAt: new Date(),
          ...(replyChanged ? { replyText: r.replyText } : {}),
        },
      }).catch(() => { /* a row deleted mid-sync — the next pass re-inserts it */ });
    }
  }
  for (const r of fresh) {
    await prisma.gbpReview.create({
      data: {
        siteId: siteDbId, reviewId: r.reviewId, author: r.author, rating: r.rating,
        comment: r.comment, createTime: r.createTime ? new Date(r.createTime) : new Date(),
        replyText: r.replyText,
      },
    }).catch(() => { /* duplicate raced in — fine */ });
  }
  return { inserted: fresh.length, updated: rows.length - fresh.length, fresh };
}

export async function saveReply(userId: string, reviewDbId: string, text: string, replyTime: Date): Promise<void> {
  const row = await prisma.gbpReview.findUnique({ where: { id: reviewDbId }, select: { id: true, site: { select: { userId: true } } } });
  if (!row || row.site.userId !== userId) throw new Error("review_not_found");
  await prisma.gbpReview.update({ where: { id: reviewDbId }, data: { replyText: text, replyTime } });
}

/** Reviews fetched by the scheduler that were never notified — the notify backlog. */
export async function markReviewsNotified(siteDbId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await prisma.gbpReview.updateMany({ where: { siteId: siteDbId, id: { in: ids } }, data: { notifiedAt: new Date() } });
}

export async function unnotifiedReviews(siteDbId: string, limit = 8): Promise<{ id: string; author: string; rating: number; comment: string }[]> {
  const rows = await prisma.gbpReview.findMany({
    where: { siteId: siteDbId, notifiedAt: null },
    orderBy: { createTime: "asc" },
    take: limit,
    select: { id: true, author: true, rating: true, comment: true },
  });
  return rows;
}
