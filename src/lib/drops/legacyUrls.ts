// The URL harvest behind the activation sitemap: what the Wayback Machine and GSC
// remember of the acquired domain, reduced to one clean per-asset URL list.
//
// Split like wayback.ts: everything that decides which rows count (parseCdxOriginals,
// normalizeUrlSet, gscPageUrls, capLegacyUrls) is pure and offline-testable; only
// fetchWaybackUrls touches the network. Task: docs/tasks/drops-activation/T2-legacy-sitemap-gsc.md.

import { safeFetch } from "@/lib/security/safeFetch";
import { normalizeLegacyUrl } from "./activation";
import { sanitiseForUrl } from "./availability";

/**
 * Sitemap-size guard, NOT a display cap. A single urlset beyond 50 000 URLs is out of
 * spec for sitemap consumers, and this pipeline does not build a sitemap index — so the
 * harvest stops here and says so (`capped: true` in the route response).
 */
export const LEGACY_URL_CAP = 50_000;

/// One CDX row per distinct original URL — `collapse=urlkey` keeps the latest capture of
/// each. The ceiling matches LEGACY_URL_CAP: fetching more than we can store is waste.
const CDX_URL_LIMIT = 50_000;

// ── pure: CDX/GSC rows → candidate URLs ─────────────────────────────────────────

/**
 * CDX JSON rows (first row is the header, `fl=original`) → the original-URL strings.
 * A malformed reply yields zero candidates, never a guess — same rule as parseCdxRows:
 * a fabricated history would end up in a sitemap pretending pages exist.
 */
export function parseCdxOriginals(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const out: string[] = [];
  for (const row of raw.slice(1)) {
    const cell = Array.isArray(row) ? String(row[0] ?? "") : "";
    if (cell) out.push(cell);
  }
  return out;
}

/**
 * normalizeLegacyUrl over a candidate list: foreign hosts (the CDX `matchType=host`
 * still returns the bare domain row sometimes, and GSC sc-domain properties cover every
 * subdomain), fragments and malformed rows all drop here. Survivors dedupe preserving
 * first-seen order — CDX returns the latest capture first, so the newest scheme wins.
 */
export function normalizeUrlSet(urls: string[], host: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const u = normalizeLegacyUrl(raw, host);
    if (u === null || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * `page`-dimension rows from the Search Analytics API (queryGsc's return value) → the
 * page URLs. `page` is the only dimension the harvest asks for, so `keys[0]` is the
 * canonical GSC page URL; rows without it count for nothing.
 */
export function gscPageUrls(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const out: string[] = [];
  for (const r of rows) {
    const keys = (r as { keys?: unknown }).keys;
    if (Array.isArray(keys) && typeof keys[0] === "string" && keys[0]) out.push(keys[0]);
  }
  return out;
}

/**
 * How many of `incoming` still fit an asset that already stores `existing` URLs. The cap
 * is per asset, not per harvest: a Wayback pass that fills 50 000 leaves a later GSC pass
 * nothing to add, and the `capped` flag is the route's way of saying the list was cut,
 * not that the source ran dry.
 */
export function capLegacyUrls(
  existing: number,
  incoming: string[],
  cap = LEGACY_URL_CAP,
): { urls: string[]; capped: boolean } {
  const room = Math.max(0, cap - Math.max(0, existing));
  const urls = incoming.slice(0, room);
  return { urls, capped: urls.length < incoming.length };
}

// ── network: one CDX query for the URL list ─────────────────────────────────────

export type LegacyWaybackFetch =
  | { ok: true; urls: string[] }
  | { ok: false; reason: "throttled" | "unreachable" };

/**
 * The CDX gate discipline of wayback.ts, mirrored here. The archive rate-limits per IP
 * and the app is its own worst neighbor, so every CDX call in a process must queue
 * through one chain pinned CDX_MIN_INTERVAL_MS apart. wayback.ts's `cdxGate` is
 * module-private and that file is outside this task's ownership — the constants,
 * statuses and retry shape are kept identical so the two behave as one polite client;
 * exporting cdxGate from wayback.ts would collapse them into literally one.
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
 * Distinct original URLs the archive holds for one host. Host match, not domain match,
 * for the same reason as fetchSnapshotTimestamps: a host query is a far cheaper class of
 * archive work, and the domain scans are what got this server's IP throttled.
 * `{ ok: false, reason: "throttled" }` on a 429/403/503 with one spaced-out retry,
 * `"unreachable"` when the archive simply could not be asked.
 */
export async function fetchWaybackUrls(domain: string): Promise<LegacyWaybackFetch> {
  const first = await cdxGate(() => fetchCdxUrlsOnce(domain));
  if (first.ok || first.reason !== "throttled") return first;
  await sleep(2_000);
  return cdxGate(() => fetchCdxUrlsOnce(domain));
}

async function fetchCdxUrlsOnce(domain: string): Promise<LegacyWaybackFetch> {
  const clean = sanitiseForUrl(domain);
  if (!clean) return { ok: false, reason: "unreachable" };
  const url = "https://web.archive.org/cdx/search/cdx/?url=" + encodeURIComponent(clean) +
    "&matchType=host&output=json&fl=original&collapse=urlkey&limit=" + CDX_URL_LIMIT;
  try {
    const res = await safeFetch(url, {
      headers: { accept: "application/json" },
      // A 50 000-row reply is megabytes, not the half-KB of the collapsed timeline —
      // but still a rounding error next to the memory the sitemap build itself needs.
      timeoutMs: 30_000,
      maxBytes: 32 * 1024 * 1024,
      allowPrivate: false,
    });
    if (res.status === 429 || res.status === 403 || res.status === 503) return { ok: false, reason: "throttled" };
    if (!res.ok) return { ok: false, reason: "unreachable" };
    const raw: unknown = await res.json();
    return { ok: true, urls: parseCdxOriginals(raw) };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
