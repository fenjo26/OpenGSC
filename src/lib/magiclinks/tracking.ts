// Purchased-placement tracking — the loop closer for меджики.
//
// A purchase ends when the provider accepts the order, but the money's question starts there:
// is the bought link still standing, with the same anchor and the same rel? This module writes a
// paid order's publication URLs into SiteBacklink — the model the placement checker, the event
// history and the toxicity pass already live on — so bought links join the same verification
// pipeline as every other donor instead of growing a second, weaker checker beside it.
//
// Write rule (CONTRACT.md §1, one writer more): the purchase import names identity + source +
// sources + purchase* on create, and on an existing row only claims provenance (purchase* plus
// appending "purchase" to sources). It never touches check*, api* or tox*: a donor Ahrefs already
// knows must keep both sides of the story.
//
// Degrade convention, same as the ledger: before `prisma db push` every function here returns
// its empty answer instead of crashing, so the feature is absent rather than broken.

import { prisma } from "@/lib/prisma";
import { rawQuery, rawExec } from "@/lib/db/raw";
import { normalizeBacklinkUrl, donorHostOf } from "@/lib/seo/backlinkImport";
import { backlinksNotMigrated } from "@/lib/backlinks/store";
import { fieldLinkClientFor, magic369ClientFor } from "./providers";
import { PROVIDER_FIELDLINK, PROVIDER_MAGIC369_LINKS, providerName, type MagicProviderId } from "./purchases";
import type { FieldLinkRow } from "./fieldlink";
import type { Magic369Article, Magic369Link, Magic369OrderStatus } from "./magic369";

/** One bought placement: a donor page that should be linking at one of our pages. */
export interface PurchasedPlacement {
  donorUrl: string;  // publication URL (FieldLink destination / 369Team published_url)
  targetUrl: string; // our page the brief promised
}

// ─── pure: what an order's rows and articles contribute ───────────────────────

/** FieldLink: a row is a placement only once it completed and carries a destination — a
 *  processing row is money in flight, not a donor to watch. */
export function placementsFromFieldLink(rows: FieldLinkRow[]): PurchasedPlacement[] {
  const out: PurchasedPlacement[] = [];
  for (const r of rows) {
    const donorUrl = String(r.result?.destination ?? "").trim();
    const targetUrl = String(r.input?.targetUrl ?? "").trim();
    if (donorUrl && targetUrl) out.push({ donorUrl, targetUrl });
  }
  return out;
}

/** 369Team: the articles list IS the placement list — an entry appears once published. */
export function placementsFromMagic369(articles: Magic369Article[]): PurchasedPlacement[] {
  const out: PurchasedPlacement[] = [];
  for (const a of articles) {
    const donorUrl = String(a.publishedUrl ?? "").trim();
    const targetUrl = String(a.url ?? "").trim();
    if (donorUrl && targetUrl) out.push({ donorUrl, targetUrl });
  }
  return out;
}

/** 369Team homepage links: the donor is the homepage the link sits on (page_url). The spec
 *  documents page_url as the site's homepage; website is the fallback when it is empty. */
export function placementsFromMagic369Links(links: Magic369Link[]): PurchasedPlacement[] {
  const out: PurchasedPlacement[] = [];
  for (const l of links) {
    let donorUrl = String(l.pageUrl ?? "").trim();
    if (!donorUrl && l.website) {
      const w = String(l.website).trim();
      donorUrl = /^https?:\/\//i.test(w) ? w : `https://${w}/`;
    }
    const targetUrl = String(l.url ?? "").trim();
    if (donorUrl && targetUrl) out.push({ donorUrl, targetUrl });
  }
  return out;
}

/** Terminal = the provider will publish nothing else under this order, so the tracking pass can
 *  stop polling it. "partial" is terminal the same way: what failed will not appear later. */
export function isFieldLinkTerminal(status: string): boolean {
  return status === "completed" || status === "partial" || status === "failed";
}

/** 369Team status enum (spec v1.1): awaiting_content, generating, queued, in_progress — live;
 *  completed, partially_completed, failed — final. finalized_at is set on the final ones. The
 *  older "partial"/"cancelled" spellings stay accepted: harmless, and cheap insurance. */
export function isMagic369Terminal(order: { status: string; finalizedAt?: string | null }): boolean {
  return !!order.finalizedAt
    || order.status === "completed"
    || order.status === "partially_completed"
    || order.status === "partial"
    || order.status === "failed"
    || order.status === "cancelled";
}

/** Append to the comma-separated sources list without duplicates or ordering surprises. */
export function mergeSources(existing: string, add: string): string {
  const parts = existing.split(",").map(s => s.trim()).filter(Boolean);
  if (add && !parts.includes(add)) parts.push(add);
  return parts.join(",");
}

// ─── pulse (pure fold; the DB read below it is a thin wrapper) ─────────────────

export interface PulseRow {
  purchaseProvider: string;
  checkStatus: string;
  checkedAt: Date | null;
  /** donor's Google-index verdict from the XML River pass; "" = never checked */
  xrStatus?: string;
}

export interface ProviderPulse {
  provider: string;
  name: string;
  placements: number;
  found: number;
  missing: number;
  blocked: number;
  error: number;
  unchecked: number;
  /** donors the xr pass confirmed in Google's index */
  indexed: number;
  /** donors the xr pass found OUT of the index — the links there are dead weight even when
   *  they physically stand; prime candidates for the indexer queue */
  notIndexed: number;
  /** donors whose index status nobody has checked yet */
  xrUnchecked: number;
  lastCheckedAt: string | null;
}

/** "unchecked" is the honest fourth state and not a missing data point: a placement nobody has
 *  verified yet is exactly the "unconfirmed" his checker separates from "gone", and lumping it
 *  with missing would cry wolf on every freshly imported order. */
export function foldPulse(rows: PulseRow[]): ProviderPulse[] {
  const byProvider = new Map<string, ProviderPulse>();
  for (const r of rows) {
    const provider = String(r.purchaseProvider || "");
    if (!provider) continue;
    let acc = byProvider.get(provider);
    if (!acc) {
      acc = {
        provider, name: providerName(provider),
        placements: 0, found: 0, missing: 0, blocked: 0, error: 0, unchecked: 0,
        indexed: 0, notIndexed: 0, xrUnchecked: 0, lastCheckedAt: null,
      };
      byProvider.set(provider, acc);
    }
    acc.placements++;
    const status = String(r.checkStatus || "unchecked");
    if (status === "found") acc.found++;
    else if (status === "missing") acc.missing++;
    else if (status === "blocked") acc.blocked++;
    else if (status === "error") acc.error++;
    else acc.unchecked++;
    const xr = String(r.xrStatus ?? "");
    if (xr === "indexed") acc.indexed++;
    else if (xr === "not_indexed") acc.notIndexed++;
    else acc.xrUnchecked++;
    const iso = r.checkedAt ? r.checkedAt.toISOString() : null;
    if (iso && (!acc.lastCheckedAt || iso > acc.lastCheckedAt)) acc.lastCheckedAt = iso;
  }
  return [...byProvider.values()].sort((a, b) => b.placements - a.placements);
}

export async function purchasedPulse(userId: string): Promise<ProviderPulse[]> {
  try {
    const rows = await prisma.siteBacklink.findMany({
      where: { purchaseProvider: { not: "" }, site: { userId } },
      select: { purchaseProvider: true, checkStatus: true, checkedAt: true, xrStatus: true },
    });
    return foldPulse(rows);
  } catch {
    return []; // not migrated — the card is simply absent
  }
}

// ─── ledger: which orders still owe their placements ──────────────────────────

export interface PendingOrder {
  userId: string;
  siteId: string;
  provider: MagicProviderId;
  orderId: string;
  createdAt: Date;
}

/** Distinct orders with unimported placements. Raw SQL per the ledger's convention; the age
 *  window is bound as parameters (not SQL date functions) so the statement is dialect-portable
 *  as written. */
export async function untrackedOrders(limit = 5): Promise<PendingOrder[]> {
  const to = new Date(Date.now() - 2 * 3600_000);   // give the provider time to publish
  const from = new Date(Date.now() - 45 * 86_400_000); // older than that, nobody is coming
  try {
    const rows = await rawQuery<{
      userId: string; siteId: string; provider: string; orderId: string; createdAt: Date | string;
    }[]>(
      `SELECT s."userId" AS "userId", p."siteId" AS "siteId", p."provider" AS "provider",
              p."orderId" AS "orderId", MIN(p."createdAt") AS "createdAt"
       FROM "MagicPurchase" p JOIN "Site" s ON s."id" = p."siteId"
       WHERE p."trackedAt" IS NULL AND p."createdAt" > ? AND p."createdAt" < ?
       GROUP BY p."orderId", s."userId", p."siteId", p."provider"
       ORDER BY MIN(p."createdAt") ASC
       LIMIT ?`,
      from, to, limit,
    );
    return rows.map(r => ({
      userId: r.userId,
      siteId: r.siteId,
      provider: r.provider as MagicProviderId,
      orderId: r.orderId,
      createdAt: new Date(r.createdAt),
    }));
  } catch {
    return [];
  }
}

/** The ledger's row for an order: which site it belongs to and whether tracking is done. Orders
 *  with no ledger rows are not ours (bought in the provider's own UI) and return null. */
export async function orderOwner(
  orderId: string,
): Promise<{ userId: string; siteId: string; provider: MagicProviderId; trackedAt: Date | null } | null> {
  try {
    const rows = await rawQuery<
      Array<{ userId: string; siteId: string; provider: string; trackedAt: Date | string | null }>
    >(
      `SELECT s."userId" AS "userId", p."siteId" AS "siteId", p."provider" AS "provider", p."trackedAt" AS "trackedAt"
       FROM "MagicPurchase" p JOIN "Site" s ON s."id" = p."siteId"
       WHERE p."orderId" = ? LIMIT 1`,
      orderId,
    );
    const r = rows?.[0];
    if (!r) return null;
    return {
      userId: r.userId,
      siteId: r.siteId,
      provider: r.provider as MagicProviderId,
      trackedAt: r.trackedAt == null ? null : new Date(r.trackedAt),
    };
  } catch {
    return null;
  }
}

export async function markOrderTracked(provider: string, orderId: string): Promise<void> {
  try {
    await rawExec(
      `UPDATE "MagicPurchase" SET "trackedAt" = ? WHERE "provider" = ? AND "orderId" = ?`,
      new Date(), provider, orderId,
    );
  } catch { /* not migrated — the pass will simply look again */ }
}

// ─── the import itself ─────────────────────────────────────────────────────────

export interface ImportResult {
  imported: number; // rows created
  updated: number;  // existing rows that gained purchase provenance
  skipped: number;  // unusable pairs (no donor, no target, donor = target) or write failures
}

export async function importPurchasedPlacements(args: {
  siteId: string;
  provider: MagicProviderId;
  orderId: string;
  placements: PurchasedPlacement[];
}): Promise<ImportResult> {
  const out: ImportResult = { imported: 0, updated: 0, skipped: 0 };
  const seen = new Set<string>();
  for (const p of args.placements) {
    const urlFromNorm = normalizeBacklinkUrl(p.donorUrl);
    const urlTo = String(p.targetUrl).trim();
    if (!urlFromNorm || !urlTo || urlFromNorm === normalizeBacklinkUrl(urlTo)) {
      out.skipped++;
      continue;
    }
    // The same pair twice in one order is one placement, not two rows fighting over a unique key.
    const key = `${urlFromNorm}\n${urlTo}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const existing = await prisma.siteBacklink.findUnique({
        where: { siteId_urlFromNorm_urlTo: { siteId: args.siteId, urlFromNorm, urlTo } },
        select: { id: true, sources: true },
      });
      if (existing) {
        await prisma.siteBacklink.update({
          where: { id: existing.id },
          data: {
            purchaseProvider: args.provider,
            purchaseOrderId: args.orderId,
            sources: mergeSources(existing.sources ?? "", "purchase"),
          },
        });
        out.updated++;
      } else {
        await prisma.siteBacklink.create({
          data: {
            siteId: args.siteId,
            urlFrom: p.donorUrl,
            urlFromNorm,
            urlTo,
            domainFrom: donorHostOf(p.donorUrl),
            source: "purchase",
            sources: "purchase",
            purchaseProvider: args.provider,
            purchaseOrderId: args.orderId,
          },
        });
        out.imported++;
      }
    } catch (e) {
      if (backlinksNotMigrated(e)) return out; // tables absent: stop, the answer is "nothing imported"
      out.skipped++;
    }
  }
  return out;
}

// ─── one order end to end: fetch, import, mark ────────────────────────────────

/** Poll one order at its provider and import whatever it has published. Skips orders already
 *  tracked (a terminal order will publish nothing new). Used by the verify scheduler; the
 *  /magiclinks order view does the same inline with the data it already fetched. */
export async function syncOrderPlacements(
  userId: string,
  provider: MagicProviderId,
  orderId: string,
): Promise<ImportResult | null> {
  const owner = await orderOwner(orderId);
  if (!owner || owner.trackedAt) return null;

  let placements: PurchasedPlacement[];
  let terminal: boolean;
  if (provider === PROVIDER_FIELDLINK) {
    const client = await fieldLinkClientFor(userId);
    if (!client) return null;
    const { order, rows } = await client.order(orderId);
    placements = placementsFromFieldLink(rows);
    terminal = isFieldLinkTerminal(order.status);
  } else if (provider === PROVIDER_MAGIC369_LINKS) {
    const client = await magic369ClientFor(userId);
    if (!client) return null;
    const order: Magic369OrderStatus = await client.linkOrder(orderId);
    const links = await client.linkOrderLinks(orderId).catch(() => []);
    placements = placementsFromMagic369Links(links);
    terminal = isMagic369Terminal(order);
  } else {
    const client = await magic369ClientFor(userId);
    if (!client) return null;
    const order: Magic369OrderStatus = await client.order(orderId);
    const articles = await client.orderArticles(orderId).catch(() => []);
    placements = placementsFromMagic369(articles);
    terminal = isMagic369Terminal(order);
  }

  const result = await importPurchasedPlacements({
    siteId: owner.siteId,
    provider,
    orderId,
    placements,
  });
  if (terminal) await markOrderTracked(provider, orderId);
  return result;
}
