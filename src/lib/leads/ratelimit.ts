// N9 — in-memory rate limiting for the PUBLIC widget contour.
//
// The widget is reachable by anyone on the internet, so every public action is metered twice:
// per visitor IP (5 audits/hour, 20/day) and per widget key (200/day, one owner's whole
// audience). An IP is never stored raw: the caller hashes it with a per-process salt first
// (hashIp below), and this module only ever sees the hash.
//
// Pure logic, no Prisma and no clock: tests inject `now` and drive the windows by hand.

import { createHash, randomBytes } from "node:crypto";

export interface RateVerdict {
  allowed: boolean;
  /** Which limit fired, for logs and tests; null when allowed. */
  reason: "ip_hour" | "ip_day" | "key_day" | "ip_leads_hour" | null;
  /** Seconds until the limit resets; 0 when allowed. */
  retryAfterSec: number;
}

export const AUDIT_LIMITS = {
  ipPerHour: 5,
  ipPerDay: 20,
  keyPerDay: 200,
  /** Lead form: one IP may submit 10 leads per hour (a lead requires a fresh audit token anyway). */
  leadsPerHour: 10,
} as const;

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** sha256(salt + ":" + ip) — the ONLY form of an IP this contour persists or keys on. */
export function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

/**
 * The per-process IP salt. Generated once per server start: hashes from one boot are useless
 * after a restart, and no two instances share a dictionary. Never exported to clients.
 */
let ipSaltValue: string | null = null;
export function ipSalt(): string {
  if (!ipSaltValue) ipSaltValue = randomBytes(16).toString("hex");
  return ipSaltValue;
}

/**
 * Fixed-window counter. A Map in module memory is deliberate: the limits protect THIS
 * process's outbound crawl budget, survive nowhere else, and a restart simply resets them —
 * an acceptable trade for a self-hosted single-node app, and the only storage that can
 * never leak an IP to disk.
 */
export class WindowCounter {
  private buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Current count inside the window that `key` is in. */
  count(key: string, windowMs: number): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    if (this.now() - bucket.windowStart >= windowMs) return 0;
    return bucket.count;
  }

  /** Register one hit, opening a new window when the old one has expired. */
  hit(key: string, windowMs: number): void {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return;
    }
    bucket.count++;
  }

  /** Seconds until the bucket's window closes (used for Retry-After); ≥ 1. */
  retryAfterSec(key: string, windowMs: number): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 1;
    const msLeft = bucket.windowStart + windowMs - this.now();
    return Math.max(1, Math.ceil(msLeft / 1000));
  }

  /** Drop expired buckets so the Map cannot grow without bound across weeks of uptime. */
  prune(windowMs: number): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= windowMs) this.buckets.delete(key);
    }
  }
}

/** Keys for the audit quota — namespaced so the same counter cannot mix limits. */
export const auditKeys = {
  ipHour: (ipHash: string) => `a:ih:${ipHash}`,
  ipDay: (ipHash: string) => `a:id:${ipHash}`,
  keyDay: (widgetKey: string) => `a:kd:${widgetKey}`,
  leadHour: (ipHash: string) => `l:ih:${ipHash}`,
};

/**
 * Check AND register one audit against every limit. Order matters for the verdict: the
 * tightest window first, so the retry-after a 429 carries points at the soonest reset.
 */
export function takeAuditQuota(
  counter: WindowCounter,
  ipHash: string,
  widgetKey: string,
): RateVerdict {
  counter.prune(DAY_MS);
  const hourKey = auditKeys.ipHour(ipHash);
  const dayKey = auditKeys.ipDay(ipHash);
  const keyDay = auditKeys.keyDay(widgetKey);

  if (counter.count(hourKey, HOUR_MS) >= AUDIT_LIMITS.ipPerHour) {
    return { allowed: false, reason: "ip_hour", retryAfterSec: counter.retryAfterSec(hourKey, HOUR_MS) };
  }
  if (counter.count(dayKey, DAY_MS) >= AUDIT_LIMITS.ipPerDay) {
    return { allowed: false, reason: "ip_day", retryAfterSec: counter.retryAfterSec(dayKey, DAY_MS) };
  }
  if (counter.count(keyDay, DAY_MS) >= AUDIT_LIMITS.keyPerDay) {
    return { allowed: false, reason: "key_day", retryAfterSec: counter.retryAfterSec(keyDay, DAY_MS) };
  }
  counter.hit(hourKey, HOUR_MS);
  counter.hit(dayKey, DAY_MS);
  counter.hit(keyDay, DAY_MS);
  return { allowed: true, reason: null, retryAfterSec: 0 };
}

/** Lead-form quota: hourly per IP only (an audit token is already required). */
export function takeLeadQuota(counter: WindowCounter, ipHash: string): RateVerdict {
  const key = auditKeys.leadHour(ipHash);
  if (counter.count(key, HOUR_MS) >= AUDIT_LIMITS.leadsPerHour) {
    return { allowed: false, reason: "ip_leads_hour", retryAfterSec: counter.retryAfterSec(key, HOUR_MS) };
  }
  counter.hit(key, HOUR_MS);
  return { allowed: true, reason: null, retryAfterSec: 0 };
}
