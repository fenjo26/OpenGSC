/**
 * URL normalization shared by the GSC reporting reads. Search Console stores
 * URL *labels*: the same page splits across (a) fragment variants (#toc-N and
 * any anchor) and (b) the www / apex host pair (www always 301s to apex on
 * albokl.com). Every page-dimension grouping/output below normalizes both so
 * each page reports as ONE row. Read-side only — stored rows are untouched and
 * the website's own URLs/redirects/canonicals are not affected.
 */
export function stripUrlFragment(u: string): string {
  if (!u) return u;
  const i = u.indexOf("#");
  return i === -1 ? u : u.slice(0, i);
}

/** Fragment strip + www host folded into the apex host (reporting-only). */
export function normalizePageUrl(u: string): string {
  const s = stripUrlFragment(u);
  return s.replace(/^(https?:\/\/)www\./i, "$1");
}
