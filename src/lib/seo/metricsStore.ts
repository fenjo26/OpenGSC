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

/** Whether `units` more can be spent this month. `cap <= 0` means no cap configured. */
export async function withinCap(userId: string, provider: string, units: number, cap: number): Promise<boolean> {
  if (!cap || cap <= 0) return true;
  const { units: spent } = await readUsage(userId, provider);
  return spent + units <= cap;
}
