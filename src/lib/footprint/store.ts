// Portfolio collection for the footprint report (N1) — the Prisma half.
//
// Everything here is LOCAL data: the last completed audit of every live site (published
// titles/descriptions) plus the generation history of the last 180 days (outlines and articles —
// templates caught BEFORE they are published). Zero external requests, so the report is free and
// instant, and the /footprint page says so.
//
// Purity split (wave rule): the string work lives in skeleton.ts, which has no Prisma import and
// runs under node:test without a database. This file only READS rows and turns them into
// FootprintItem[].

import { prisma } from "@/lib/prisma";
import { parseBrandTerms } from "@/lib/aeoTracker";
import { workspaceOwner } from "@/lib/team/owner";
import { readMetaBlock } from "@/lib/seo/metaFit";
import {
  skeletonOf, domainEntity, groupFootprints, similarGroups,
  type FootprintItem, type FootprintKind, type FootprintGroup, type SimilarGroup,
} from "./skeleton";

export * from "./skeleton";

/** How far back the generated half of the report reaches. */
export const HISTORY_WINDOW_DAYS = 180;
/**
 * Newest history records examined. An outline record can carry a 100–300 KB payload (facts
 * bank, sources); 400 of those would be a heavy pull for a page render. The newest 400 is years
 * of typical generation volume, and the number is reported in `scanned.history` so an unusually
 * large studio can see the cap is binding.
 */
export const HISTORY_MAX_RECORDS = 400;
/** SiteAuditPage reads are chunked by this many audit ids (SQLite parameter discipline, ≤ 400). */
const AUDIT_BATCH = 100;

export function footprintSchemaMissing(error: unknown): boolean {
  const value = error as { code?: string; message?: string };
  return (
    value?.code === "P2021" ||
    /(?:SiteAuditPage|SiteAudit|SeoHistory|User).*(?:does not exist|no such table|no such column)/i.test(String(value?.message ?? ""))
  );
}

/** What was read, so the report can say what it looked at (and where the cap is binding). */
export interface FootprintScanned {
  sites: number;
  pages: number;
  history: number;
}

export interface PortfolioData {
  items: FootprintItem[];
  ignored: string[];
  scanned: FootprintScanned;
}

/** The ignore list is a JSON string[] on the owner's User row (schema: `footprintIgnore`). */
export function parseIgnoreList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
  } catch { /* fall through */ }
  return [];
}

/** The site's own entities: domain label (registrable name, hyphens → spaces) + brand terms. */
export function siteEntities(url: string, brandedKeywords: string | null | undefined): string[] {
  const out = [domainEntity(url), ...parseBrandTerms(brandedKeywords)].filter(Boolean);
  return [...new Set(out)];
}

const hostOf = (url: string): string => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return url; }
};

/** First `# …` line of an article — the H1 the generator actually wrote. */
export function firstH1(text: string): string {
  const m = String(text ?? "").match(/^#{1}\s+(.+)$/m);
  return m?.[1]?.trim() ?? "";
}

/**
 * Read the whole portfolio: published audit pages + generation history → items of every kind.
 * Throws raw Prisma errors on a missing table — callers translate via footprintSchemaMissing().
 */
export async function collectPortfolio(userId: string): Promise<PortfolioData> {
  const owner = await prisma.user.findUnique({
    where: { id: userId },
    select: { footprintIgnore: true },
  });
  const ignored = parseIgnoreList(owner?.footprintIgnore);

  const items: FootprintItem[] = [];
  const scanned: FootprintScanned = { sites: 0, pages: 0, history: 0 };

  // ── published: last COMPLETED audit per live site ─────────────────────────────
  const sites = await prisma.site.findMany({
    where: { userId, archivedAt: null },
    select: { id: true, url: true, brandedKeywords: true },
  });
  scanned.sites = sites.length;

  // Latest completed audit per site, newest first, first-seen wins per siteId.
  const audits = await prisma.siteAudit.findMany({
    where: { siteId: { in: sites.map(s => s.id) }, status: "completed" },
    orderBy: { startedAt: "desc" },
    select: { id: true, siteId: true },
  });
  const auditSite = new Map<string, string>();
  for (const a of audits) if (!auditSite.has(a.id)) auditSite.set(a.id, a.siteId);
  // (audits are ordered newest-first per site already; the map keeps the first = latest per site.)
  const latestPerSite = new Set<string>();
  const seenSite = new Set<string>();
  for (const a of audits) {
    if (seenSite.has(a.siteId)) continue;
    seenSite.add(a.siteId);
    latestPerSite.add(a.id);
  }

  const entitiesBySite = new Map(sites.map(s => [s.id, siteEntities(s.url, s.brandedKeywords)]));
  const labelBySite = new Map(sites.map(s => [s.id, hostOf(s.url)]));

  const auditIds = [...latestPerSite];
  for (let i = 0; i < auditIds.length; i += AUDIT_BATCH) {
    const batch = auditIds.slice(i, i + AUDIT_BATCH);
    const pages = await prisma.siteAuditPage.findMany({
      where: { auditId: { in: batch } },
      select: { auditId: true, url: true, title: true, metaDescription: true },
    });
    scanned.pages += pages.length;
    for (const p of pages) {
      const siteId = auditSite.get(p.auditId);
      if (!siteId) continue;
      const entities = entitiesBySite.get(siteId) ?? [];
      const label = labelBySite.get(siteId) ?? siteId;
      if (p.title.trim()) {
        items.push({ skeleton: skeletonOf(p.title, entities), kind: "title", source: "published", identity: siteId, label, example: p.url });
      }
      if (p.metaDescription.trim()) {
        items.push({ skeleton: skeletonOf(p.metaDescription, entities), kind: "description", source: "published", identity: siteId, label, example: p.url });
      }
    }
  }

  // ── generated: outline + text history of the last 180 days ────────────────────
  const cutoff = new Date(Date.now() - HISTORY_WINDOW_DAYS * 86_400_000);
  const history = await prisma.seoHistory.findMany({
    where: { userId, type: { in: ["outline", "text"] }, createdAt: { gte: cutoff } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_MAX_RECORDS,
    select: { id: true, keyword: true, type: true, data: true },
  });
  scanned.history = history.length;

  for (const row of history) {
    const keyword = String(row.keyword ?? "").trim();
    if (!keyword) continue;
    const identity = keyword.toLowerCase(); // "distinct keywords" is case-insensitive in spirit
    const entities = [keyword];
    const example = `history:${row.id}`;
    let payload: unknown = null;
    try { payload = JSON.parse(String(row.data ?? "")); } catch { payload = null; }

    if (row.type === "outline" && payload && typeof payload === "object") {
      const meta = (payload as { meta?: Record<string, unknown> }).meta ?? {};
      const titleOpt = firstString(meta.title_options);
      const descOpt = firstString(meta.description_options);
      const h1 = typeof meta.h1 === "string" ? meta.h1 : "";
      if (titleOpt) items.push({ skeleton: skeletonOf(titleOpt, entities), kind: "title", source: "generated", identity, label: keyword, example });
      if (descOpt) items.push({ skeleton: skeletonOf(descOpt, entities), kind: "description", source: "generated", identity, label: keyword, example });
      if (h1) items.push({ skeleton: skeletonOf(h1, entities), kind: "h1", source: "generated", identity, label: keyword, example });
      continue;
    }

    // text records: data is the article string (meta block at the head + first `# …` line)
    const article = typeof payload === "string" ? payload : "";
    if (!article) continue;
    const block = readMetaBlock(article);
    if (block?.title) items.push({ skeleton: skeletonOf(block.title, entities), kind: "title", source: "generated", identity, label: keyword, example });
    if (block?.description) items.push({ skeleton: skeletonOf(block.description, entities), kind: "description", source: "generated", identity, label: keyword, example });
    const h1 = firstH1(article);
    if (h1) items.push({ skeleton: skeletonOf(h1, entities), kind: "h1", source: "generated", identity, label: keyword, example });
  }

  return { items, ignored, scanned };
}

function firstString(value: unknown): string {
  return Array.isArray(value) ? String(value.find(v => typeof v === "string" && v.trim()) ?? "") : "";
}

export interface FootprintReport {
  kind: FootprintKind;
  minSites: number;
  groups: FootprintGroup[];
  similar: SimilarGroup[];
  ignored: string[];
  scanned: FootprintScanned;
}

export interface ReportOptions {
  kind: FootprintKind;
  minSites?: number;
  includeIgnored?: boolean;
  publishedOnly?: boolean;
}

/**
 * The whole report for one kind. Exact groups first (sorted by sites), then the «similar»
 * section computed over the skeletons that did NOT form qualifying exact groups — per the
 * brief, near-duplicates are a separate list, never mixed into the exact one.
 */
export async function footprintReport(userId: string, opts: ReportOptions): Promise<FootprintReport | { notMigrated: true }> {
  let data: PortfolioData;
  try {
    data = await collectPortfolio(userId);
  } catch (error) {
    if (footprintSchemaMissing(error)) return { notMigrated: true };
    throw error;
  }
  return buildReport(data, opts);
}

/** Pure half of the report — testable without a database. */
export function buildReport(data: PortfolioData, opts: ReportOptions): FootprintReport {
  const minSites = Math.max(2, opts.minSites ?? 2);
  const ignored = new Set(data.ignored);
  let items = data.items.filter(i => i.kind === opts.kind);
  if (opts.publishedOnly) items = items.filter(i => i.source === "published");

  const exact = groupFootprints(items, { minSites });
  const reported = exact
    .filter(g => opts.includeIgnored || !ignored.has(g.skeleton))
    .map(g => (ignored.has(g.skeleton) ? { ...g, ignored: true } : g));
  // Similar section: leftovers only (skeletons that formed no qualifying exact group), and
  // nothing the operator already marked fine.
  const exactSkeletons = new Set(exact.map(g => g.skeleton));
  const leftovers = items.filter(i => !exactSkeletons.has(i.skeleton) && !ignored.has(i.skeleton));
  const similar = similarGroups(leftovers, { minSites });
  return { kind: opts.kind, minSites, groups: reported, similar, ignored: data.ignored, scanned: data.scanned };
}

// ─── occupied skeletons for the generator guard (N1, cache 1 h) ──────────────────

const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: { userId: string; at: number; skeletons: Map<string, Set<string>>; ignored: Set<string> } | null = null;

/** Drop the cache (called when the operator edits the ignore list, so it frees templates at once). */
export function invalidateFootprintCache(): void {
  cache = null;
}

async function portfolioSkeletonMap(userId: string): Promise<{ skeletons: Map<string, Set<string>>; ignored: Set<string> }> {
  if (cache && cache.userId === userId && Date.now() - cache.at < CACHE_TTL_MS) {
    return { skeletons: cache.skeletons, ignored: cache.ignored };
  }
  let data: PortfolioData;
  try {
    data = await collectPortfolio(userId);
  } catch (error) {
    if (footprintSchemaMissing(error)) return { skeletons: new Map(), ignored: new Set() };
    throw error;
  }
  const skeletons = new Map<string, Set<string>>();
  for (const item of data.items) {
    if (item.kind !== "title" && item.kind !== "description") continue;
    const identities = skeletons.get(item.skeleton);
    if (identities) identities.add(item.identity);
    else skeletons.set(item.skeleton, new Set([item.identity]));
  }
  cache = { userId, at: Date.now(), skeletons, ignored: new Set(data.ignored) };
  return { skeletons, ignored: new Set(data.ignored) };
}

/**
 * Skeletons the generator must not reuse: published titles/descriptions of the portfolio plus
 * the history of OTHER keywords (a keyword regenerating itself may keep its own template),
 * minus everything on the ignore list. Empty on an un-migrated instance — the guard then
 * switches itself off, exactly like the brief's "no portfolio data → no block".
 */
export async function occupiedSkeletons(userId: string, excludeKeyword: string): Promise<Set<string>> {
  const { skeletons, ignored } = await portfolioSkeletonMap(userId);
  if (!skeletons.size) return new Set();
  const self = excludeKeyword.trim().toLowerCase();
  const out = new Set<string>();
  for (const [skeleton, identities] of skeletons) {
    if (ignored.has(skeleton)) continue;
    // Occupied when anyone other than the current keyword owns it (published pages own theirs
    // unconditionally — a siteId is never a keyword identity).
    for (const identity of identities) {
      if (identity === self) continue;
      out.add(skeleton);
      break;
    }
  }
  return out;
}

/** The owner's id, for callers (the generator guard) that run outside a request scope. */
export async function portfolioOwnerId(): Promise<string | null> {
  try {
    return await workspaceOwner().then(o => o?.id ?? null);
  } catch {
    return null;
  }
}
