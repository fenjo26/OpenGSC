// The history stage: what the Wayback Machine remembers about a domain.
//
// Free, keyless, and slow-ish — one CDX query per domain is all this needs. The numbers it
// returns answer the two questions a drop buyer asks of history: how long the site actually
// lived (first → last snapshot) and how long it has been dead since (today → last snapshot).
// A domain archived monthly for a decade and silent for three years is a different purchase
// from one archived last week, and the score consumes exactly that difference.
//
// Snapshot counts are collapsed to one per month (`collapse=timestamp:4`). Raw counts reach
// five digits for old domains, which would make the column unreadable and the number useless;
// "how many months of it survived" is also the shape the AI history pass will need later.

import { safeFetch } from "@/lib/security/safeFetch";
import { sanitiseForUrl } from "./availability";

export interface WaybackProfile {
  /** Months with at least one snapshot, oldest first, capped at the query limit. */
  snapshots: number;
  firstAt: Date | null;
  lastAt: Date | null;
  /** Whole days since the last snapshot. `null` when the domain has none — unknown, not dead. */
  gapDays: number | null;
}

const CDX_LIMIT = 2000;

/**
 * CDX rows (JSON array, first row is the header) to a profile.
 *
 * Split from the network so the interesting part — which rows count and what a broken reply
 * must never be read as — is testable without hitting web.archive.org. A malformed reply yields
 * zero snapshots, never a guess: an empty history says "unknown", a fabricated one says
 * "dead for years", and only one of those is safe to sort a purchase decision by.
 */
export function parseCdxRows(raw: unknown, now = new Date()): WaybackProfile {
  const empty: WaybackProfile = { snapshots: 0, firstAt: null, lastAt: null, gapDays: null };
  if (!Array.isArray(raw) || raw.length < 2) return empty;

  const times: Date[] = [];
  // Row 0 is the header (`fl=timestamp` → ["timestamp"]). Everything after must be a row whose
  // first cell is a 4–14 digit timestamp; CDX pads to 14 digits, older rows may be shorter.
  for (const row of raw.slice(1)) {
    const cell = Array.isArray(row) ? String(row[0] ?? "") : "";
    const m = cell.match(/^(\d{4})(\d{2})?(\d{2})?/);
    if (!m) continue;
    const date = new Date(
      Number(m[1]),
      Number(m[2] ?? "01") - 1,
      Number(m[3] ?? "01"),
    );
    if (!Number.isNaN(date.getTime())) times.push(date);
  }
  if (!times.length) return empty;

  times.sort((a, b) => a.getTime() - b.getTime());
  const firstAt = times[0];
  const lastAt = times[times.length - 1];
  const gapDays = Math.max(0, Math.floor((now.getTime() - lastAt.getTime()) / 86_400_000));
  return { snapshots: times.length, firstAt, lastAt, gapDays };
}

/**
 * One CDX query for one domain, subdomains included. `null` on any failure — the archive being
 * down, rate-limiting, or slow is information about the archive, not about the domain.
 */
export async function fetchWaybackProfile(domain: string): Promise<WaybackProfile | null> {
  const rows = await fetchCdxTimestamps(domain);
  if (rows === null) return null;
  return profileFromTimestamps(rows);
}

/** Months from a collapsed timeline → the profile. Split out so it can be tested offline. */
export function profileFromTimestamps(timestamps: string[], now = new Date()): WaybackProfile {
  const empty: WaybackProfile = { snapshots: 0, firstAt: null, lastAt: null, gapDays: null };
  const times = cdxToDates(timestamps);
  if (!times.length) return empty;
  const firstAt = times[0];
  const lastAt = times[times.length - 1];
  return {
    snapshots: times.length,
    firstAt,
    lastAt,
    gapDays: Math.max(0, Math.floor((now.getTime() - lastAt.getTime()) / 86_400_000)),
  };
}

function cdxToDates(cells: string[]): Date[] {
  const times: Date[] = [];
  for (const cell of cells) {
    const m = cell.match(/^(\d{4})(\d{2})?(\d{2})?/);
    if (!m) continue;
    const date = new Date(Number(m[1]), Number(m[2] ?? "01") - 1, Number(m[3] ?? "01"));
    if (!Number.isNaN(date.getTime())) times.push(date);
  }
  return times.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * The collapsed timeline itself — one 14-digit timestamp per month, for the history pass to pick
 * its snapshots from. `null` on archive failure, `[]` when the archive simply has nothing.
 */
export async function fetchSnapshotTimestamps(domain: string): Promise<string[] | null> {
  const rows = await fetchCdxTimestamps(domain);
  return rows;
}

async function fetchCdxTimestamps(domain: string): Promise<string[] | null> {
  const clean = sanitiseForUrl(domain);
  if (!clean) return null;
  const url = "https://web.archive.org/cdx/search/cdx/?url=" + encodeURIComponent(clean) +
    "&matchType=domain&output=json&fl=timestamp&collapse=timestamp:4&limit=" + CDX_LIMIT;
  try {
    const res = await safeFetch(url, {
      headers: { accept: "application/json" },
      timeoutMs: 15_000,
      maxBytes: 512 * 1024,
      allowPrivate: false,
    });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    if (!Array.isArray(raw) || raw.length < 2) return [];
    return raw.slice(1).map(row => String(Array.isArray(row) ? row[0] ?? "" : ""));
  } catch {
    return null;
  }
}
