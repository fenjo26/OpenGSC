/**
 * URL normalization shared by the GSC reporting reads. Search Console stores
 * URL *labels*: the same page splits across (a) fragment variants (#toc-N and
 * any anchor) and (b) the www / apex host pair (whichever of the two redirects
 * to the other). Every page-dimension grouping/output below normalizes both so
 * each page reports as ONE row. Read-side only — stored rows are untouched and
 * the website's own URLs/redirects/canonicals are not affected.
 */
export function stripUrlFragment(u: string): string {
  if (!u) return u;
  const i = u.indexOf("#");
  return i === -1 ? u : u.slice(0, i);
}

/**
 * Host of a site's registered URL, from any of the shapes Site.url appears in
 * ("https://www.example.com/", "www.example.com", "example.com"). "" when unparseable.
 */
export function siteHostOf(siteUrl: string): string {
  if (!siteUrl) return "";
  try {
    return new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Fragment strip + www/apex fold (reporting-only).
 *
 * When the caller knows the site's registered host, the pair folds TOWARD it: a site
 * registered as www.example.com keeps its www form instead of being relabeled to the apex
 * host (and vice versa), so the reported URL matches the form the site itself canonicalizes
 * to. A host that is neither twin (a subdomain, a foreign label) is left untouched.
 *
 * Without a registered host the historical default applies: www folds to the apex host.
 */
export function normalizePageUrl(u: string, siteUrl?: string): string {
  const s = stripUrlFragment(u);
  const target = siteUrl ? siteHostOf(siteUrl) : "";
  const m = /^(https?:\/\/)([^/?#]+)([\s\S]*)$/i.exec(s);
  if (m && target) {
    const host = m[2].toLowerCase();
    if (host.replace(/^www\./, "") === target.replace(/^www\./, "")) {
      return m[1] + target + m[3];
    }
    return s;
  }
  return s.replace(/^(https?:\/\/)www\./i, "$1");
}
