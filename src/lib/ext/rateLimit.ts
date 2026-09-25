// N11 — per-token rate limiting for /api/ext/** (60 requests/minute, per the brief).
//
// In-memory by design: the extension is one human in a browser, not a fleet, and a window that
// resets on restart is the honest ceiling for a self-hosted single-process app. The limiter is
// a pure sliding window with the clock injected, so tests move time without waiting.

export interface RateVerdict {
  allowed: boolean;
  /** Requests inside the window after this one (when allowed), or the limit (when not). */
  count: number;
  /** Milliseconds until the oldest hit leaves the window — 0 when allowed. */
  retryAfterMs: number;
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastPrune = 0;

  constructor(
    public readonly limit: number,
    public readonly windowMs: number,
  ) {}

  /**
   * Count one request against `key`. A denied request still counts: retrying in a tight loop
   * must not outpace the window.
   */
  hit(key: string, now: number): RateVerdict {
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter(t => t > cutoff);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return { allowed: false, count: list.length, retryAfterMs: Math.max(1, list[0]! + this.windowMs - now) };
    }
    list.push(now);
    this.hits.set(key, list);
    return { allowed: true, count: list.length, retryAfterMs: 0 };
  }

  /** Peek without counting — the OPTIONS preflight path checks nothing, but a future caller
   *  may want the current load without spending a slot. */
  load(key: string, now: number): number {
    const cutoff = now - this.windowMs;
    return (this.hits.get(key) ?? []).filter(t => t > cutoff).length;
  }

  /** Drop empty keys occasionally so a parade of revoked tokens doesn't grow the map forever.
   *  Called from hit() at most once per window — cheap enough to never think about again. */
  prune(now: number): void {
    if (now - this.lastPrune < this.windowMs) return;
    this.lastPrune = now;
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.hits) {
      const alive = list.filter(t => t > cutoff);
      if (alive.length) this.hits.set(key, alive);
      else this.hits.delete(key);
    }
  }
}

/** The one limiter /api/ext uses: 60 requests per minute per token (brief, "Rate limit"). */
export const EXT_RATE_LIMIT_PER_MIN = 60;
