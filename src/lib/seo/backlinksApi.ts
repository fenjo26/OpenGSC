// Full per-page backlink export from the Ahrefs gateway — the "all-backlinks" side of the
// backlinks v2 wave (docs/tasks/T3-ahrefs-export.md).
//
// The existing profile pull (`fetchBacklinkProfile` in metrics.ts) answers a different question:
// it lists *referring domains*, capped at 1000 rows, and loses the page-level detail a placement
// campaign actually needs. This module pages through every individual backlink of the site's own
// profile and hands raw rows to `siteBacklinkStore.ts`, which owns persistence.
//
// Three constraints shape everything here:
//
// 1. **The field set is the price.** Exactly twenty 1-unit fields (CONTRACT.md §5). `traffic` (10),
//    `traffic_domain` (10) and `refdomains_source` (5) must never appear in `select`, `where` or
//    `order_by` — the gateway bills a field named anywhere, returned or not.
// 2. **`offset` support is unknown.** The official docs omit it for this endpoint; the reseller
//    gateway lists it among the common parameters. `probePagination` settles the question at
//    runtime for ~100 units and the answer is cached per gateway host for a day.
// 3. **Pages are fetched strictly one at a time.** The gateway allows 3 concurrent requests per
//    key and the pool enforcing that lives in metrics.ts, unexported. Rather than rebuild a
//    second pool here (two pools would jointly grant six concurrent requests to one key), this
//    module keeps a single request in flight — every paging mode allows that, because the keyset
//    cursor is whatever the previous page returned.

import { loggedFetch } from "@/lib/providerLog/log";
import {
  AHREFS_UNIT_FLOOR, DEFAULT_BASE_URL, MetricsCreds, estimateCostUsd, estimateUnits,
} from "./metrics";

export const EXPORT_ENDPOINT = "site-explorer/all-backlinks";

/** CONTRACT.md §5 — twenty fields, every one of them 1 unit. Changing this list changes the bill. */
export const BACKLINK_EXPORT_FIELDS = [
  "url_from", "url_to", "anchor", "alt", "is_dofollow", "is_nofollow", "is_sponsored",
  "is_ugc", "is_content", "is_image", "domain_rating_source", "first_seen_link", "last_seen",
  "is_lost", "lost_reason", "http_code", "js_crawl", "link_type", "snippet_left", "snippet_right",
] as const;

/**
 * Pages of 1000, not fewer. The minimum any request costs is 50 units, so a 50-row page pays the
 * floor ten times over for the same data — page size is a pricing decision here, not a tuning knob.
 */
export const EXPORT_PAGE_SIZE = 1000;

/** backlinks-stats takes no `select` and always lands on the 50-unit floor. */
export const STATS_UNITS = AHREFS_UNIT_FLOOR;
/** The probe is two 10-row pages (select=url_from only); each hits the same floor. */
export const PROBE_UNITS = AHREFS_UNIT_FLOOR * 2;

export type PaginationMode = "offset" | "keyset";

// ─── Pricing ───────────────────────────────────────────────────────────────────

/** Units for pulling `rows` backlink rows with the full export field set. */
export function estimateExportUnits(rows: number): number {
  // The order-by field (`first_seen_link`) and the keyset cursor field (`url_from`) are both
  // already in the select, so no paging strategy bills a twenty-first field — estimateUnits
  // deduplicates the union before pricing.
  return estimateUnits(EXPORT_ENDPOINT, [...BACKLINK_EXPORT_FIELDS], rows);
}

export function estimateExportUsd(units: number): number {
  return estimateCostUsd(units, "ahrefs");
}

// ─── Query building (pure — unit-tested without a network) ─────────────────────

export interface PageQuery {
  target: string;
  limit: number;
  /** offset mode: skip this many rows. */
  offset?: number;
  /** keyset mode: only rows strictly after this url_from. */
  afterUrlFrom?: string;
  /** slice fallback: first_seen_link window [seenFrom, seenTo). */
  seenFrom?: string;
  seenTo?: string;
}

/**
 * One all-backlinks request. The three paging strategies differ only in `where`/`order_by`/`offset`:
 *
 * - offset: `order_by=first_seen_link:desc` + a growing `offset`, until a page comes back short.
 * - keyset: `order_by=url_from:asc` + `where url_from > <last of previous page>`. url_from is not
 *   strictly unique under aggregation=all (one page can host several links), so a boundary value
 *   shared by both sides of the cut can drop rows — accepted, because the alternative (offset)
 *   was already ruled out by the probe, and the slice fallback below is strictly lossier.
 * - slice: monthly `first_seen_link` windows, used when the gateway rejects a `where` on url_from.
 *   Cannot page within a month and cannot see before the window: a run that uses it is never
 *   allowed to conclude anything is lost.
 */
export function buildPageQuery(q: PageQuery): URLSearchParams {
  const params = new URLSearchParams({
    target: q.target,
    mode: "subdomains",
    limit: String(q.limit),
    select: BACKLINK_EXPORT_FIELDS.join(","),
    // all_time so lost links arrive carrying is_lost/lost_reason instead of being invisible;
    // `all` (not 1_per_domain) because placements are bought per page, not per donor domain.
    history: "all_time",
    aggregation: "all",
  });
  if (q.afterUrlFrom !== undefined) {
    params.set("where", JSON.stringify({ and: [{ field: "url_from", is: ["gt", q.afterUrlFrom] }] }));
    params.set("order_by", "url_from:asc");
  } else if (q.seenFrom !== undefined || q.seenTo !== undefined) {
    const conds: Array<{ field: string; is: [string, string] }> = [];
    if (q.seenFrom) conds.push({ field: "first_seen_link", is: ["gte", q.seenFrom] });
    if (q.seenTo) conds.push({ field: "first_seen_link", is: ["lt", q.seenTo] });
    params.set("where", JSON.stringify({ and: conds }));
    params.set("order_by", "first_seen_link:asc");
  } else {
    params.set("order_by", "first_seen_link:desc");
    if (q.offset) params.set("offset", String(q.offset));
  }
  return params;
}

/** Monthly [from, to) windows over the lookback used by the slice fallback. */
export const SLICE_LOOKBACK_MONTHS = 24;

export function monthSlices(now: Date, months: number = SLICE_LOOKBACK_MONTHS): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (let i = months - 1; i >= 0; i--) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    out.push({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
  }
  return out;
}

// ─── Normalization ─────────────────────────────────────────────────────────────

/**
 * Dedup key for url_from. The raw string is stored as it arrived (the contractor's table must
 * join against it); this is the normalized twin used by the unique constraint.
 *
 * Scheme, www, default ports, "#fragment" and a trailing slash are folded away, because the same
 * placement arrives as `https://Example.com/a/` from Ahrefs and `example.com/a` from a pasted
 * list. Query strings are kept and not reordered — two querystrings can be two different pages.
 */
export function normalizeUrlFrom(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  const u = parseWebUrl(raw);
  if (!u) return raw.toLowerCase();
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const port = u.port && u.port !== "80" && u.port !== "443" ? `:${u.port}` : "";
  const path = u.pathname === "/" ? "/" : u.pathname.replace(/\/+$/, "");
  return `${host}${port}${path}${u.search}`;
}

/** Donor domain of a url_from — hostname, lowercase, no www. Empty when unparseable. */
export function domainOfUrl(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  const u = parseWebUrl(raw);
  return u ? normalizeHost(u.hostname) : "";
}

/**
 * `new URL("example.com:8080/a")` parses — as scheme "example.com:", host "8080" — because dots
 * are legal in schemes. Bare hostnames with ports therefore need the same https-prefix retry as
 * bare hostnames without them, and a first parse only counts under http(s).
 */
function parseWebUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch { /* fall through */ }
  try {
    const u = new URL("https://" + raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch { return null; }
}

const normalizeHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

// ─── Row mapping (pure) ────────────────────────────────────────────────────────

/** The SiteBacklink columns the API writer owns, for one all-backlinks row. */
export interface MappedBacklinkRow {
  urlFrom: string;
  urlFromNorm: string;
  urlTo: string;
  domainFrom: string;
  apiSeen: boolean;
  apiLost: boolean;
  apiLostReason: string;
  apiAnchor: string;
  apiAlt: string;
  apiDofollow: boolean;
  apiNofollow: boolean;
  apiSponsored: boolean;
  apiUgc: boolean;
  apiContent: boolean;
  apiImage: boolean;
  apiJsCrawl: boolean;
  apiDr: number | null;
  apiHttpCode: number | null;
  apiLinkType: string;
  apiSnippet: string;
  apiFirstSeen: string;
  apiLastSeen: string;
}

const str = (v: unknown) => (v == null ? "" : String(v));
const flag = (v: unknown) => v === true;
const numOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One raw all-backlinks row → the api* column group. Rows without url_from are not links. */
export function mapApiRow(raw: any): MappedBacklinkRow | null {
  const urlFrom = str(raw?.url_from);
  if (!urlFrom) return null;
  const nofollow = flag(raw?.is_nofollow);
  const sponsored = flag(raw?.is_sponsored);
  const ugc = flag(raw?.is_ugc);
  // apiDofollow stores "this link transmits weight": Ahrefs' own is_dofollow AND none of the
  // three degrading flags. On self-consistent data the AND changes nothing; on inconsistent
  // data a sponsored link must not read as dofollow just because one flag lied.
  const transmits = flag(raw?.is_dofollow) && !nofollow && !sponsored && !ugc;
  return {
    urlFrom,
    urlFromNorm: normalizeUrlFrom(urlFrom),
    urlTo: str(raw?.url_to),
    domainFrom: domainOfUrl(urlFrom),
    // Every row of an all_time pull is a link Ahrefs has seen; is_lost says whether it still does.
    apiSeen: true,
    apiLost: flag(raw?.is_lost),
    apiLostReason: str(raw?.lost_reason),
    apiAnchor: str(raw?.anchor),
    apiAlt: str(raw?.alt),
    apiDofollow: transmits,
    apiNofollow: nofollow,
    apiSponsored: sponsored,
    apiUgc: ugc,
    apiContent: flag(raw?.is_content),
    apiImage: flag(raw?.is_image),
    apiJsCrawl: flag(raw?.js_crawl),
    apiDr: numOrNull(raw?.domain_rating_source),
    apiHttpCode: numOrNull(raw?.http_code),
    apiLinkType: str(raw?.link_type),
    apiSnippet: `${str(raw?.snippet_left)} ${str(raw?.snippet_right)}`.replace(/\s+/g, " ").trim().slice(0, 500),
    apiFirstSeen: str(raw?.first_seen_link).slice(0, 10),
    apiLastSeen: str(raw?.last_seen).slice(0, 10),
  };
}

// ─── Event planning (pure) ─────────────────────────────────────────────────────

/** api* state of a row as it sits in the DB — the "before" side of an event diff. */
export interface ExistingApiState {
  apiLost: boolean;
  apiAnchor: string;
  apiDofollow: boolean;
  apiNofollow: boolean;
  apiSponsored: boolean;
  apiUgc: boolean;
}

export type ApiEventKind =
  | "appeared" | "lost" | "returned"
  | "rel_downgraded" | "rel_upgraded"
  | "anchor_changed";

export interface PlannedEvent {
  kind: ApiEventKind;
  /** JSON for SiteBacklinkEvent.detail; empty where there is no from/to worth recording. */
  detail: string;
}

const relTransmits = (r: { apiDofollow: boolean; apiNofollow: boolean; apiSponsored: boolean; apiUgc: boolean }) =>
  r.apiDofollow && !r.apiNofollow && !r.apiSponsored && !r.apiUgc;

/** Which rel flag ended the transmission — for the event detail, most specific first. */
const relLabel = (r: { apiNofollow: boolean; apiSponsored: boolean; apiUgc: boolean }) =>
  r.apiSponsored ? "sponsored" : r.apiUgc ? "ugc" : r.apiNofollow ? "nofollow" : "dofollow";

/**
 * Transitions of one row, API-side. Losses come from `is_lost` — never from "absent in this
 * pull" — which is the whole difference from `syncRefDomains`: there the local diff was the only
 * signal, here the provider answers the question directly.
 */
export function planEvents(existing: ExistingApiState | null, incoming: MappedBacklinkRow): PlannedEvent[] {
  if (!existing) return [{ kind: "appeared", detail: "" }];
  const events: PlannedEvent[] = [];
  if (!existing.apiLost && incoming.apiLost) {
    events.push({ kind: "lost", detail: JSON.stringify({ from: false, to: true, reason: incoming.apiLostReason }) });
  } else if (existing.apiLost && !incoming.apiLost) {
    events.push({ kind: "returned", detail: JSON.stringify({ from: true, to: false }) });
  }
  // An empty stored anchor is missing data, not a previous value — filling it in is enrichment,
  // not a change the operator needs to know about.
  if (existing.apiAnchor && existing.apiAnchor !== incoming.apiAnchor) {
    events.push({
      kind: "anchor_changed",
      detail: JSON.stringify({ from: existing.apiAnchor, to: incoming.apiAnchor }),
    });
  }
  const wasDofollow = relTransmits(existing);
  const nowDofollow = relTransmits(incoming);
  if (wasDofollow && !nowDofollow) {
    events.push({
      kind: "rel_downgraded",
      detail: JSON.stringify({ from: relLabel(existing), to: relLabel(incoming) }),
    });
  } else if (!wasDofollow && nowDofollow) {
    events.push({
      kind: "rel_upgraded",
      detail: JSON.stringify({ from: relLabel(existing), to: "dofollow" }),
    });
  }
  return events;
}

// ─── Probe (network) ───────────────────────────────────────────────────────────

/**
 * The probe verdict, as a pure function of the two pages.
 *
 * `page2 === null` means the second request answered 400: the gateway does not know `offset`.
 * Any overlap between the pages means offset was ignored and the same head came back twice —
 * even partial overlap reads as "unsupported", because a honored offset cannot revisit a row.
 * An empty second page means the profile fits inside ten links: paging never matters, and
 * "offset" is the cheaper assumption (one full page is then the whole answer either way).
 */
export function decidePaginationMode(page1: string[], page2: string[] | null): PaginationMode {
  if (page2 === null) return "keyset";
  if (!page2.length) return "offset";
  const seen = new Set(page1);
  return page2.some(u => seen.has(u)) ? "keyset" : "offset";
}

const probeCache = new Map<string, { mode: PaginationMode; at: number }>();
const PROBE_CACHE_MS = 24 * 3600 * 1000;

export function gatewayBase(creds: MetricsCreds): string {
  return (creds.baseUrl || DEFAULT_BASE_URL.ahrefs).replace(/\/+$/, "");
}

/** Yesterday's probe answer for this gateway host, if still fresh. Offset support is a property
 *  of the gateway, not of the profile — so the cache key is the host and nothing else. */
export function cachedPaginationMode(creds: MetricsCreds): PaginationMode | null {
  const hit = probeCache.get(gatewayBase(creds));
  return hit && Date.now() - hit.at < PROBE_CACHE_MS ? hit.mode : null;
}

const probeParams = (target: string, offset: number) => new URLSearchParams({
  target, mode: "subdomains", limit: "10", offset: String(offset),
  select: "url_from", order_by: "first_seen_link:desc",
});

const urlFromList = (rows: any[]): string[] =>
  rows.map(r => str(r?.url_from)).filter(Boolean);

export async function probePagination(
  creds: MetricsCreds, target: string,
): Promise<{ mode: PaginationMode | null; units: number; error?: string }> {
  const base = gatewayBase(creds);
  const cached = cachedPaginationMode(creds);
  if (cached) return { mode: cached, units: 0 };

  try {
    const r1 = await gatewayGet(`${base}/v3/${EXPORT_ENDPOINT}?${probeParams(target, 0)}`, creds.apiKey);
    if (!r1.ok) {
      return { mode: null, units: 0, error: `ahrefs ${r1.status}: ${(await r1.text()).slice(0, 300)}` };
    }
    const page1 = urlFromList((await r1.json())?.backlinks ?? []);
    let units = AHREFS_UNIT_FLOOR;

    const r2 = await gatewayGet(`${base}/v3/${EXPORT_ENDPOINT}?${probeParams(target, 10)}`, creds.apiKey);
    let page2: string[] | null;
    if (r2.ok) {
      units += AHREFS_UNIT_FLOOR;
      page2 = urlFromList((await r2.json())?.backlinks ?? []);
    } else if (r2.status === 400) {
      // Failed answers are not billed — `offset` being unknown to the gateway is exactly the
      // case the probe exists to catch.
      page2 = null;
    } else {
      return { mode: null, units, error: `ahrefs ${r2.status}: ${(await r2.text()).slice(0, 300)}` };
    }

    const mode = decidePaginationMode(page1, page2);
    probeCache.set(base, { mode, at: Date.now() });
    return { mode, units };
  } catch (e: any) {
    return { mode: null, units: 0, error: String(e?.message ?? e) };
  }
}

// ─── Page and stats fetches (network) ──────────────────────────────────────────

export interface PageFetch {
  rows: any[];
  /** Units this page actually bills — rows returned × 20 fields, floored at 50. Zero on failure. */
  units: number;
  /** HTTP status of a failed page. 400 on a cursor page is the signal to fall back to slices. */
  status?: number;
  error?: string;
}

export async function fetchBacklinksPage(creds: MetricsCreds, q: PageQuery): Promise<PageFetch> {
  try {
    const res = await gatewayGet(
      `${gatewayBase(creds)}/v3/${EXPORT_ENDPOINT}?${buildPageQuery(q)}`,
      creds.apiKey,
    );
    if (!res.ok) {
      return { rows: [], units: 0, status: res.status, error: `ahrefs ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    const rows = (await res.json())?.backlinks;
    if (!Array.isArray(rows)) return { rows: [], units: 0, error: "unexpected_response_shape" };
    // Billed on rows returned, same reconciliation rule as the ideas fetch in metrics.ts: the
    // ceiling was reserved before the call, the outcome is what actually got charged.
    return { rows, units: estimateExportUnits(rows.length) };
  } catch (e: any) {
    return { rows: [], units: 0, error: String(e?.message ?? e) };
  }
}

/** Live backlink count — the cheap basis for the price quote and the progress denominator.
 *  mode=subdomains so the count covers exactly the scope the export pages through. */
export async function fetchBacklinksStats(
  creds: MetricsCreds, target: string,
): Promise<{ live: number | null; units: number; error?: string }> {
  const params = new URLSearchParams({
    target, mode: "subdomains", date: new Date().toISOString().slice(0, 10),
  });
  try {
    const res = await gatewayGet(`${gatewayBase(creds)}/v3/site-explorer/backlinks-stats?${params}`, creds.apiKey);
    if (!res.ok) {
      return { live: null, units: 0, error: `ahrefs ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    const stats = (await res.json())?.metrics ?? {};
    return { live: numOrNull(stats?.live), units: AHREFS_UNIT_FLOOR };
  } catch (e: any) {
    return { live: null, units: 0, error: String(e?.message ?? e) };
  }
}

// ─── HTTP ──────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * GET with the same retry policy as `requestWithRetry` in metrics.ts: 429 and 5xx are transient
 * (the gateway names the per-key rate limit and 502 explicitly), every other 4xx would fail
 * identically on each attempt and is returned as-is for the caller to interpret.
 *
 * Deliberately no slot pool of its own: metrics.ts owns the per-key ceiling but does not export
 * it, and a second pool here would let the two grant six concurrent requests to one key. Callers
 * of this module keep one request in flight, which stays under any ceiling by construction.
 */
async function gatewayGet(url: string, apiKey: string): Promise<Response> {
  let lastErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // One row per attempt, numbered: a retried 429 is a second request, and the ladder is the
      // reason a single export page can cost three round trips.
      const { res, call } = await loggedFetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(45_000),
      }, { provider: "ahrefs", attempt: attempt + 1 });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        call.finish({ error: `ahrefs ${res.status}` });
        await sleep(800 * 2 ** attempt + Math.random() * 400);
        continue;
      }
      // The body belongs to the caller, which reads it in four different shapes, and the gateway
      // states neither usage nor a price in it. Everything this row will ever know is known now.
      call.finish(res.ok ? undefined : { error: `ahrefs ${res.status}` });
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === 2) break;
      await sleep(800 * 2 ** attempt + Math.random() * 400);
    }
  }
  throw lastErr ?? new Error("request_failed");
}
