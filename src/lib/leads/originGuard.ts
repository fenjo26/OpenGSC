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
 * - no Origin and no Referer with a non-empty allow-list → false.
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

/**
 * The widget's own gate: the request's Origin/Referer PLUS the host of the page that
 * actually embeds the iframe.
 *
 * The widget runs inside an iframe served by the OpenGSC instance, so every request it
 * makes is same-origin TO THE INSTANCE: browsers send no Origin header on same-origin
 * GETs, an Origin naming the instance itself on POSTs, and the instance's global
 * `Referrer-Policy: no-referrer` strips the Referer. The headers alone can therefore
 * never name the embedding site — the one thing the allow-list is about. The iframe
 * document's referrer does: the embed page reads `document.referrer` (governed by the
 * EMBEDDING page's policy, not ours) and passes it here as `embedder`.
 *
 * The explicit host is spoofable by a script — but so is an Origin header outside a
 * browser. The list polices casual embedding; the real gates of this contour stay the
 * Turnstile check and the rate limits.
 */
export function checkOriginWithEmbedder(
  origin: string | null,
  referer: string | null,
  embedder: string | null,
  allowedOrigins: string[],
): boolean {
  if (checkOrigin(origin, referer, allowedOrigins)) return true;
  if (!embedder) return false;
  return checkOrigin(embedder, null, allowedOrigins);
}
