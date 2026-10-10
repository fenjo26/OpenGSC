// DataForSEO Backlinks API — the pure half: auth, the three-level envelope, status mapping and
// every field mapping. No network, no Prisma, so `npx tsx --test` covers it without a database.
// The transport lives in `metrics.ts` next to the other providers (issue #26).
//
// Four things here are load-bearing:
//
// 1. **A task can fail inside an HTTP 200.** DataForSEO answers with an envelope `status_code`
//    and a per-task `status_code`; 20000 means OK at both levels. Checking only the HTTP status
//    turns "out of money" into an empty profile — and an empty complete profile would mark every
//    stored referring domain lost. `parseDfsEnvelope` checks all three and says which failed.
//
// 2. **Its error codes are five digits.** They are folded onto the three-digit statuses the rest
//    of the metrics layer already branches on (`gatewayStatusFromError`): 401xx → 401 (bad
//    credentials), 40200/40201 → 402 (balance), 40202/40203 → 429 (rate limit), 40204+ → 403
//    (Backlinks API not enabled on the account), 5xxxx → 500.
//
// 3. **`rank` is not Domain Rating.** DataForSEO's rank is its own PageRank-like score. It is
//    requested on the 0–100 scale (`rank_scale: one_hundred`) so it sits in the same range as
//    the other providers' authority figures, but it is stored under provider `dataforseo` and
//    shown in its own column — never in an Ahrefs DR slot.
//
// 4. **Rows are restated in the Ahrefs all-backlinks shape** (`dfsBacklinkToExportRow`), the
//    same move the Keys.so export makes, so `upsertFromApi` and its event planner are shared
//    unchanged. The one field Ahrefs has no slot for — the per-link spam score — rides along as
//    `backlink_spam_score` and lands in `SiteBacklink.apiSpamScore`.

/** "login:password" → Base64; an already-Base64 dashboard token is used as is. */
export function dfsAuth(credential: string): string {
  const cred = String(credential ?? "").trim();
  if (!cred.includes(":")) return cred;
  return typeof Buffer !== "undefined"
    ? Buffer.from(cred).toString("base64")
    : btoa(cred);
}

/** Five-digit DataForSEO status → the three-digit status the metrics layer branches on. */
export function dfsStatusToHttp(code: number): number {
  if (!Number.isFinite(code)) return 500;
  if (code === 20000) return 200;
  if (code >= 50000) return 500;
  if (code >= 40100 && code < 40200) return 401;
  if (code === 40200 || code === 40201) return 402;
  if (code === 40202 || code === 40203) return 429;
  if (code >= 40204 && code < 40300) return 403;
  if (code >= 40400 && code < 40500) return 404;
  if (code >= 40000 && code < 50000) return 400;
  return 500;
}

export type DfsEnvelope =
  | { ok: true; result: any; costUsd: number | null }
  | { ok: false; status: number; error: string; costUsd: number | null };

/**
 * The three-level check: HTTP status, envelope `status_code`, task `status_code`. Errors are
 * phrased `dataforseo <3-digit>: <message>` so `gatewayStatusFromError` can read them. `costUsd`
 * is read before any check, because a task that failed inside a 200 may still have been billed.
 */
export function parseDfsEnvelope(httpStatus: number, data: any): DfsEnvelope {
  const costUsd = Number.isFinite(Number(data?.cost)) ? Number(data.cost) : null;
  if (httpStatus < 200 || httpStatus >= 300) {
    const msg = String(data?.status_message ?? "").slice(0, 200) || `HTTP ${httpStatus}`;
    return { ok: false, status: httpStatus, error: `dataforseo ${httpStatus}: ${msg}`, costUsd };
  }
  if (data == null || typeof data !== "object") {
    return { ok: false, status: 502, error: "dataforseo 502: response is not JSON", costUsd };
  }
  const top = Number(data.status_code ?? 20000);
  if (top !== 20000) {
    const s = dfsStatusToHttp(top);
    return { ok: false, status: s, error: `dataforseo ${s}: ${top} ${String(data.status_message ?? "").slice(0, 200)}`, costUsd };
  }
  const task = Array.isArray(data.tasks) ? data.tasks[0] : null;
  if (!task) return { ok: false, status: 502, error: "dataforseo 502: no task in response", costUsd };
  const tc = Number(task.status_code ?? 20000);
  if (tc !== 20000) {
    const s = dfsStatusToHttp(tc);
    return { ok: false, status: s, error: `dataforseo ${s}: ${tc} ${String(task.status_message ?? "").slice(0, 200)}`, costUsd };
  }
  const result = Array.isArray(task.result) ? task.result[0] ?? null : task.result ?? null;
  return { ok: true, result, costUsd };
}

/** Dollars → meter units (micro-dollars; see UNIT_PRICE_USD.dataforseo). */
export function dfsUsdToUnits(usd: number | null | undefined): number {
  const n = Number(usd);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : 0;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown) => (v == null ? "" : String(v));

/** "2024-03-01 10:15:00 +00:00" → "2024-03-01"; anything unreadable → "". */
export function dfsDay(v: unknown): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(v).trim());
  return m ? m[1] : "";
}

/** A target as the API wants it: bare host, no scheme, no www, no path. */
export function dfsTarget(domain: string): string {
  return String(domain ?? "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
}

// ─── summary/live ──────────────────────────────────────────────────────────────

export interface DfsSummary {
  /** DataForSEO rank, 0–100 (requested with rank_scale one_hundred). Not Ahrefs DR. */
  rank: number | null;
  backlinks: number | null;
  refDomains: number | null;
  refMainDomains: number | null;
  /** Referring domains whose every link to the target is nofollow. */
  refDomainsNofollow: number | null;
  brokenBacklinks: number | null;
  /** 0–100, DataForSEO's spam score of the target's backlink profile. */
  spamScore: number | null;
  firstSeen: string;
}

export function mapDfsSummary(result: any): DfsSummary {
  return {
    rank: num(result?.rank),
    backlinks: num(result?.backlinks),
    refDomains: num(result?.referring_domains),
    refMainDomains: num(result?.referring_main_domains),
    refDomainsNofollow: num(result?.referring_domains_nofollow),
    brokenBacklinks: num(result?.broken_backlinks),
    spamScore: num(result?.backlinks_spam_score),
    firstSeen: dfsDay(result?.first_seen),
  };
}

/**
 * Share of referring domains that pass weight, from the summary's own two counts. Null unless
 * both are present — never a fabricated 100% from a missing nofollow figure.
 */
export function dfsDofollowPct(s: DfsSummary): number | null {
  if (s.refDomains == null || s.refDomainsNofollow == null || s.refDomains <= 0) return null;
  const follow = Math.max(0, s.refDomains - s.refDomainsNofollow);
  return Math.round((follow / s.refDomains) * 100);
}

// ─── referring_domains/live ────────────────────────────────────────────────────

export interface DfsRefDomain {
  refDomain: string;
  /** DataForSEO rank 0–100 — stored in RefDomainRow.dr under provider `dataforseo`. */
  rank: number | null;
  linksToTarget: number | null;
  /** False only when every referring page of this donor links nofollow. */
  dofollow: boolean;
  firstSeen: string;
  spamScore: number | null;
}

export function mapDfsRefDomain(item: any): DfsRefDomain | null {
  const refDomain = str(item?.domain).trim().toLowerCase().replace(/^www\./, "");
  if (!refDomain.includes(".")) return null;
  const pages = num(item?.referring_pages);
  const nofollowPages = num(item?.referring_pages_nofollow);
  return {
    refDomain,
    rank: num(item?.rank),
    linksToTarget: num(item?.backlinks),
    dofollow: !(pages != null && nofollowPages != null && pages > 0 && nofollowPages >= pages),
    firstSeen: dfsDay(item?.first_seen),
    spamScore: num(item?.backlinks_spam_score),
  };
}

// ─── backlinks/live → the Ahrefs all-backlinks shape ───────────────────────────

/**
 * One DataForSEO backlink restated as an Ahrefs `all-backlinks` row, so `mapApiRow` and
 * `upsertFromApi` take it unchanged. Field by field:
 *   dofollow + attributes[] (nofollow/sponsored/ugc) → is_dofollow / is_nofollow / is_sponsored / is_ugc
 *   item_type "image" → is_image; "anchor"/"image" are links, "redirect"/"canonical"/… are not content
 *   semantic_location present and not header/footer/nav/aside → is_content
 *   text_pre / text_post → snippet_left / snippet_right
 *   is_lost (from backlinks_status_type "all") → is_lost; is_broken → lost_reason "broken"
 *   domain_from_rank is NOT copied into domain_rating_source: it is not DR, and the toxicity
 *   classifier's sitewide-low-DR rule is calibrated on Ahrefs DR.
 */
export function dfsBacklinkToExportRow(item: any): Record<string, unknown> | null {
  const urlFrom = str(item?.url_from).trim();
  if (!/^https?:\/\//i.test(urlFrom)) return null;
  const attrs = Array.isArray(item?.attributes) ? item.attributes.map((a: unknown) => str(a).toLowerCase()) : [];
  const nofollow = attrs.includes("nofollow") || item?.dofollow === false;
  const sponsored = attrs.includes("sponsored");
  const ugc = attrs.includes("ugc");
  const itemType = str(item?.item_type).toLowerCase();
  const loc = str(item?.semantic_location).toLowerCase();
  const outOfContent = /^(header|footer|nav|aside)$/.test(loc);
  const lost = item?.is_lost === true;
  return {
    url_from: urlFrom,
    url_to: str(item?.url_to),
    anchor: str(item?.anchor),
    alt: str(item?.alt),
    is_dofollow: item?.dofollow === true && !nofollow,
    is_nofollow: nofollow,
    is_sponsored: sponsored,
    is_ugc: ugc,
    // Unknown location (empty) counts as content: the Ahrefs default for the column, and
    // "out_of_content" is a toxicity signal that must not fire on missing data.
    is_content: !outOfContent,
    is_image: itemType === "image",
    first_seen_link: dfsDay(item?.first_seen),
    last_seen: dfsDay(item?.last_seen),
    is_lost: lost,
    lost_reason: lost ? (item?.is_broken === true ? "broken" : "removed") : "",
    http_code: num(item?.page_from_status_code),
    link_type: itemType,
    snippet_left: str(item?.text_pre),
    snippet_right: str(item?.text_post),
    backlink_spam_score: num(item?.backlink_spam_score),
  };
}

export interface DfsBacklinksPage {
  rows: Record<string, unknown>[];
  /** Raw item count of the page — the end of the listing is an empty page or a missing token. */
  itemsCount: number;
  totalCount: number | null;
  searchAfterToken: string | null;
}

export function mapDfsBacklinksResult(result: any): DfsBacklinksPage {
  const items = Array.isArray(result?.items) ? result.items : [];
  return {
    rows: items.map(dfsBacklinkToExportRow).filter(Boolean) as Record<string, unknown>[],
    itemsCount: items.length,
    totalCount: num(result?.total_count),
    searchAfterToken: str(result?.search_after_token).trim() || null,
  };
}

// ─── history/live and timeseries_new_lost_summary/live ─────────────────────────

export interface DfsHistoryPoint {
  date: string;
  rank: number | null;
  backlinks: number | null;
  refDomains: number | null;
  newBacklinks: number | null;
  lostBacklinks: number | null;
  newRefDomains: number | null;
  lostRefDomains: number | null;
}

/** Monthly history, oldest first; rows without a date are dropped. */
export function mapDfsHistory(result: any): DfsHistoryPoint[] {
  const items = Array.isArray(result?.items) ? result.items : [];
  return items
    .map((i: any) => ({
      date: dfsDay(i?.date),
      rank: num(i?.rank),
      backlinks: num(i?.backlinks),
      refDomains: num(i?.referring_domains),
      newBacklinks: num(i?.new_backlinks),
      lostBacklinks: num(i?.lost_backlinks),
      newRefDomains: num(i?.new_referring_domains),
      lostRefDomains: num(i?.lost_referring_domains),
    }))
    .filter((p: DfsHistoryPoint) => !!p.date)
    .sort((a: DfsHistoryPoint, b: DfsHistoryPoint) => a.date.localeCompare(b.date));
}

export interface DfsNewLostPoint {
  date: string;
  newBacklinks: number;
  lostBacklinks: number;
  newRefDomains: number;
  lostRefDomains: number;
}

/**
 * New/lost per period, oldest first. Here the API's own zero is a real zero ("periods with no
 * data return 0" per its docs), so missing numbers become 0 rather than null.
 */
export function mapDfsNewLost(result: any): DfsNewLostPoint[] {
  const items = Array.isArray(result?.items) ? result.items : [];
  const z = (v: unknown) => num(v) ?? 0;
  return items
    .map((i: any) => ({
      date: dfsDay(i?.date),
      newBacklinks: z(i?.new_backlinks),
      lostBacklinks: z(i?.lost_backlinks),
      newRefDomains: z(i?.new_referring_domains),
      lostRefDomains: z(i?.lost_referring_domains),
    }))
    .filter((p: DfsNewLostPoint) => !!p.date)
    .sort((a: DfsNewLostPoint, b: DfsNewLostPoint) => a.date.localeCompare(b.date));
}

// ─── appendix/user_data (free) ─────────────────────────────────────────────────

/** Account balance in dollars from the free `user_data` answer, or null. */
export function dfsBalanceUsd(result: any): number | null {
  return num(result?.money?.balance);
}

/** `YYYY-MM-DD` of the first day of the month `months` before `now`. */
export function monthsAgo(now: Date, months: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  return d.toISOString().slice(0, 10);
}
