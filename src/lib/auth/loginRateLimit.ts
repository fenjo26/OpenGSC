// Credentials sign-in lockout for a single Node process.
//
// NextAuth's credentials `authorize` is the only place a password is checked, and it had no
// limit. The client address comes from whichever header the deployment's proxy sets
// (OPENGSC_CLIENT_IP_HEADER, see src/lib/security/clientIp.ts); a header the proxy does not
// overwrite is one the client can forge, so on an instance without that variable the per-IP
// bucket is advisory and the per-account bucket is the real limit.
//
// State lives in the process. A restart clears it, which is the same trade the extension and
// the public widget already make, and this app cannot run more than one process against SQLite.
// Failed attempts are reserved synchronously, before `bcrypt`, so two in-flight guesses cannot
// both slip through the threshold. A successful password drops that account's failures (the
// owner who just remembered it is not still one typo from a lockout) but only the one IP stamp
// for that success, so other failures from the same address stay counted.

export const LOGIN_ACCOUNT_FAILURES = 5;
export const LOGIN_IP_FAILURES = 20;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const MAX_KEYS = 10_000;

export interface LoginAttempt {
  allowed: boolean;
  /** Which bucket refused the attempt. Null when it was allowed. */
  scope: "ip" | "account" | null;
  retryAfterMs: number;
  /**
   * Set when the attempt was reserved. Pass it to `succeed` so a correct password does not
   * consume the IP budget. Null when the attempt was refused.
   */
  stamp: number | null;
}

export interface LoginLimiterOptions {
  accountFailures?: number;
  ipFailures?: number;
  windowMs?: number;
  now?: () => number;
}

export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase().slice(0, 320);
}

// The address a credentials attempt is counted against. Which header is trustworthy depends on the
// deployment, so the logic lives in src/lib/security/clientIp.ts (OPENGSC_CLIENT_IP_HEADER) and is
// shared with the public widget's limits; re-exported here for existing callers.
export { clientIpFromHeaders } from "@/lib/security/clientIp";

export class LoginAttemptLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly accountFailures: number;
  private readonly ipFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: LoginLimiterOptions = {}) {
    this.accountFailures = options.accountFailures ?? LOGIN_ACCOUNT_FAILURES;
    this.ipFailures = options.ipFailures ?? LOGIN_IP_FAILURES;
    this.windowMs = options.windowMs ?? LOGIN_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Reserve one attempt, or refuse it.
   *
   * A refusal does not add another stamp. The window then expires on its own, so an attacker
   * who keeps posting cannot hold the owner's account locked forever. The cost is a fresh
   * budget when the window ends (five guesses per account, twenty per address, each 15 minutes).
   */
  begin(ip: string, email: string): LoginAttempt {
    const now = this.now();
    this.prune(now);
    const ipKey = this.ipKey(ip);
    const accountKey = this.accountKey(email);

    const ipList = this.live(ipKey, now);
    if (ipList.length >= this.ipFailures) {
      return { allowed: false, scope: "ip", retryAfterMs: this.retryAfter(ipList, now), stamp: null };
    }
    if (accountKey) {
      const accountList = this.live(accountKey, now);
      if (accountList.length >= this.accountFailures) {
        return { allowed: false, scope: "account", retryAfterMs: this.retryAfter(accountList, now), stamp: null };
      }
    }

    const stamp = now;
    this.push(ipKey, stamp, now);
    if (accountKey) this.push(accountKey, stamp, now);
    return { allowed: true, scope: null, retryAfterMs: 0, stamp };
  }

  /** A correct password. Clears that account, and removes only this attempt from the IP bucket. */
  succeed(ip: string, email: string, stamp: number): void {
    const accountKey = this.accountKey(email);
    if (accountKey) this.buckets.delete(accountKey);
    const ipKey = this.ipKey(ip);
    const list = this.buckets.get(ipKey);
    if (!list) return;
    const index = list.indexOf(stamp);
    if (index >= 0) list.splice(index, 1);
    if (!list.length) this.buckets.delete(ipKey);
  }

  private ipKey(ip: string): string {
    const clean = ip.trim().slice(0, 128);
    return `ip:${clean || "unknown"}`;
  }

  private accountKey(email: string): string | null {
    const normalized = normalizeLoginEmail(email);
    return normalized ? `acct:${normalized}` : null;
  }

  private live(key: string, now: number): number[] {
    const cutoff = now - this.windowMs;
    const list = (this.buckets.get(key) ?? []).filter(stamp => stamp > cutoff);
    if (list.length) this.buckets.set(key, list);
    else this.buckets.delete(key);
    return list;
  }

  private push(key: string, stamp: number, now: number): void {
    const list = this.live(key, now);
    list.push(stamp);
    this.buckets.set(key, list);
  }

  private retryAfter(list: number[], now: number): number {
    const oldest = list.reduce((min, stamp) => Math.min(min, stamp), now);
    return Math.max(1, oldest + this.windowMs - now);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.buckets) {
      const alive = list.filter(stamp => stamp > cutoff);
      if (alive.length) this.buckets.set(key, alive);
      else this.buckets.delete(key);
    }
    if (this.buckets.size <= MAX_KEYS) return;
    const drop = this.buckets.size - MAX_KEYS;
    let removed = 0;
    for (const key of this.buckets.keys()) {
      this.buckets.delete(key);
      if (++removed >= drop) break;
    }
  }
}

/** The limiter `authorize` uses. One per process. */
export const loginAttempts = new LoginAttemptLimiter();
