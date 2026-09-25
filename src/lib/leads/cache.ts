// N9 — the in-memory cache and one-time audit tokens of the public widget contour.
//
// An audit result is cached for 15 minutes per widget key + domain (roadmap §9 "Public
// Lite"), so the same domain checked by several visitors costs one crawl. The cached entry
// is the RAW report: unlocalized findings, so one entry serves every widget language and
// no translated string is ever shared between visitors.
//
// A lead submission must reference a real audit, so POST /api/public/audit hands out a
// one-time token bound to the cache entry. No token → no Lead row, no e-mail: the SMTP
// relay cannot be driven by posting the lead form directly.
//
// Pure module (injectable clock) so the windows are testable without sleeps.

import { randomBytes } from "node:crypto";
import type { LiteAuditReport } from "./types";

export const CACHE_TTL_MS = 15 * 60 * 1000;
export const TOKEN_TTL_MS = 30 * 60 * 1000;
/** Nothing stops a visitor running many audits in a row — bound the Maps. */
const MAX_ENTRIES = 2000;

export class AuditCache {
  private reports = new Map<string, { report: LiteAuditReport; expiresAt: number }>();
  private tokens = new Map<string, { cacheKey: string; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  static key(widgetKey: string, domain: string): string {
    return `${widgetKey}|${domain}`;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.reports) {
      if (entry.expiresAt <= now) this.reports.delete(key);
    }
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) this.tokens.delete(token);
    }
    // Hard cap: drop the oldest quarter rather than refusing to cache.
    if (this.reports.size > MAX_ENTRIES) {
      const excess = this.reports.size - MAX_ENTRIES;
      let dropped = 0;
      for (const key of this.reports.keys()) {
        if (dropped >= excess) break;
        this.reports.delete(key);
        dropped++;
      }
    }
  }

  get(widgetKey: string, domain: string): LiteAuditReport | null {
    this.prune();
    return this.reports.get(AuditCache.key(widgetKey, domain))?.report ?? null;
  }

  set(widgetKey: string, domain: string, report: LiteAuditReport): void {
    this.reports.set(AuditCache.key(widgetKey, domain), { report, expiresAt: this.now() + CACHE_TTL_MS });
    this.prune();
  }

  /** Mint a one-time token bound to the (already cached) audit of this domain. */
  issueToken(widgetKey: string, domain: string): string {
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, { cacheKey: AuditCache.key(widgetKey, domain), expiresAt: this.now() + TOKEN_TTL_MS });
    this.prune();
    return token;
  }

  /**
   * Exchange a token for its cached report. Single-use: consumed whether or not the caller
   * goes on to store a lead, so a leaked token cannot be replayed into many e-mails.
   */
  consumeToken(token: string): LiteAuditReport | null {
    this.prune();
    const entry = this.tokens.get(String(token ?? ""));
    if (!entry) return null;
    this.tokens.delete(String(token ?? ""));
    return this.reports.get(entry.cacheKey)?.report ?? null;
  }
}

/** Process-wide singleton the routes use. */
export const auditCache = new AuditCache();
