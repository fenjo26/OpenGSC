// N11 — pure helpers around the browser-extension bearer token (User.extToken).
// No Prisma here: the DB half lives in auth.ts; these are the decisions a test can make
// without a database (wave-oct README §5).

import { createHash, timingSafeEqual } from "crypto";

/** Prefix shared with /api/ext/token — keeps extension tokens visually distinct from MCP ones.
 *  The route generates `"ogscext_" + randomBytes(24).toString("hex")` (same shape as the MCP
 *  token, different prefix), which isExtTokenFormat below pins. */
export const EXT_TOKEN_PREFIX = "ogscext_";

/** Shape check only — no secrets. Chrome-pasted tokens arrive with stray whitespace; trim first. */
export function isExtTokenFormat(token: string): boolean {
  return /^ogscext_[0-9a-f]{48}$/.test(token.trim());
}

export type TokenCheckReason =
  | "missing"      // no Authorization header at all
  | "format"       // present, but not an extension token shape
  | "revoked"      // the user had a token and revoked it (nothing stored any more)
  | "mismatch";    // a token, but not this one

export interface TokenCheck {
  ok: boolean;
  reason: TokenCheckReason | null;
}

/**
 * Verify a presented token against the stored one in constant time.
 *
 * The database narrows the candidate by equality on a unique column before this runs, so the
 * timing channel this closes is narrow — but the brief asks for constant-time comparison and
 * the cost is two sha256s. Hashing both sides first also sidesteps timingSafeEqual's
 * length-equality requirement without leaking the stored length through an early return.
 */
export function checkExtToken(presented: string | null, stored: string | null): TokenCheck {
  if (presented == null || !presented.trim()) return { ok: false, reason: "missing" };
  const candidate = presented.trim();
  if (!candidate.startsWith(EXT_TOKEN_PREFIX)) return { ok: false, reason: "format" };
  if (stored == null || !stored.trim()) return { ok: false, reason: "revoked" };
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(stored.trim()).digest();
  const ok = timingSafeEqual(a, b);
  return { ok, reason: ok ? null : "mismatch" };
}

/** Stable, non-reversible key for the rate limiter — the raw token never becomes a map key
 *  that might get logged. */
export function tokenKey(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}
