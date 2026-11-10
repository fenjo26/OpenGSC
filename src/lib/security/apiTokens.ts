// Bearer tokens at rest: stored as a hash, shown in full exactly once.
//
// MCP and extension tokens used to sit in the User row as plaintext and were echoed back to the
// Settings page on every visit. Anyone holding a database copy — a backup in data/backups, a
// snapshot on a hosting panel — therefore held working credentials with no expiry. Now the row
// keeps `<prefix>:sha256:<hex>`:
//
//   - the prefix (first 12 characters, e.g. `ogsc_1a2b3c4`) is what the UI shows, so the owner can
//     still tell which token is configured where; 12 of 53 characters leaves ~164 random bits;
//   - the hash is computed from the presented token on every request, and the whole stored form is
//     rebuilt from it, so the lookup stays a plain equality on an indexed column.
//
// Rows written before this change still hold the plaintext. `lookupForms` returns both shapes so
// those tokens keep working, and the caller rewrites the row to the hashed form on first use —
// no migration, no forced re-pairing of every client.
//
// Pure (node:crypto only), so it is shared by the MCP route, the extension guard and their tests.

import { createHash, randomBytes, timingSafeEqual } from "crypto";

export const TOKEN_DISPLAY_CHARS = 12;
const HASH_MARK = ":sha256:";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A fresh token: `<prefix><48 hex chars>` (192 random bits). */
export function newToken(prefix: string): string {
  return prefix + randomBytes(24).toString("hex");
}

/** What the database keeps for `token`. Deterministic, so it doubles as the lookup key. */
export function storedFormOf(token: string): string {
  const t = token.trim();
  return t.slice(0, TOKEN_DISPLAY_CHARS) + HASH_MARK + sha256Hex(t);
}

export function isHashedForm(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.includes(HASH_MARK);
}

/** Values to look a presented token up by: the hashed form, then the legacy plaintext. */
export function lookupForms(token: string): [string, string] {
  const t = token.trim();
  return [storedFormOf(t), t];
}

/** The part of a stored value that is safe to show: `ogsc_1a2b3c4…`. Null when nothing is stored. */
export function displayOf(stored: string | null | undefined): string | null {
  if (!stored || !stored.trim()) return null;
  const head = isHashedForm(stored) ? stored.slice(0, stored.indexOf(HASH_MARK)) : stored.trim().slice(0, TOKEN_DISPLAY_CHARS);
  return head + "…";
}

/**
 * Whether `presented` is the token behind `stored`, in constant time, for either storage shape.
 * The database lookup already narrowed by equality; this is the belt to that braces.
 */
export function tokenMatches(presented: string | null | undefined, stored: string | null | undefined): boolean {
  if (!presented || !presented.trim() || !stored || !stored.trim()) return false;
  const expected = isHashedForm(stored) ? stored.trim() : storedFormOf(stored);
  const a = createHash("sha256").update(storedFormOf(presented)).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
