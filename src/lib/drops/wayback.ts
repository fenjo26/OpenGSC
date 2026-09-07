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
 * What a CDX request actually said, beyond the old collapsed `null`. The archive refuses this
 * app's IP in two very different moods — a 429/403 throttle that clears itself, and a genuine
 * network failure — and everything downstream (error messages, retries, "try later" advice)
 * needs to know which one happened.
 */
export type WaybackFetch =
  | { ok: true; timestamps: string[] }
  | { ok: false; reason: "throttled" | "unreachable" };

/**
 * One shared gate for every CDX call in this process — the history pass, the Wayback slices,
 * the MCP tools all queue through it. The archive rate-limits per IP, and the app is its own
 * worst neighbor: two workers in one request, or two features running at once, used to fire
 * concurrent identical queries. A chain that pins each call at least CDX_MIN_INTERVAL_MS after
 * the previous one settles turns all of those loops into one polite client.
 */
const CDX_MIN_INTERVAL_MS = 1500;
let cdxChain: Promise<unknown> = Promise.resolve();

function cdxGate<T>(task: () => Promise<T>): Promise<T> {
  const run = cdxChain.then(task, task);
  cdxChain = run.then(
    () => new Promise(resolve => setTimeout(resolve, CDX_MIN_INTERVAL_MS)),
    () => new Promise(resolve => setTimeout(resolve, CDX_MIN_INTERVAL_MS)),
  );
  return run;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
 * One CDX query for one domain. Host match, not domain match: ingest already reduces every row
 * to its registrable apex, and a host query is a far cheaper class of archive work than a
 * whole-domain scan — which matters, because the domain scans are exactly what got the server
 * IP throttled in the first place.
 */
export async function fetchWaybackProfile(domain: string): Promise<WaybackFetch & { profile?: WaybackProfile }> {
  const out = await fetchSnapshotTimestamps(domain);
  if (!out.ok) return out;
  return { ok: true, timestamps: out.timestamps, profile: profileFromTimestamps(out.timestamps) };
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
 * its snapshots from. `{ ok: false, reason: "throttled" }` when the archive is rate-limiting the
 * server IP, `"unreachable"` when it simply could not be asked.
 */
export async function fetchSnapshotTimestamps(domain: string): Promise<WaybackFetch> {
  const first = await cdxGate(() => fetchCdxTimestampsOnce(domain));
  // A burst (a 12-domain slice, a 5-row AI pass) trips the per-IP limiter even when the IP is
  // in good standing; one spaced-out retry passes. Two throttles in a row mean the IP itself
  // is in the penalty box — retrying again would only deepen it.
  if (first.ok || first.reason !== "throttled") return first;
  await sleep(2_000);
  return cdxGate(() => fetchCdxTimestampsOnce(domain));
}

async function fetchCdxTimestampsOnce(domain: string): Promise<WaybackFetch> {
  const clean = sanitiseForUrl(domain);
  if (!clean) return { ok: false, reason: "unreachable" };
  const url = "https://web.archive.org/cdx/search/cdx/?url=" + encodeURIComponent(clean) +
    "&matchType=host&output=json&fl=timestamp&collapse=timestamp:4&limit=" + CDX_LIMIT;
  try {
    const res = await safeFetch(url, {
      headers: { accept: "application/json" },
      timeoutMs: 15_000,
      maxBytes: 512 * 1024,
      allowPrivate: false,
    });
    if (res.status === 429 || res.status === 403 || res.status === 503) return { ok: false, reason: "throttled" };
    if (!res.ok) return { ok: false, reason: "unreachable" };
    const raw: unknown = await res.json();
    if (!Array.isArray(raw) || raw.length < 2) return { ok: true, timestamps: [] };
    return { ok: true, timestamps: raw.slice(1).map(row => String(Array.isArray(row) ? row[0] ?? "" : "")) };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
