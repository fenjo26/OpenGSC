// Placement verification runner — answers "is our link still standing on this donor page
// right now?", with which anchor and which rel. Built on T2's parser (linkPlacement.ts);
// everything around it lives here: fetching, retries, politeness, status classification,
// DB writes, events, progress.
//
// The old check-alive answers a different, weaker question — "does the page return 2xx?".
// A donor that removed the link but kept the page showed a green check. The two questions
// are kept strictly separate as two independent fields (CONTRACT.md §0):
//
//   pageStatus   — is the donor PAGE reachable: unknown | alive | dead | blocked
//   checkStatus  — is OUR LINK on it:        unchecked | found | missing | blocked | error
//
// pageStatus "alive" + checkStatus "missing" is the "they dropped us" signal — the only
// one this feature exists for. The failure mode to prevent at all costs is a FALSE
// "missing": a WAF 403 that we recorded as a removed link sends the user to accuse a
// placement partner over our User-Agent. So "missing" is produced by exactly two paths:
// an opened HTML page with no hit, and a 404/410 (page gone — link gone with it, but for
// a different reason, hence pageStatus "dead"). Everything else is blocked or error, and
// neither ever generates an event: an event is a statement, and about a refused or failed
// check we know nothing.

import { prisma } from "@/lib/prisma";
import { safeFetch, SafeFetchError, type SafeFetchErrorCode } from "@/lib/security/safeFetch";
// T0's type module does not exist on this branch yet (parallel wave, docs/tasks/README.md):
// the import is type-only, so tsx erases it and the unit tests run pre-merge; `tsc` reports
// it until T0 lands and clears it by existing. Do not convert to a value import.
import type {
  BacklinkEventKind,
  PageStatus,
  PlacementHit,
  PlacementStatus,
  SyncSummary,
} from "@/lib/seo/backlinkTypes";

// T2's parser is loaded dynamically for the same reason: this branch is reviewed before T2's
// lands, and a static import would break `npm run test:unit` for logic that does not need it.
// Everything in this file above the first scan call — classification, best-hit choice, event
// generation, queue grouping — is pure and unit-tested without it.
async function loadParser(): Promise<typeof import("@/lib/seo/linkPlacement")> {
  return import("@/lib/seo/linkPlacement");
}

const UA = "Mozilla/5.0 (compatible; OpenGSC-PlacementCheck/1.0; +https://opengsc.org)";
const ATTEMPTS = 3;
const BACKOFF_MS = [0, 1_200, 3_500]; // same scheme as check-alive: a cheap check gets short backoffs
const CONCURRENCY = 4;                // same as the audit crawler
const POLITENESS_DELAY_MS = 150;      // per worker, between requests
const PAGE_TIMEOUT_MS = 15_000;
// Same ceiling as check-alive's body pass. Deliberately generous: a page over the cap raises
// response_too_large and lands in "no verdict", and a heavy page is not a missing link.
const MAX_BYTES = 8 * 1024 * 1024;
const ROW_CHUNK = 100;
const PROGRESS_EVERY = 10;

// A 403 from Cloudflare is a refusal to answer our User-Agent, not a verdict on the link.
const blockedStatus = (s: number) => s === 401 || s === 403 || s === 429;
// The page is verifiably gone; the link is gone with it — but "page removed", not "link removed".
const deadStatus = (s: number) => s === 404 || s === 410;
// Transient: worth another attempt inside this run. A firm 404 is never re-asked.
const retryableStatus = (s: number) => s === 429 || s === 408 || s >= 500;

export const VERIFY_FILTERS = ["all", "missing", "favorites", "unchecked"] as const;
export type VerifyFilter = (typeof VERIFY_FILTERS)[number];

/** Verify-run summary: SyncSummary (CONTRACT.md §2, read by the digest) plus the fields only
 *  the verify path produces. Additive — T6's reader ignores unknown keys. */
export interface VerifySummary extends SyncSummary {
  /** rows where Ahrefs sees the link only after JS render (apiJsCrawl) and raw HTML said
   *  missing — NOT a removal; the UI shows blchkJsHint on these ids. */
  jsSuspect: number;
  jsSuspectIds: string[];
  /** single-row Firecrawl rechecks performed in this run (0 in mass runs) */
  renderUsed: number;
}

// ─── pure: status classification ───────────────────────────────────────────────

export type StatusPair = { checkStatus: PlacementStatus; pageStatus: PageStatus; checkError: string };

/**
 * A page that opened (2xx/3xx) and was parsed. The ONLY function allowed to produce
 * checkStatus "missing" — and only when the page really is HTML we could read.
 */
export function classifyOpenPage(hitsFound: boolean, isHtml: boolean): StatusPair {
  if (!isHtml) return { checkStatus: "error", pageStatus: "alive", checkError: "non_html" };
  return hitsFound
    ? { checkStatus: "found", pageStatus: "alive", checkError: "" }
    : { checkStatus: "missing", pageStatus: "alive", checkError: "" };
}

/**
 * A page that did not open: final HTTP status after retries, or 0 when every attempt fell
 * over (network, DNS, timeout). 401/403/429 → the site refused us; 404/410 → page gone,
 * link gone with it (missing + dead, so the UI reads "page was removed", not "link was
 * removed"); anything else → no verdict either way.
 */
export function classifyFailedFetch(httpStatus: number): StatusPair {
  if (httpStatus <= 0) return { checkStatus: "blocked", pageStatus: "unknown", checkError: "network" };
  if (blockedStatus(httpStatus)) return { checkStatus: "blocked", pageStatus: "blocked", checkError: `http_${httpStatus}` };
  if (deadStatus(httpStatus)) return { checkStatus: "missing", pageStatus: "dead", checkError: `http_${httpStatus}` };
  return { checkStatus: "error", pageStatus: "unknown", checkError: `http_${httpStatus}` };
}

// ─── pure: best hit + target agreement ─────────────────────────────────────────

/** Protocol-insensitive, www-insensitive, trailing-slash-insensitive URL equality (query
 *  must match exactly; hash is ignored). Just strict enough to say "this is the agreed page". */
export function urlsEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const host = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");
    const path = (u: URL) => u.pathname.replace(/\/+$/, "") || "/";
    return host(ua) === host(ub) && path(ua) === path(ub) && (ua.search || "") === (ub.search || "");
  } catch {
    return false;
  }
}

export interface ChosenHit {
  hit: PlacementHit;
  /** does the chosen link point at the promised urlTo; null when urlTo is empty — nothing to compare against */
  targetOk: boolean | null;
}

/**
 * Several of our links may live on one donor. The row gets the best one:
 * the one matching the promised urlTo → the first dofollow → the first in page order.
 */
export function pickBestHit(hits: PlacementHit[], urlTo: string): ChosenHit | null {
  if (!hits.length) return null;
  const target = urlTo ? hits.find(h => urlsEquivalent(h.linkUrl, urlTo)) : undefined;
  const hit = target ?? hits.find(h => h.rel.dofollow) ?? hits[0];
  // With no link at all there is nothing to agree or disagree with — targetOk stays null.
  const targetOk = urlTo ? urlsEquivalent(hit.linkUrl, urlTo) : null;
  return { hit, targetOk };
}

// ─── pure: events ──────────────────────────────────────────────────────────────

/** The check*-fields of a row as they were before / will be after one verification. */
export interface CheckSnapshot {
  checkStatus: string;
  checkAnchor: string;
  checkRel: string;
  checkNofollow: boolean;
  checkSponsored: boolean;
  checkUgc: boolean;
}

export interface EventDraft {
  kind: BacklinkEventKind;
  /** JSON string per contract: {"from":"…","to":"…"} */
  detail: string;
}

const relIsDofollow = (s: CheckSnapshot) => !(s.checkNofollow || s.checkSponsored || s.checkUgc);
const detailOf = (from: string, to: string) =>
  JSON.stringify({ from: from.slice(0, 200), to: to.slice(0, 200) });

/**
 * Transitions worth an event, origin "check". blocked/error produce NONE — we do not know
 * what happened, and an event is an assertion. `prev` unchecked records no event either:
 * the first check establishes the baseline, it is not a change.
 */
export function diffCheckEvents(prev: CheckSnapshot, next: CheckSnapshot): EventDraft[] {
  const verdicts = new Set(["found", "missing"]);
  if (!verdicts.has(next.checkStatus)) return [];
  if (!verdicts.has(prev.checkStatus)) return [];

  const events: EventDraft[] = [];
  if (prev.checkStatus === "found" && next.checkStatus === "missing") {
    events.push({ kind: "lost", detail: detailOf("found", "missing") });
    return events; // a lost link has no anchor/rel to compare
  }
  if (prev.checkStatus === "missing" && next.checkStatus === "found") {
    events.push({ kind: "returned", detail: detailOf("missing", "found") });
    return events;
  }
  if (prev.checkStatus === "found" && next.checkStatus === "found") {
    if (prev.checkAnchor && next.checkAnchor && prev.checkAnchor !== next.checkAnchor) {
      events.push({ kind: "anchor_changed", detail: detailOf(prev.checkAnchor, next.checkAnchor) });
    }
    const prevDofollow = relIsDofollow(prev);
    const nextDofollow = relIsDofollow(next);
    if (prevDofollow && !nextDofollow) {
      events.push({ kind: "rel_downgraded", detail: detailOf(prev.checkRel || "dofollow", next.checkRel || "nofollow") });
    } else if (!prevDofollow && nextDofollow) {
      events.push({ kind: "rel_upgraded", detail: detailOf(prev.checkRel || "nofollow", next.checkRel || "dofollow") });
    }
  }
  return events;
}

// ─── pure: host-grouped queue ──────────────────────────────────────────────────

export function hostOf(urlFrom: string): string {
  try {
    return new URL(urlFrom).hostname.toLowerCase();
  } catch {
    return urlFrom.trim().toLowerCase();
  }
}

export interface HostGroup<T> {
  host: string;
  rows: T[];
}

/**
 * Two URLs of one donor must never be fetched concurrently — a hundred pages of one площадка
 * hitting the server at once looks like an attack, not like a check. Grouping by host makes
 * each group a serial unit a single worker drains start to finish. Longest group first, so
 * the four workers spend the run's tail on small sites instead of one big one.
 */
export function groupByHost<T extends { urlFrom: string }>(rows: T[]): HostGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const host = hostOf(row.urlFrom);
    const bucket = map.get(host);
    if (bucket) bucket.push(row);
    else map.set(host, [row]);
  }
  return [...map.entries()]
    .map(([host, groupRows]) => ({ host, rows: groupRows }))
    .sort((a, b) => b.rows.length - a.rows.length);
}

// ─── pure: TLS failure detection ───────────────────────────────────────────────

// Node/OpenSSL certificate verification codes for "the certificate itself could not be
// trusted" — the expired/self-signed/unknown-issuer class that small donors are full of.
// CERT_REVOKED is deliberately absent: a revoked certificate is a live security warning,
// not routine rot, and belongs to the error path even when the caller opted into insecure.
const CERT_FAILURE_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_SIGNATURE_FAILURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_CA_CERT_REQUIRED",
]);

export function isTlsCertFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CERT_FAILURE_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ─── fetch layer ───────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A URL from a CSV import may arrive scheme-less; the fetch layer needs it absolute. */
export function absolutizeUrl(urlFrom: string): string {
  const trimmed = urlFrom.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const NON_RETRYABLE_FETCH_CODES: SafeFetchErrorCode[] = [
  "invalid_url",
  "unsupported_protocol",
  "credentials_not_allowed",
  "response_too_large",
  "too_many_redirects",
];

export type DonorFetch =
  | { kind: "ok"; httpStatus: number; contentType: string; body: string; finalUrl: string }
  | { kind: "http"; httpStatus: number }
  | { kind: "network"; error: string };

export interface DonorFetchMeta {
  /** the page was fetched with TLS certificate verification off — content is unauthenticated */
  insecure: boolean;
}

/**
 * Fetch one donor page: retries only the transient class (429/408/5xx, network drops,
 * timeouts) with the check-alive backoff. A TLS certificate failure is retried ONCE with
 * verification off — but only when the caller explicitly opted in per run, and the result
 * is marked insecure so the UI can say so (blchkInsecure). The private-address guard inside
 * safeFetch is never affected by that retry.
 */
export async function fetchDonorPage(
  urlFrom: string,
  opts: { allowInsecureTls?: boolean } = {},
): Promise<DonorFetch & DonorFetchMeta> {
  const url = absolutizeUrl(urlFrom);
  const request = (insecure: boolean) =>
    safeFetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      redirect: "follow",
      timeoutMs: PAGE_TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      ...(insecure ? { allowInsecureTls: true } : {}),
    });

  const readOk = async (res: Awaited<ReturnType<typeof safeFetch>>): Promise<DonorFetch & DonorFetchMeta> => {
    const contentType = res.headers.get("content-type") ?? "";
    // Empty content-type treated as HTML, same convention as the audit crawler.
    const isHtml = contentType.includes("html") || contentType === "";
    if (!isHtml) return { kind: "ok", httpStatus: res.status, contentType, body: "", finalUrl: res.url, insecure: false };
    const { decodeBody } = await loadParser();
    const body = decodeBody(await res.arrayBuffer(), contentType);
    return { kind: "ok", httpStatus: res.status, contentType, body, finalUrl: res.url, insecure: false };
  };

  let lastCode = "network";
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const res = await request(false);
      if (retryableStatus(res.status) && attempt < ATTEMPTS - 1) {
        await sleep(BACKOFF_MS[attempt + 1] + Math.random() * 400);
        continue;
      }
      if (res.status >= 200 && res.status < 400) return readOk(res);
      return { kind: "http", httpStatus: res.status, insecure: false };
    } catch (error) {
      lastCode = error instanceof SafeFetchError ? error.code : "network";

      // Certificate rot never heals within one run: without the opt-in there is no point
      // re-asking, and with it the single insecure retry below is the answer.
      if (isTlsCertFailure(error) && !opts.allowInsecureTls) break;

      // Certificate rot: one cautious retry without verification, only on explicit opt-in.
      if (opts.allowInsecureTls && isTlsCertFailure(error)) {
        try {
          const res = await request(true);
          if (res.status >= 200 && res.status < 400) {
            const out = await readOk(res);
            return { ...out, insecure: true };
          }
          return { kind: "http", httpStatus: res.status, insecure: true };
        } catch {
          // The insecure retry failed too (network-level) — fall through to the normal
          // backoff/retry loop below.
        }
      }

      if (error instanceof SafeFetchError && NON_RETRYABLE_FETCH_CODES.includes(error.code)) break;
      if (attempt < ATTEMPTS - 1) await sleep(BACKOFF_MS[attempt + 1] + Math.random() * 400);
    }
  }
  return { kind: "network", error: lastCode, insecure: false };
}

// ─── scan one row ──────────────────────────────────────────────────────────────

export interface RowCheckInput {
  id: string;
  urlFrom: string;
  urlTo: string;
  apiJsCrawl: boolean;
}

export interface RowCheckResult extends StatusPair {
  hit: PlacementHit | null;
  targetOk: boolean | null;
  pageTitle: string;
  insecure: boolean;
  /** apiJsCrawl + missing: raw HTML cannot confirm a JS-inserted link — not a removal */
  jsSuspect: boolean;
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]{0,300})<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

export async function scanOneRow(
  row: RowCheckInput,
  ownedDomains: string[],
  opts: { allowInsecureTls?: boolean } = {},
): Promise<RowCheckResult> {
  const fetchResult = await fetchDonorPage(row.urlFrom, opts);

  if (fetchResult.kind === "network") {
    const pair = classifyFailedFetch(0);
    return { ...pair, checkError: fetchResult.error, hit: null, targetOk: null, pageTitle: "", insecure: fetchResult.insecure, jsSuspect: false };
  }
  if (fetchResult.kind === "http") {
    const pair = classifyFailedFetch(fetchResult.httpStatus);
    return { ...pair, hit: null, targetOk: null, pageTitle: "", insecure: fetchResult.insecure, jsSuspect: false };
  }

  const isHtml = fetchResult.contentType.includes("html") || fetchResult.contentType === "";
  const { findPlacements } = await loadParser();
  const hits = isHtml
    ? findPlacements(fetchResult.body, fetchResult.finalUrl, ownedDomains, { sourceUrl: row.urlFrom })
    : [];
  const chosen = pickBestHit(hits, row.urlTo);
  const pair = classifyOpenPage(!!chosen, isHtml);
  return {
    ...pair,
    hit: chosen?.hit ?? null,
    targetOk: chosen?.targetOk ?? null,
    pageTitle: isHtml ? extractTitle(fetchResult.body) : "",
    insecure: fetchResult.insecure,
    jsSuspect: row.apiJsCrawl && pair.checkStatus === "missing",
  };
}

// ─── DB write layer ────────────────────────────────────────────────────────────

// Pre-T0 this branch has no siteBacklink models in the generated client; `as any` keeps the
// file compilable now and correct after T0's migration lands.
const backlinkStore = () => (prisma as any).siteBacklink;
const eventStore = () => (prisma as any).siteBacklinkEvent;
const syncStore = () => (prisma as any).siteBacklinkSync;

/** The check* group and nothing else — api, favorite, note and urlTo belong to other writers
 *  (CONTRACT.md §1: one row, three writers, each names only its own fields). pageTitle is
 *  written only when this check actually read a page, so a blocked check never blanks a
 *  title a previous check did read. */
export function buildCheckUpdate(result: RowCheckResult, now: Date) {
  const hit = result.hit;
  return {
    checkStatus: result.checkStatus,
    checkAnchor: hit?.anchor ?? "",
    checkRel: hit?.rel.raw ?? "",
    checkNofollow: hit?.rel.nofollow ?? false,
    checkSponsored: hit?.rel.sponsored ?? false,
    checkUgc: hit?.rel.ugc ?? false,
    checkFoundUrl: hit?.linkUrl ?? "",
    checkMatchedDomain: hit?.matchedDomain ?? "",
    checkTargetOk: result.targetOk,
    checkError: result.checkError,
    checkInsecure: result.insecure,
    checkedAt: now,
    pageStatus: result.pageStatus,
    ...(result.pageTitle ? { pageTitle: result.pageTitle } : {}),
    pageCheckedAt: now,
  };
}

function snapshotOf(row: {
  checkStatus: string; checkAnchor: string; checkRel: string;
  checkNofollow: boolean; checkSponsored: boolean; checkUgc: boolean;
}): CheckSnapshot {
  return {
    checkStatus: row.checkStatus,
    checkAnchor: row.checkAnchor,
    checkRel: row.checkRel,
    checkNofollow: row.checkNofollow,
    checkSponsored: row.checkSponsored,
    checkUgc: row.checkUgc,
  };
}

function snapshotFromResult(result: RowCheckResult): CheckSnapshot {
  return {
    checkStatus: result.checkStatus,
    checkAnchor: result.hit?.anchor ?? "",
    checkRel: result.hit?.rel.raw ?? "",
    checkNofollow: result.hit?.rel.nofollow ?? false,
    checkSponsored: result.hit?.rel.sponsored ?? false,
    checkUgc: result.hit?.rel.ugc ?? false,
  };
}

// ─── summary ───────────────────────────────────────────────────────────────────

export interface SummaryAccumulator {
  scanned: number;
  withLink: number;
  zeroMatches: number;
  errors: number;
  blocked: number;
  jsSuspectIds: string[];
  renderUsed: number;
  byDomain: Record<string, number>;
  byError: Record<string, number>;
}

export function newSummary(): SummaryAccumulator {
  return { scanned: 0, withLink: 0, zeroMatches: 0, errors: 0, blocked: 0, jsSuspectIds: [], renderUsed: 0, byDomain: {}, byError: {} };
}

export function tallyRow(acc: SummaryAccumulator, row: { id: string; domainFrom: string; urlFrom: string }, result: RowCheckResult): void {
  acc.scanned++;
  const domain = row.domainFrom || hostOf(absolutizeUrl(row.urlFrom));
  acc.byDomain[domain] = (acc.byDomain[domain] ?? 0) + 1;
  if (result.checkStatus === "found") acc.withLink++;
  else if (result.checkStatus === "missing") acc.zeroMatches++;
  else if (result.checkStatus === "blocked") acc.blocked++;
  else if (result.checkStatus === "error") acc.errors++;
  if (result.checkError) acc.byError[result.checkError] = (acc.byError[result.checkError] ?? 0) + 1;
  if (result.jsSuspect) acc.jsSuspectIds.push(row.id);
}

export function finishSummary(acc: SummaryAccumulator, complete: boolean): VerifySummary {
  return {
    scanned: acc.scanned,
    withLink: acc.withLink,
    zeroMatches: acc.zeroMatches,
    errors: acc.errors,
    blocked: acc.blocked,
    byDomain: acc.byDomain,
    byError: acc.byError,
    unitsSpent: 0, // verify is our own HTTP; Firecrawl rechecks are counted in renderUsed, not Ahrefs units
    complete,
    jsSuspect: acc.jsSuspectIds.length,
    jsSuspectIds: acc.jsSuspectIds,
    renderUsed: acc.renderUsed,
  };
}

// ─── job runner ────────────────────────────────────────────────────────────────

const activeRuns = new Set<string>();

export function isVerifyRunning(siteId: string): boolean {
  return activeRuns.has(siteId);
}

function filterWhere(filter?: string): Record<string, unknown> {
  switch (filter) {
    case "missing": return { checkStatus: "missing" };
    case "favorites": return { favorite: true };
    case "unchecked": return { checkStatus: "unchecked" };
    default: return {}; // "all" and absent — the whole selection
  }
}

const ROW_SELECT = {
  id: true, urlFrom: true, urlTo: true, domainFrom: true, apiJsCrawl: true,
  checkStatus: true, checkAnchor: true, checkRel: true,
  checkNofollow: true, checkSponsored: true, checkUgc: true,
} as const;

export interface VerifyRunParams {
  siteId: string;
  ids?: string[];
  filter?: string;
  allowInsecureTls?: boolean;
}

/**
 * Background verification over a whole selection. No `take` anywhere: the queue covers the
 * entire filtered set, progress is written to SiteBacklinkSync so the user can close the
 * tab, and the run finishes on its own. Rows are claimed host-group by host-group, so one
 * donor's pages are always serial while four hosts run in parallel.
 */
export async function runPlacementVerify(syncId: string, params: VerifyRunParams): Promise<void> {
  const { siteId } = params;
  if (activeRuns.has(siteId)) return;
  activeRuns.add(siteId);
  const acc = newSummary();

  try {
    const sync = await syncStore().findUnique({ where: { id: syncId } });
    if (!sync) return;
    const site = await prisma.site.findUnique({ where: { id: siteId }, select: { url: true } });
    if (!site) throw new Error("site_not_found");

    const { canonicalizeDomain } = await loadParser();
    const rawSiteUrl = site.url.replace(/^sc-domain:/i, "").trim();
    const ownedDomain = canonicalizeDomain(rawSiteUrl) ?? hostOf(`https://${rawSiteUrl}`);
    // An unresolved own domain would turn every row into "missing" — the exact false signal
    // this feature must never emit. Refuse the run instead.
    if (!ownedDomain) throw new Error("site_domain_unresolved");
    const ownedDomains = [ownedDomain];

    // Full selection — the mass action works by filter, not by checkboxes on a visible page.
    const where = {
      siteId,
      ...(params.ids?.length ? { id: { in: params.ids } } : filterWhere(params.filter)),
    };
    const idRows: Array<{ id: string }> = await backlinkStore().findMany({
      where, select: { id: true }, orderBy: { addedAt: "asc" },
    });
    const total = idRows.length;
    const unfilteredRun = !params.ids?.length && (!params.filter || params.filter === "all");

    await syncStore().update({
      where: { id: syncId },
      data: { stage: "pull", progress: 0, rowsSeen: 0, heartbeatAt: new Date() },
    }).catch(() => {});

    let done = 0;
    for (let offset = 0; offset < total; offset += ROW_CHUNK) {
      const chunkIds = idRows.slice(offset, offset + ROW_CHUNK).map(r => r.id);
      const rows: any[] = await backlinkStore().findMany({
        where: { siteId, id: { in: chunkIds } },
        select: ROW_SELECT,
      });

      const groups = groupByHost(rows);
      let groupIndex = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, groups.length) }, async () => {
        while (groupIndex < groups.length) {
          const group = groups[groupIndex++];
          for (const row of group.rows) {
            const result = await scanOneRow(row, ownedDomains, params).catch((error): RowCheckResult => {
              // A crash in one row must not take the run down; record it as a no-verdict error.
              return {
                checkStatus: "error", pageStatus: "unknown", checkError: String((error as Error)?.message ?? error).slice(0, 120),
                hit: null, targetOk: null, pageTitle: "", insecure: false, jsSuspect: false,
              };
            });
            const now = new Date();
            try {
              await backlinkStore().update({ where: { id: row.id }, data: buildCheckUpdate(result, now) });
              for (const event of diffCheckEvents(snapshotOf(row), snapshotFromResult(result))) {
                await eventStore().create({
                  data: { siteId, backlinkId: row.id, kind: event.kind, detail: event.detail, origin: "check" },
                });
              }
            } catch { /* row-level write failure: counted as scanned with no verdict change */ }
            tallyRow(acc, row, result);
            done++;
            if (done % PROGRESS_EVERY === 0) {
              await syncStore().update({
                where: { id: syncId },
                data: { progress: Math.min(99, Math.round((done / total) * 100)), rowsSeen: done, heartbeatAt: new Date() },
              }).catch(() => {});
            }
            await sleep(POLITENESS_DELAY_MS);
          }
        }
      });
      await Promise.all(workers);
    }

    await syncStore().update({
      where: { id: syncId },
      data: {
        status: "completed",
        stage: "completed",
        progress: 100,
        rowsSeen: done,
        complete: unfilteredRun && done === total,
        summary: JSON.stringify(finishSummary(acc, unfilteredRun && done === total)),
        heartbeatAt: new Date(),
        finishedAt: new Date(),
      },
    });
  } catch (error) {
    await syncStore().update({
      where: { id: syncId },
      data: {
        status: "error",
        stage: "error",
        summary: JSON.stringify(finishSummary(acc, false)),
        error: String((error as Error)?.message ?? error).slice(0, 500),
        heartbeatAt: new Date(),
        finishedAt: new Date(),
      },
    }).catch(() => {});
  } finally {
    activeRuns.delete(siteId);
  }
}

// ─── optional JS-render recheck (single row, paid) ─────────────────────────────

/** ViewResult.htmlRaw comes back capped; at the cap a "no link found" would be a guess. */
const RENDER_HTML_CAP = 500_000;

export interface RenderVerifyParams {
  siteId: string;
  backlinkId: string;
  firecrawlKey: string;
}

/**
 * The honest answer to "Ahrefs sees this link only after JS": re-check ONE row through a
 * real render (Firecrawl, paid — the caller's key, never a mass run). Result written with
 * the same check* semantics; renderUsed counts it in the summary.
 */
export async function runRenderVerify(syncId: string, params: RenderVerifyParams): Promise<void> {
  const { siteId, backlinkId, firecrawlKey } = params;
  const acc = newSummary();
  acc.renderUsed = 1;
  try {
    const row = await backlinkStore().findFirst({
      where: { id: backlinkId, siteId },
      select: ROW_SELECT,
    });
    if (!row) throw new Error("backlink_not_found");
    const site = await prisma.site.findUnique({ where: { id: siteId }, select: { url: true } });
    if (!site) throw new Error("site_not_found");

    const { canonicalizeDomain, findPlacements } = await loadParser();
    const rawSiteUrl = site.url.replace(/^sc-domain:/i, "").trim();
    const ownedDomain = canonicalizeDomain(rawSiteUrl) ?? hostOf(`https://${rawSiteUrl}`);
    if (!ownedDomain) throw new Error("site_domain_unresolved");

    const { renderWithFirecrawl } = await import("@/lib/seo/googlebot");
    const view = await renderWithFirecrawl(absolutizeUrl(row.urlFrom), "chrome", "blchkRender", firecrawlKey);

    let result: RowCheckResult;
    if (view.error || !view.ok) {
      const pair = view.blocked
        ? { checkStatus: "blocked" as PlacementStatus, pageStatus: "blocked" as PageStatus, checkError: "render_blocked" }
        : { checkStatus: "error" as PlacementStatus, pageStatus: "unknown" as PageStatus, checkError: view.error || "render_failed" };
      result = { ...pair, hit: null, targetOk: null, pageTitle: "", insecure: false, jsSuspect: false };
    } else if (view.htmlRaw.length >= RENDER_HTML_CAP) {
      // Truncated markup: "missing" here would be an assertion we cannot back.
      result = { checkStatus: "error", pageStatus: "alive", checkError: "render_truncated", hit: null, targetOk: null, pageTitle: "", insecure: false, jsSuspect: false };
    } else {
      const hits = findPlacements(view.htmlRaw, view.finalUrl, [ownedDomain], { sourceUrl: row.urlFrom });
      const chosen = pickBestHit(hits, row.urlTo);
      const pair = classifyOpenPage(!!chosen, true);
      result = {
        ...pair, hit: chosen?.hit ?? null, targetOk: chosen?.targetOk ?? null,
        pageTitle: "", insecure: false,
        jsSuspect: row.apiJsCrawl && pair.checkStatus === "missing",
      };
    }

    const now = new Date();
    await backlinkStore().update({ where: { id: row.id }, data: buildCheckUpdate(result, now) });
    for (const event of diffCheckEvents(snapshotOf(row), snapshotFromResult(result))) {
      await eventStore().create({
        data: { siteId, backlinkId: row.id, kind: event.kind, detail: event.detail, origin: "check" },
      });
    }
    tallyRow(acc, row, result);

    await syncStore().update({
      where: { id: syncId },
      data: {
        status: "completed",
        stage: "completed",
        progress: 100,
        rowsSeen: acc.scanned,
        complete: false, // a single-row recheck never grounds site-level loss conclusions
        summary: JSON.stringify(finishSummary(acc, false)),
        heartbeatAt: new Date(),
        finishedAt: new Date(),
      },
    });
  } catch (error) {
    await syncStore().update({
      where: { id: syncId },
      data: {
        status: "error",
        stage: "error",
        summary: JSON.stringify(finishSummary(acc, false)),
        error: String((error as Error)?.message ?? error).slice(0, 500),
        heartbeatAt: new Date(),
        finishedAt: new Date(),
      },
    }).catch(() => {});
  }
}
