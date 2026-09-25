// N11 — pure URL → portfolio-site matching for /api/ext/page (no Prisma, no network).
//
// The extension hands us whatever URL is in the address bar; the portfolio is a list of GSC
// properties (`Site.siteId` — "sc-domain:example.com" or a URL-prefix resource) with `Site.url`
// as a display fallback. Everything here is computable from rows the caller already loaded, so
// it is covered by node:test without a database (wave-oct README §5: clean logic lives apart
// from Prisma).

export interface PortfolioSite {
  id: string;
  /** GSC property root: "sc-domain:example.com" or a URL-prefix resource like "https://example.com/news/". */
  siteId: string;
  /** Display/base URL as the dashboard shows it; consulted when `siteId` doesn't parse. */
  url: string;
}

export interface NormalizedUrl {
  /** Absolute URL, lowercase host, no hash, no trailing slash (except on "/"), default ports dropped. */
  href: string;
  host: string;
  /** Host without a leading "www.". */
  apex: string;
  /** Path with query, no trailing slash (except on "/"). */
  path: string;
}

/**
 * Normalize a page URL the way comparisons need it. Returns null for anything that is not a
 * plain http(s) URL — chrome://, file://, about: and unparseable strings never match a site.
 */
export function normalizePageUrl(input: string): NormalizedUrl | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  // Trailing slash is dropped from the PATH (before the query), and only when the path is
  // longer than "/": a root stays a root.
  let pathname = u.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  const path = `${pathname}${u.search}`;
  const href = `${u.protocol}//${u.host}${path}`;
  const host = u.hostname.toLowerCase();
  const apex = host.replace(/^www\./, "");
  return { href, host, apex, path };
}

interface PropertyMatcher {
  /** The property's host (www-stripped for domain properties). */
  host: string;
  /** Path prefix; "" = whole host. */
  path: string;
  /** Domain properties (sc-domain:) cover every subdomain; URL-prefix ones cover one exact host. */
  subdomains: boolean;
}

/**
 * Parse a GSC property into a matcher. Three shapes, in the order the schema produces them:
 *  - "sc-domain:example.com"  → domain property: host + every subdomain, any path;
 *  - "https://example.com/x/" → URL-prefix property: exactly that host, paths under the prefix;
 *  - "example.com" (a Site.url that never was a URL) → treated as a domain property, because a
 *    bare domain the operator typed carries no path or host-precision information to be strict about.
 */
function propertyMatcher(property: string): PropertyMatcher | null {
  const value = String(property ?? "").trim();
  if (!value) return null;

  if (/^sc-domain:/i.test(value)) {
    const domain = value.replace(/^sc-domain:/i, "").trim().toLowerCase().replace(/\/+$/, "");
    if (!domain.includes(".")) return null;
    return { host: domain.replace(/^www\./, ""), path: "", subdomains: true };
  }

  const parsed = normalizePageUrl(value);
  if (parsed) {
    return { host: parsed.host, path: parsed.path === "/" ? "" : parsed.path, subdomains: false };
  }

  const bare = value.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  if (!bare.includes(".")) return null;
  return { host: bare.split("/")[0], path: "", subdomains: true };
}

/**
 * Does this page belong to this GSC property?
 *
 * Search Console semantics, kept exact because the page's data lives under the property:
 *  - a domain property covers the host and every subdomain — www and deeper;
 *  - a URL-prefix property covers exactly its host (www.example.com is a DIFFERENT property
 *    from example.com in GSC) and every path under its prefix.
 */
export function siteOwnsUrl(site: PortfolioSite, pageUrl: NormalizedUrl): boolean {
  for (const property of [site.siteId, site.url]) {
    const m = propertyMatcher(property);
    if (!m) continue;
    const hostOk = m.subdomains
      ? pageUrl.apex === m.host || pageUrl.apex.endsWith(`.${m.host}`)
      : pageUrl.host === m.host;
    if (!hostOk) continue;
    if (!m.path) return true; // whole-host property
    if (pageUrl.path === m.path || pageUrl.path.startsWith(`${m.path}/`)) return true;
  }
  return false;
}

/**
 * The portfolio site a page URL belongs to, or null for a foreign URL.
 *
 * When several properties match (a domain property plus a URL-prefix one deeper in the same
 * host), the more specific one wins: the URL-prefix property is the one GSC reports the page
 * under, so that is where the DailyMetric rows live. Specificity = the longer matching property
 * string (a prefix property is always longer than the bare domain it sits on).
 */
export function matchPortfolioSite<S extends PortfolioSite>(sites: S[], pageUrl: NormalizedUrl): S | null {
  let best: S | null = null;
  let bestLen = -1;
  for (const site of sites) {
    if (!siteOwnsUrl(site, pageUrl)) continue;
    const len = Math.max(String(site.siteId ?? "").length, String(site.url ?? "").length);
    if (len > bestLen) {
      best = site;
      bestLen = len;
    }
  }
  return best;
}

/**
 * URL variants a metrics row may be stored under. GSC returns absolute URLs, but the exact form
 * varies with trailing slashes, the www subdomain and — rarely — the scheme. The caller feeds
 * these into `url: { in: variants }` so the lookup stays a single indexed query
 * (DailyMetric has @@index([url])) instead of a scan with JS-side fuzzy matching.
 */
export function urlVariants(u: NormalizedUrl): string[] {
  const schemes = u.href.startsWith("https:") ? ["https:", "http:"] : ["http:", "https:"];
  const hosts = u.host.startsWith("www.") ? [u.host, u.apex] : [u.host, `www.${u.host}`];
  const path = u.path === "/" ? "/" : u.path;
  const out = new Set<string>();
  for (const scheme of schemes) {
    for (const host of hosts) {
      out.add(`${scheme}//${host}${path}`);
    }
  }
  return [...out];
}

/** The path of an absolute URL ("/" for roots) — SiteAuditPage rows are matched by path.
 *  Values that are not URLs at all resolve to "/" (a bare domain has no path). */
export function pathOnly(input: string): string {
  const n = normalizePageUrl(input);
  if (n) return n.path === "" ? "/" : n.path;
  const stripped = String(input ?? "").replace(/^https?:\/\/[^/]+/i, "");
  return stripped.startsWith("/") ? stripped : "/";
}
