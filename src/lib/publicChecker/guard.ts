import { createHash } from "node:crypto";

const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 5;
const CACHE_TTL_MS = 15 * 60_000;

interface RateBucket { startedAt: number; count: number; }
interface CacheEntry<T> { expiresAt: number; value: T; }

// OpenGSC is a single-process self-hosted app. Keeping the public checker's short-lived abuse
// buckets and result cache in memory avoids collecting a permanent IP/domain history in SQLite.
const state = globalThis as typeof globalThis & {
  __openGscPublicRates?: Map<string, RateBucket>;
  __openGscPublicCache?: Map<string, CacheEntry<unknown>>;
  __openGscPublicInflight?: Map<string, Promise<unknown>>;
};
const rates = state.__openGscPublicRates ??= new Map();
const cache = state.__openGscPublicCache ??= new Map();
const inflight = state.__openGscPublicInflight ??= new Map();

function prune(now: number) {
  for (const [key, bucket] of rates) if (now - bucket.startedAt >= RATE_WINDOW_MS) rates.delete(key);
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
}

export function anonymizedClientKey(ip: string): string {
  const secret = process.env.PUBLIC_CHECKER_HASH_SECRET || process.env.NEXTAUTH_SECRET || "opengsc-public-checker";
  return createHash("sha256").update(`${secret}:${String(ip || "unknown")}`).digest("hex");
}

export function takePublicCheckRate(key: string, now = Date.now()): { ok: boolean; remaining: number; retryAfterSeconds: number } {
  prune(now);
  const current = rates.get(key);
  if (!current) {
    rates.set(key, { startedAt: now, count: 1 });
    return { ok: true, remaining: RATE_MAX - 1, retryAfterSeconds: 0 };
  }
  if (current.count >= RATE_MAX) {
    return { ok: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - current.startedAt)) / 1000)) };
  }
  current.count++;
  return { ok: true, remaining: RATE_MAX - current.count, retryAfterSeconds: 0 };
}

export function publicCacheKey(hostname: string): string {
  return createHash("sha256").update(String(hostname).toLowerCase()).digest("hex");
}

export async function withPublicCheckCache<T>(key: string, run: () => Promise<T>, now = Date.now()): Promise<{ value: T; cached: boolean }> {
  prune(now);
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) return { value: hit.value, cached: true };
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return { value: await existing, cached: true };
  const promise = run();
  inflight.set(key, promise);
  try {
    const value = await promise;
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return { value, cached: false };
  } finally {
    inflight.delete(key);
  }
}

export const PUBLIC_CHECKER_LIMITS = { rateWindowMs: RATE_WINDOW_MS, rateMax: RATE_MAX, cacheTtlMs: CACHE_TTL_MS } as const;
