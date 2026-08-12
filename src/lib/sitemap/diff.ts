import type { SitemapInventoryEntry } from "./inventory";

export interface ExistingInventoryRow {
  id: string;
  url: string;
  sourceSitemap: string | null;
  sitemapType: string;
  lastmod: string | null;
  lastmodValid: boolean | null;
  imageCount: number;
  videoCount: number;
  newsCount: number;
  inventoryStatus: string;
  missingSyncs: number;
}

export type SeenChange = "added" | "changed" | "restored" | "unchanged";

export function sitemapEntryChanged(existing: ExistingInventoryRow, entry: SitemapInventoryEntry): boolean {
  return existing.sourceSitemap !== entry.sourceSitemap
    || existing.sitemapType !== entry.sitemapType
    || existing.lastmod !== entry.lastmod
    || existing.lastmodValid !== entry.lastmodValid
    || existing.imageCount !== entry.imageCount
    || existing.videoCount !== entry.videoCount
    || existing.newsCount !== entry.newsCount;
}

export function classifySeenEntry(existing: ExistingInventoryRow | undefined, entry: SitemapInventoryEntry): SeenChange {
  if (!existing) return "added";
  if (existing.inventoryStatus === "missing" || existing.inventoryStatus === "pending_missing") return "restored";
  return sitemapEntryChanged(existing, entry) ? "changed" : "unchanged";
}

export function planMissingTransitions(
  existing: ExistingInventoryRow[],
  seenUrls: Set<string>,
  partial: boolean,
): { pendingIds: string[]; missingIds: string[]; pendingMissing: number; disappeared: number } {
  // This is the safety invariant: a failed/partial tree provides no negative evidence.
  if (partial) return { pendingIds: [], missingIds: [], pendingMissing: 0, disappeared: 0 };
  const unseen = existing.filter(row => !seenUrls.has(row.url));
  const pending = unseen.filter(row => row.missingSyncs < 1);
  const missing = unseen.filter(row => row.missingSyncs >= 1);
  return {
    pendingIds: pending.map(row => row.id),
    missingIds: missing.map(row => row.id),
    pendingMissing: pending.length,
    disappeared: missing.filter(row => row.inventoryStatus !== "missing").length,
  };
}
