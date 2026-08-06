// Storage for third-party metrics: read cache, write cache, count units.
//
// Every statement is raw SQL wrapped in try/catch, following the same convention as `/api/dr`,
// Link Monitor and the history sync: on a database that has not run `prisma db push` yet these
// tables do not exist, and the correct behaviour is an empty result — not a 500 that takes the
// Striking Distance page down with it. A paid add-on must never be able to break a free feature.

import { runUpsert } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";

export type MetricSource = "api" | "csv";

export interface CachedKeyword {
  keyword: string;
  country: string;
  provider: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  globalVolume: number | null;
  parentTopic: string | null;
  intents: string | null;
  source: MetricSource;
  checkedAt: string;
}

/** Volume and KD move slowly; a day-long TTL would buy nothing and cost real money. */
export const KEYWORD_TTL_DAYS = 30;
export const DOMAIN_TTL_DAYS = 7;

const nowIso = () => new Date().toISOString();
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

export const normalizeKeyword = (k: string) => k.trim().toLowerCase();

// ─── Keyword cache ─────────────────────────────────────────────────────────────

export async function readKeywordCache(
  keywords: string[],
  country: string,
  provider: string,
): Promise<Record<string, CachedKeyword>> {
  const keys = [...new Set(keywords.map(normalizeKeyword).filter(Boolean))];
  if (!keys.length) return {};

  const out: Record<string, CachedKeyword> = {};
  // Chunked: SQLite caps the number of bound parameters, and a striking-distance list can be long.
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    try {
      const rows: any[] = await rawQuery(
        `SELECT keyword, country, provider, volume, difficulty, cpc, globalVolume, parentTopic,
                intents, source, checkedAt
           FROM "KeywordMetricCache"
          WHERE country = ? AND provider = ? AND keyword IN (${chunk.map(() => "?").join(",")})`,
        country, provider, ...chunk,
      );
      for (const r of rows) {
        out[r.keyword] = {
          ...r,
          volume: r.volume == null ? null : Number(r.volume),
          difficulty: r.difficulty == null ? null : Number(r.difficulty),
          cpc: r.cpc == null ? null : Number(r.cpc),
          globalVolume: r.globalVolume == null ? null : Number(r.globalVolume),
          checkedAt: new Date(r.checkedAt).toISOString(),
        };
      }
    } catch { /* table missing until prisma db push */ }
  }
  return out;
}

/**
 * The same read, but across every provider at once.
 *
 * `readKeywordCache` above filters on `provider` because a paid refresh has to know which
 * provider's rows are stale. Displaying is a different question: a volume bought from Ahrefs is
 * still a volume when the user later switches to Semrush, and hiding it means showing an em dash
 * next to a row that is already on an invoice. Nothing here fetches, so the widest possible read
 * is also the cheapest one.
 *
 * Ordering, when two providers hold the same keyword: **a row that has KD wins over a row that
 * does not, and only then does recency decide.** Freshness alone would let a cheap
 * volume-only refresh bury a difficulty score that cost ten times as much to buy — the newer row
 * is not the better one when it knows strictly less.
 */
export async function readKeywordCacheAny(
  keywords: string[],
  country: string,
): Promise<Record<string, CachedKeyword>> {
  const keys = [...new Set(keywords.map(normalizeKeyword).filter(Boolean))];
  if (!keys.length) return {};

  const out: Record<string, CachedKeyword> = {};
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    try {
      const rows: any[] = await rawQuery(
        `SELECT keyword, country, provider, volume, difficulty, cpc, globalVolume, parentTopic,
                intents, source, checkedAt
           FROM "KeywordMetricCache"
          WHERE country = ? AND keyword IN (${chunk.map(() => "?").join(",")})`,
        country, ...chunk,
      );
      for (const r of rows) {
        const row: CachedKeyword = {
          ...r,
          volume: r.volume == null ? null : Number(r.volume),
          difficulty: r.difficulty == null ? null : Number(r.difficulty),
          cpc: r.cpc == null ? null : Number(r.cpc),
          globalVolume: r.globalVolume == null ? null : Number(r.globalVolume),
          checkedAt: new Date(r.checkedAt).toISOString(),
        };
        // Resolved in JS rather than in SQL: the rule is two-level and the dialects differ
        // (SQLite and MySQL disagree on ordering NULLs), and a chunk is small enough that the
        // comparison is free.
        const held = out[r.keyword];
        if (!held || betterRow(row, held)) out[r.keyword] = row;
      }
    } catch { /* table missing until prisma db push */ }
  }
  return out;
}

/** True when `a` should be preferred over `b`: KD-bearing first, then newer. */
function betterRow(a: CachedKeyword, b: CachedKeyword): boolean {
  const aKd = a.difficulty != null, bKd = b.difficulty != null;
  if (aKd !== bKd) return aKd;
  return a.checkedAt > b.checkedAt;
}

export interface KeywordWrite {
  keyword: string;
  volume?: number | null;
  difficulty?: number | null;
  cpc?: number | null;
  globalVolume?: number | null;
  parentTopic?: string | null;
  intents?: string | null;
  payload?: any;
}

/**
 * Upsert with a freshness guard.
 *
 * The guard matters because of CSV import: a user can upload an export they generated weeks ago
 * after the API already fetched today's numbers. Import carries the file's own date, and a row
 * older than what is stored is dropped rather than written. Without this, "load weights, then
 * import an old file" silently reverts the fresher data — a bug that produces no error and is
 * invisible in the UI.
 *
 * A null field never overwrites a stored value either: a CSV without a KD column should add
 * volume, not erase a difficulty the API paid for.
 */
export async function writeKeywordCache(
  rows: KeywordWrite[],
  country: string,
  provider: string,
  source: MetricSource,
  observedAt: Date = new Date(),
): Promise<number> {
  let written = 0;
  const at = observedAt.toISOString();

  for (const r of rows) {
    const keyword = normalizeKeyword(r.keyword);
    if (!keyword) continue;
    try {
      await runUpsert({
        table: "KeywordMetricCache",
        conflict: ["keyword", "country", "provider"],
        values: {
          keyword, country, provider,
          volume: r.volume ?? null,
          difficulty: r.difficulty ?? null,
          cpc: r.cpc ?? null,
          globalVolume: r.globalVolume ?? null,
          parentTopic: r.parentTopic ?? null,
          intents: r.intents ?? null,
          payload: r.payload ? JSON.stringify(r.payload) : null,
          source, checkedAt: at,
        },
        update: {
          volume: "keep", difficulty: "keep", cpc: "keep", globalVolume: "keep",
          parentTopic: "keep", intents: "keep", payload: "keep",
          source: "set", checkedAt: "set",
        },
        onlyIfNewer: "checkedAt",
      });
      written++;
    } catch { /* best effort — a cache miss is recoverable, a crash is not */ }
  }
  return written;
}

/** Keywords whose cached row is missing or past its TTL — i.e. the ones worth paying for. */
export function staleKeywords(
  keywords: string[],
  cache: Record<string, CachedKeyword>,
  opts: { needDifficulty: boolean; ttlDays?: number } = { needDifficulty: false },
): string[] {
  const ttl = (opts.ttlDays ?? KEYWORD_TTL_DAYS) * 24 * 3600 * 1000;
  const now = Date.now();
  return [...new Set(keywords.map(normalizeKeyword).filter(Boolean))].filter(k => {
    const hit = cache[k];
    if (!hit) return true;
    if (now - new Date(hit.checkedAt).getTime() > ttl) return true;
    // A cached row fetched without the KD column does not satisfy a request that needs it.
    if (opts.needDifficulty && hit.difficulty == null) return true;
    return false;
  });
}

// ─── Domain cache ──────────────────────────────────────────────────────────────

export interface CachedDomain {
  domain: string;
  provider: string;
  dr: number | null;
  refDomains: number | null;
  backlinks: number | null;
  orgTraffic: number | null;
  orgKeywords: number | null;
  orgCost: number | null;
  source: MetricSource;
  checkedAt: string;
}

export async function readDomainCache(domains: string[], provider: string): Promise<Record<string, CachedDomain>> {
  const list = [...new Set(domains.map(d => d.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean))];
  if (!list.length) return {};
  const out: Record<string, CachedDomain> = {};
  try {
    const rows: any[] = await rawQuery(
      `SELECT domain, provider, dr, refDomains, backlinks, orgTraffic, orgKeywords, orgCost, source, checkedAt
         FROM "DomainMetricCache"
        WHERE provider = ? AND domain IN (${list.map(() => "?").join(",")})`,
      provider, ...list,
    );
    for (const r of rows) out[r.domain] = { ...r, checkedAt: new Date(r.checkedAt).toISOString() };
  } catch { /* table missing until prisma db push */ }
  return out;
}

export interface DomainWrite {
  domain: string;
  dr?: number | null;
  refDomains?: number | null;
  backlinks?: number | null;
  orgTraffic?: number | null;
  orgKeywords?: number | null;
  orgCost?: number | null;
  payload?: any;
}

export async function writeDomainCache(
  rows: DomainWrite[],
  provider: string,
  source: MetricSource,
  observedAt: Date = new Date(),
): Promise<number> {
  let written = 0;
  const at = observedAt.toISOString();
  for (const r of rows) {
    const domain = r.domain.trim().toLowerCase().replace(/^www\./, "");
    if (!domain) continue;
    try {
      await runUpsert({
        table: "DomainMetricCache",
        conflict: ["domain", "provider"],
        values: {
          domain, provider,
          dr: r.dr ?? null,
          refDomains: r.refDomains ?? null,
          backlinks: r.backlinks ?? null,
          orgTraffic: r.orgTraffic ?? null,
          orgKeywords: r.orgKeywords ?? null,
          orgCost: r.orgCost ?? null,
          payload: r.payload ? JSON.stringify(r.payload) : null,
          source, checkedAt: at,
        },
        update: {
          dr: "keep", refDomains: "keep", backlinks: "keep",
          orgTraffic: "keep", orgKeywords: "keep", orgCost: "keep", payload: "keep",
          source: "set", checkedAt: "set",
        },
        onlyIfNewer: "checkedAt",
      });
      written++;
    } catch { /* best effort */ }
  }
  return written;
}

// ─── Unit accounting ───────────────────────────────────────────────────────────

export interface UsageState {
  units: number;
  requests: number;
  month: string;
}

export async function readUsage(userId: string, provider: string): Promise<UsageState> {
  const month = monthKey();
  try {
    const rows: any[] = await rawQuery(
      `SELECT units, requests FROM "ApiUsage" WHERE userId = ? AND provider = ? AND month = ?`,
      userId, provider, month,
    );
    const r = rows?.[0];
    return { units: Number(r?.units ?? 0), requests: Number(r?.requests ?? 0), month };
  } catch {
    return { units: 0, requests: 0, month };
  }
}

/**
 * Recorded before the request is sent, not after.
 *
 * Ahrefs' cost is fully determined by `select` and row count, so it is knowable in advance —
 * and a cap that only notices an overspend after the fact is not a cap. The consequence is that
 * a failed request still counts against the month; that is the safe direction to be wrong in,
 * and failures are rare enough that the alternative (uncapped spending on retries) is worse.
 */
export async function recordUsage(userId: string, provider: string, units: number): Promise<void> {
  if (units <= 0) return;
  const month = monthKey();
  try {
    await runUpsert({
      table: "ApiUsage",
      conflict: ["userId", "provider", "month"],
      values: { userId, provider, month, units, requests: 1, updatedAt: nowIso() },
      // Both counters accumulate: `requests` inserts 1 and adds 1, which is what the previous
      // hand-written `requests + 1` did.
      update: { units: "add", requests: "add", updatedAt: "set" },
    });
  } catch { /* accounting is best-effort; the cap check below still reads what was written */ }
}

/**
 * Give back the difference between what was reserved and what the provider actually billed.
 *
 * Every paid path here charges the ceiling before the call — a cap that only notices an overspend
 * afterwards is not a cap. But Ahrefs bills the rows it *returns*, and a thin seed returns far
 * fewer than the limit: one live request reserved 3 300 units for a keyword expansion that came
 * back with three rows. Left uncorrected the monthly budget burns tens of times faster than the
 * money does, and the cap starts refusing work that was never paid for.
 *
 * So the reservation stays, and this releases the unused part once the real count is known.
 * `requests` is untouched — one call happened, and that remains true.
 *
 * Clamped at the month's own total: a correction must never drive the counter below zero, which
 * would turn a refund into free budget.
 */
export async function releaseUnusedUnits(
  userId: string, provider: string, reserved: number, actual: number,
): Promise<void> {
  const refund = Math.floor(reserved - Math.max(0, actual));
  if (refund <= 0) return;
  try {
    const { units: spent } = await readUsage(userId, provider);
    const safe = Math.min(refund, Math.max(0, spent));
    if (safe <= 0) return;
    await runUpsert({
      table: "ApiUsage",
      conflict: ["userId", "provider", "month"],
      values: { userId, provider, month: monthKey(), units: -safe, requests: 0, updatedAt: nowIso() },
      update: { units: "add", requests: "add", updatedAt: "set" },
    });
  } catch { /* accounting is best-effort, exactly as recordUsage is */ }
}

// ─── Gateway field support ─────────────────────────────────────────────────────
//
// A reseller gateway speaks the official protocol but does not necessarily proxy every column of
// every endpoint. The live instance proved it: `keyword_difficulty` arrives on
// `keywords-explorer/overview` and never on `site-explorer/organic-keywords` — 200 of 200 rows
// came back null on a pull that had been priced *with* the KD surcharge, 23 units a row instead
// of 13. The user paid ten units a row for a column the gateway does not forward.
//
// Rather than hard-code a list of gateway quirks that will be wrong next month, this learns:
// a column requested and returned empty on every single row is recorded as unsupported for that
// host, and afterwards it is neither offered nor charged for. One wasted pull, then never again.
//
// Stored in the same `ApiUsage`-style best-effort way as everything else here: if the table is
// missing the feature degrades to today's behaviour rather than breaking.

const FIELD_SUPPORT_TABLE = "GatewayFieldSupport";

/** Host + endpoint + field → does this gateway actually return it. */
export async function markFieldUnsupported(
  host: string, endpoint: string, field: string,
): Promise<void> {
  try {
    await runUpsert({
      table: FIELD_SUPPORT_TABLE,
      conflict: ["host", "endpoint", "field"],
      values: { host, endpoint, field, supported: 0, checkedAt: nowIso() },
      update: { supported: "set", checkedAt: "set" },
    });
  } catch { /* table missing until prisma db push — behave as before */ }
}

export async function markFieldSupported(
  host: string, endpoint: string, field: string,
): Promise<void> {
  try {
    await runUpsert({
      table: FIELD_SUPPORT_TABLE,
      conflict: ["host", "endpoint", "field"],
      values: { host, endpoint, field, supported: 1, checkedAt: nowIso() },
      update: { supported: "set", checkedAt: "set" },
    });
  } catch { /* as above */ }
}

/**
 * Fields this gateway is known NOT to return for an endpoint.
 *
 * Returns an empty set on any failure, which means "assume everything works" — the same default
 * the app had before this existed. A wrong empty set costs one pull; a wrong non-empty set would
 * silently withhold data the user is entitled to, so the bias is deliberate.
 */
export async function unsupportedFields(host: string, endpoint: string): Promise<Set<string>> {
  try {
    const rows: any[] = await rawQuery(
      `SELECT field FROM "${FIELD_SUPPORT_TABLE}" WHERE host = ? AND endpoint = ? AND supported = 0`,
      host, endpoint,
    );
    return new Set(rows.map(r => String(r.field)));
  } catch { return new Set(); }
}

/**
 * Learn from a response: which requested optional fields came back empty on every row.
 *
 * Only called with fields the caller paid extra for, and only trusted when there were rows to
 * judge by — an empty result set says nothing about which columns a gateway forwards.
 */
export async function learnFieldSupport(
  host: string, endpoint: string, optionalFields: string[], rows: Record<string, any>[],
  opts: { witnessField?: string; minRows?: number } = {},
): Promise<void> {
  const minRows = opts.minRows ?? 20;
  if (rows.length < minRows || !optionalFields.length) return;

  // `witnessField` guards against the obvious false positive.
  //
  // "Every row has a null KD" has two possible causes: the gateway drops the column, or the
  // provider genuinely has no difficulty for these keywords — which is exactly what Ahrefs does
  // for zero-volume terms, and a brand-heavy pull is entirely zero-volume. Concluding
  // "unsupported" from the second case would permanently withhold a column the user is paying
  // for and entitled to.
  //
  // So the verdict is only drawn from rows where the provider demonstrably had data at all: rows
  // whose witness field (volume) came back populated. If none did, the response says nothing
  // about the gateway and nothing is recorded.
  const witness = opts.witnessField ?? "volume";
  const informative = rows.filter(r => r[witness] != null && r[witness] !== 0);
  if (informative.length < minRows) return;

  for (const field of optionalFields) {
    const anyPresent = informative.some(r => r[field] != null);
    if (anyPresent) await markFieldSupported(host, endpoint, field);
    else await markFieldUnsupported(host, endpoint, field);
  }
}

/** Whether `units` more can be spent this month. `cap <= 0` means no cap configured. */
export async function withinCap(userId: string, provider: string, units: number, cap: number): Promise<boolean> {
  if (!cap || cap <= 0) return true;
  const { units: spent } = await readUsage(userId, provider);
  return spent + units <= cap;
}
