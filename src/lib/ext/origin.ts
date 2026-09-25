// N11 — pure CORS decisions for /api/ext/**. The browser extension is the only cross-origin
// client these routes have, and an extension origin is always `chrome-extension://<id>`, so the
// allowlist is extension IDs (User.extAllowedIds) rather than origins. No Prisma, no Request.

/** Chrome/Edge extension ids: 32 chars from a–p (base-16 without q–z, per the docs). */
export const EXT_ID_RE = /^[a-p]{32}$/;

/**
 * Parse `User.extAllowedIds` — newline-separated by contract, but a textarea paste also brings
 * spaces, commas and blank lines. Duplicates collapse; order is preserved for display.
 */
export function parseAllowedIds(raw: string | null | undefined): string[] {
  const parts = String(raw ?? "").split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  return [...new Set(parts)];
}

/** The extension id an `Origin` header carries, or null when the origin is not an extension's. */
export function extensionIdFromOrigin(origin: string | null | undefined): string | null {
  const value = String(origin ?? "").trim();
  const match = value.match(/^chrome-extension:\/\/([a-p]{32})$/i);
  return match ? match[1]!.toLowerCase() : null;
}

export interface CorsDecision {
  allow: boolean;
  /** The id that matched (lowercased) — null when denied or nothing to match. */
  id: string | null;
  /** Why, for logs and tests: no_origin | not_extension | not_allowed. */
  reason: "no_origin" | "not_extension" | "not_allowed" | null;
}

/**
 * The decision every /api/ext handler makes after the token check: the request's Origin must be
 * a chrome-extension:// origin whose id is on the user's allowlist. A missing or non-extension
 * origin never matches — this API is for the extension and nothing else, curl included.
 */
export function corsDecision(origin: string | null | undefined, allowedIdsRaw: string | null | undefined): CorsDecision {
  if (!origin || !String(origin).trim()) return { allow: false, id: null, reason: "no_origin" };
  const id = extensionIdFromOrigin(origin);
  if (!id) return { allow: false, id: null, reason: "not_extension" };
  const allowed = parseAllowedIds(allowedIdsRaw).map(s => s.toLowerCase());
  if (!allowed.includes(id)) return { allow: false, id, reason: "not_allowed" };
  return { allow: true, id, reason: null };
}

/** The CORS headers an allowed response carries. `*` is never used: the value names the one
 *  extension origin that was checked. Vary: Origin keeps any proxy from caching one
 *  extension's allowance for another's. */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/**
 * Validate and normalize an `extAllowedIds` value being saved from the settings card.
 * Returns the canonical newline-joined form plus whatever was dropped, so the UI can say
 * which lines were not extension ids instead of silently losing them.
 */
export function normalizeAllowedIdsInput(input: string): { value: string; kept: string[]; dropped: string[] } {
  const parts = String(input ?? "").split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const part of parts) {
    if (EXT_ID_RE.test(part)) {
      if (!kept.includes(part)) kept.push(part);
    } else {
      dropped.push(part);
    }
  }
  return { value: kept.join("\n"), kept, dropped };
}
