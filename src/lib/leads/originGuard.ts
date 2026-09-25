// N9 — Origin/Referer check for the public widget routes.
//
// `allowedOrigins` in the widget settings decides which sites may embed the widget. Empty
// means "anywhere" (the settings card warns about it). The check compares HOSTNAMES, not
// full origins: the operator writes "example.com", and that should cover however the page
// is served (https, a www subdomain) without turning the setting into a URL-syntax quiz.
//
// Pure logic — no imports, injectable inputs, tested directly.

/** "https://Blog.Example.com/" → "blog.example.com"; "" on anything unparseable. */
export function normalizeOriginHost(origin: string): string {
  const raw = origin.trim();
  if (!raw) return "";
  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withProtocol).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** Hostname of the page a Referer header points at; "" when absent or unparseable. */
export function refererHost(referer: string | null): string {
  if (!referer) return "";
  try {
    return new URL(referer).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * True when the request may use this widget.
 *
 * - empty `allowedOrigins` → always true (operator's explicit choice, warned in the UI);
 * - otherwise the Origin header (or, absent it, the Referer) must name an allowed host;
 *   an entry matches itself and its subdomains ("example.com" covers "www.example.com");
 * - no Origin and no Referer with a non-empty allow-list → false. The widget lives in an
 *   iframe and its POSTs are cross-origin, so a real embedder always sends one of the two;
 *   anything else is a script, and strictness costs nothing legitimate.
 */
export function checkOrigin(
  origin: string | null,
  referer: string | null,
  allowedOrigins: string[],
): boolean {
  const entries = allowedOrigins.map(normalizeOriginHost).filter(Boolean);
  if (!entries.length) return true;

  const candidate = normalizeOriginHost(origin ?? "") || refererHost(referer);
  if (!candidate) return false;

  return entries.some(entry =>
    candidate === entry || candidate.endsWith(`.${entry}`),
  );
}
