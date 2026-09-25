// T4 — pure queue logic for automatic URL Inspection (docs/tasks/wave-oct/T4-index-autocheck.md).
// No Prisma, no network: everything here is computable from rows the caller already loaded, so
// it is covered by node:test without a database. The DB-touching halves of the feature live in
// quota.ts (the ledger), inspect.ts (the API loop) and scheduler.ts (the tick).

import type { InspectCandidate, InspectOutcome, IndexInspectSettings, InspectPriority } from "./types";
import { INSPECTION_TZ } from "./types";

// ─── quota day ─────────────────────────────────────────────────────────────────

const PT_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: INSPECTION_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** The URL Inspection quota day of `d`: "YYYY-MM-DD" in America/Los_Angeles.
 *  en-CA is the locale trick that makes Intl emit ISO dates directly. */
export function pacificDay(d: Date): string {
  return PT_DAY.format(d);
}

/** "YYYY-MM-DD" of `d` in UTC (IndexCoverageDaily / PageInspectionHistory days are UTC). */
export function utcDayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Midnight UTC of `d`'s day — the `date` value of PageInspectionHistory rows. */
export function utcDayStart(d: Date): Date {
  return new Date(`${utcDayString(d)}T00:00:00.000Z`);
}

/**
 * Milliseconds from `now` until the next midnight America/Los_Angeles (the quota reset).
 *
 * Pacific midnights are 23, 24 or 25 wall-clock hours apart across DST switches, so no fixed
 * offset is right. Binary search over `pacificDay` boundaries instead: `now` and `now + 30h`
 * are guaranteed to be in different PT days (the longest PT day is 25 h), and each step halves
 * the bracket. ~17 Intl formats once per scheduler tick — nothing.
 */
export function msUntilPacificMidnight(now: Date): number {
  const today = pacificDay(now);
  let lo = now.getTime(); // pacificDay(lo) === today
  let hi = now.getTime() + 30 * 3_600_000;
  // Paranoia: a 30 h jump always crosses a midnight, but the invariant is cheap to assert.
  while (pacificDay(new Date(hi)) === today) hi += 3_600_000;
  while (hi - lo > 1_000) {
    const mid = Math.floor((lo + hi) / 2);
    if (pacificDay(new Date(mid)) === today) lo = mid;
    else hi = mid;
  }
  return hi - now.getTime();
}

// ─── coverage classification ──────────────────────────────────────────────────

// The exact strings the URL Inspection API returns for coverageState (English only — the API
// has no other language). Anything unlisted is a state Google introduced after this table was
// written; those classify as null ("не знаю"), never as a guess.
const INDEXED_COVERAGE = new Set([
  "submitted and indexed",
  "indexed, not submitted in sitemap",
]);
const NOT_INDEXED_COVERAGE = new Set([
  "crawled - currently not indexed",
  "discovered - currently not indexed",
  "url is unknown to google",
  "excluded by 'noindex' tag",
  "page with redirect",
  "not found (404)",
  "soft 404",
  "blocked by robots.txt",
  "alternate page with proper canonical tag",
]);

/**
 * Is this inspection result "in the index"? `true`/`false` per the brief's string table,
 * `null` when neither input matches anything known. Case-insensitive: the API is stable
 * English but defensive lowercasing costs nothing. verdict PASS wins first, exactly as the
 * brief orders it; "Duplicate…" has several suffixes, so it matches by prefix.
 */
export function isIndexedCoverage(coverageState: string | null, verdict: string | null): boolean | null {
  if (verdict != null && verdict.trim().toLowerCase() === "pass") return true;
  if (coverageState != null) {
    const s = coverageState.trim().toLowerCase();
    if (INDEXED_COVERAGE.has(s)) return true;
    if (NOT_INDEXED_COVERAGE.has(s) || s.startsWith("duplicate")) return false;
  }
  return null;
}

/**
 * The same classification for `SitemapUrl.googleStatus`, which stores `coverageState ?? verdict`
 * (see inspect.ts). "PASS" is a verdict, never a coverageState, so feeding the combined value
 * through both parameters of the table is exact, not an approximation.
 */
export function statusIndexed(status: string | null): boolean | null {
  if (status == null) return null;
  return isIndexedCoverage(status, status);
}

// ─── priority queue ───────────────────────────────────────────────────────────

/** The row shape `pickInspectBatch` classifies. `lastSeenAt` is optional only for contract
 *  compatibility (CONTRACT.md §3 lists the row without it); the scheduler always passes it. */
export interface InspectRow {
  url: string;
  firstSeenAt: Date;
  googleChecked: Date | null;
  googleNextCheck: Date | null;
  googleStatus: string | null;
  changeStatus: string;
  inventoryStatus: string;
  lastSeenAt?: Date | null;
}

const CHANGED_STATUSES = new Set(["added", "changed", "restored"]);

/**
 * One row's priority right now, or null when the URL must not be picked:
 *   new            googleChecked is null (never inspected)
 *   changed        inventory saw added/changed/restored AND the last inspection predates that
 *   not_indexed    recheck due (googleNextCheck ≤ now) and the previous verdict was "not in index"
 *   stale_indexed  recheck due and the previous verdict was "in index"
 * `new` and `changed` win over rechecks: knowing a page's current state beats refreshing an old one.
 */
export function classifyPriority(row: InspectRow, now: Date): InspectPriority | null {
  if (row.inventoryStatus !== "active") return null;
  if (row.googleChecked == null) return "new";
  // Content changed after the last inspection. Without lastSeenAt (contract rows may omit it)
  // the changeStatus alone is the evidence the inventory sync left, so it still counts.
  if (CHANGED_STATUSES.has(row.changeStatus)
    && (row.lastSeenAt == null || row.googleChecked.getTime() < row.lastSeenAt.getTime())) {
    return "changed";
  }
  if (row.googleNextCheck != null && row.googleNextCheck.getTime() <= now.getTime()) {
    const prev = statusIndexed(row.googleStatus);
    if (prev === false) return "not_indexed";
    if (prev === true) return "stale_indexed";
  }
  return null;
}

/**
 * The batch to inspect next: every row classified, ordered new → changed → not_indexed →
 * stale_indexed, `limit` taken off the top. Inside `new`, the freshest firstSeenAt goes first
 * (new pages are the most likely to have index trouble); every other bucket is ordered by URL
 * so the same database always yields the same batch, whatever order Prisma returned rows in.
 */
export function pickInspectBatch(rows: InspectRow[], now: Date, limit: number): InspectCandidate[] {
  const buckets: Record<InspectPriority, InspectRow[]> = { new: [], changed: [], not_indexed: [], stale_indexed: [] };
  for (const row of rows) {
    const p = classifyPriority(row, now);
    if (p) buckets[p].push(row);
  }
  buckets.new.sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime() || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  for (const key of ["changed", "not_indexed", "stale_indexed"] as const) {
    buckets[key].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  }
  const ordered = [...buckets.new, ...buckets.changed, ...buckets.not_indexed, ...buckets.stale_indexed];
  return ordered.slice(0, Math.max(0, limit)).map(row => ({
    url: row.url,
    priority: classifyPriority(row, now) as InspectPriority,
    firstSeenAt: row.firstSeenAt.toISOString(),
    googleChecked: row.googleChecked ? row.googleChecked.toISOString() : null,
  }));
}

// ─── next check ───────────────────────────────────────────────────────────────

/** FNV-1a: a stable 32-bit hash of the URL, so the same URL always gets the same jitter. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const DAY_MS = 86_400_000;

/**
 * When the queue may look at this URL again: indexed → +recheckIndexedDays, not indexed →
 * +recheckNotIndexedDays, API error (or an unrecognized coverage string) → +1 day. Every
 * deadline gets a deterministic ±10 % jitter hashed from the URL: a thousand URLs inspected
 * on one day must not all become due again on the same later day. Settings come from user
 * input, so the day counts are re-clamped to ≥ 1 here as well as on save.
 */
export function nextCheckAt(outcome: InspectOutcome, settings: IndexInspectSettings, now: Date): Date {
  const days = outcome.ok
    ? Math.max(1, Math.round(outcome.indexed === true ? settings.recheckIndexedDays : settings.recheckNotIndexedDays))
    : 1;
  const base = days * DAY_MS;
  const frac = hash32(outcome.url) / 0xffff_ffff; // [0, 1)
  const jitter = (frac * 2 - 1) * 0.1 * base; // ±10 % of the interval
  return new Date(now.getTime() + Math.round(base + jitter));
}
