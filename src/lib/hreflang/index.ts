// Hreflang GENERATOR (wave-nov N1) — the constructive counterpart to October's validator
// (src/lib/audit/hreflang.ts, imported here and never modified). The validator reads what a page
// declares; the generator writes it: given the language versions of the same page, it groups
// them, checks the set with the SAME validation functions the audit uses (codes, duplicates,
// absolute URLs), and emits the three forms the annotations can take — <head> <link> tags,
// xhtml:link entries for a sitemap, and the HTTP `Link:` header.
//
// Pure string/array work only: no Prisma, no fetch. The "check on the site" pass lives in the
// verify route and reuses diffHreflangPage below.

import {
  isValidHreflangCode,
  validateHreflangEntries,
  normalizeHreflangUrl,
  hreflangKey,
  type HreflangEntry,
} from "@/lib/audit/hreflang";

export type { HreflangEntry } from "@/lib/audit/hreflang";

/** One input row: an absolute URL and the language(-region) it serves. */
export interface HreflangInput {
  url: string;
  lang: string;
}

/** Path-prefix rule: `/en/` → `en`, empty prefix (no prefix) → `fr`. */
export interface PrefixRule {
  prefix: string;
  lang: string;
}

// A first path segment that counts as a LANGUAGE folder: 2-letter code, optionally with a
// script or region (`pt-br`, `zh-hant`). Deliberately narrow — 3+ letters ("blog", "casino")
// is a page slug, not a locale.
const LANG_SEGMENT = /^[a-z]{2}(?:-[a-z]{2,4})?$/i;

/**
 * The path with a leading language folder removed: `/en/demo/` → `/demo/`, `/fr` → `/`,
 * `/demo/` → `/demo/`, `/zh-hant/a` → `/a`. That stripped remainder is what two language
 * versions of the SAME page have in common, so it is the grouping key.
 */
export function stripLanguageSegment(path: string): string {
  const hadTrailing = path.length > 1 && path.endsWith("/");
  const segments = path.split("/").filter(Boolean);
  if (segments.length && LANG_SEGMENT.test(segments[0])) segments.shift();
  const rest = segments.join("/");
  if (!rest) return "/";
  return "/" + rest + (hadTrailing ? "/" : "");
}

/** Grouping tail of a URL: language-stripped path + query. Empty string when the URL is unusable. */
export function tailOf(url: string): string {
  try {
    const u = new URL(url.trim());
    return stripLanguageSegment(u.pathname) + u.search;
  } catch {
    return "";
  }
}

/**
 * Turn a bare URL list into input rows using prefix rules. Longest prefix wins (so `/en-gb/`
 * beats `/en/` when both exist); the rule with the EMPTY prefix (or "/") is the default that
 * catches whatever nothing more specific matched — the brief's «без префикса → fr». A URL no
 * rule matches at all (no default either) lands in `unmatched` for the caller to handle.
 */
export function applyPrefixRules(urls: string[], rules: PrefixRule[]): { rows: HreflangInput[]; unmatched: string[] } {
  const clean = [...rules]
    .map(r => ({ prefix: r.prefix.trim().toLowerCase(), lang: r.lang.trim() }))
    .filter(r => r.prefix && r.lang);
  const specific = clean.filter(r => r.prefix !== "/").sort((a, b) => b.prefix.length - a.prefix.length);
  const fallback = clean.find(r => r.prefix === "/");
  const rows: HreflangInput[] = [];
  const unmatched: string[] = [];
  for (const raw of urls) {
    const url = raw.trim();
    if (!url) continue;
    // The URL is emitted VERBATIM in the markup (the audit's trailing-slash-stripping
    // normalization is for comparisons only); a scheme is added when missing purely so the
    // path parses — the row keeps what the operator will publish.
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
    let path = "";
    try { path = new URL(candidate).pathname.toLowerCase(); } catch { unmatched.push(url); continue; }
    const hit = specific.find(r => path === r.prefix || path.startsWith(r.prefix.endsWith("/") ? r.prefix : r.prefix + "/")) ?? fallback;
    if (!hit) { unmatched.push(url); continue; }
    rows.push({ url: candidate, lang: hit.lang });
  }
  return { rows, unmatched };
}

/** One page with its alternates: every URL of the cluster, one language each. */
export interface HreflangCluster {
  /** The common language-stripped tail — human-readable identity of the cluster. */
  tail: string;
  /** Deduplicated by language, sorted by lang for stable output. */
  entries: HreflangEntry[];
}

export interface GroupResult {
  clusters: HreflangCluster[];
  /** Clusters with a single language — nothing to cross-link; the UI lists them separately. */
  singles: HreflangCluster[];
  /** Validation messages (bad code, non-absolute URL, same URL under two languages). */
  invalid: string[];
}

/**
 * Group input rows into clusters by tail. Validation of codes and URL shape happens HERE, with
 * the audit's own predicates, so a cluster never contains an entry the audit would flag the
 * moment it is published.
 */
export function groupHreflang(inputs: HreflangInput[]): GroupResult {
  const invalid: string[] = [];
  const byTail = new Map<string, HreflangEntry[]>();
  const langByUrl = new Map<string, string>();

  for (const input of inputs) {
    const lang = String(input.lang ?? "").trim();
    const url = String(input.url ?? "").trim();
    const norm = normalizeHreflangUrl(url);
    if (!norm) { invalid.push(`${url || "(empty)"}: not an absolute http(s) URL`); continue; }
    if (!isValidHreflangCode(lang)) { invalid.push(`${lang || "(empty)"}: not a valid hreflang code`); continue; }
    // One URL = one language. The same URL serving two languages is a real misconfiguration
    // (Google keeps one), not a second alternate.
    const prevLang = langByUrl.get(norm);
    if (prevLang !== undefined && prevLang !== hreflangKey(lang)) {
      invalid.push(`${url}: listed under "${prevLang}" and "${lang}" — one URL, one language`);
      continue;
    }
    langByUrl.set(norm, hreflangKey(lang));
    const tail = tailOf(url);
    const list = byTail.get(tail);
    const entry: HreflangEntry = { lang, href: url };
    if (list) {
      if (!list.some(e => hreflangKey(e.lang) === hreflangKey(lang))) list.push(entry);
    } else byTail.set(tail, [entry]);
  }

  const clusters: HreflangCluster[] = [];
  const singles: HreflangCluster[] = [];
  for (const [tail, entries] of byTail) {
    entries.sort((a, b) => hreflangKey(a.lang).localeCompare(hreflangKey(b.lang)));
    (entries.length > 1 ? clusters : singles).push({ tail, entries });
  }
  clusters.sort((a, b) => a.tail.localeCompare(b.tail));
  singles.sort((a, b) => a.tail.localeCompare(b.tail));
  return { clusters, singles, invalid };
}

/** The full annotation set of one page: every cluster entry + x-default, validated as one set. */
export function pageSet(cluster: HreflangCluster, xDefault: string | null): HreflangEntry[] {
  const set = [...cluster.entries];
  if (xDefault) {
    const norm = normalizeHreflangUrl(xDefault);
    if (norm && !set.some(e => hreflangKey(e.lang) === "x-default")) {
      set.push({ lang: "x-default", href: xDefault });
    }
  }
  return set.sort((a, b) => {
    if (hreflangKey(a.lang) === "x-default") return 1;
    if (hreflangKey(b.lang) === "x-default") return -1;
    return hreflangKey(a.lang).localeCompare(hreflangKey(b.lang));
  });
}

export interface RenderResult {
  /** The three copyable outputs plus the downloadable sitemap document. */
  head: string;
  sitemap: string;      // xhtml:link fragment, one <url> block per page
  header: string;       // one `Link:` line per page
  sitemapXml: string;   // standalone .xml document (urlset with the xhtml namespace)
  /** Validation messages for the emitted sets (duplicate language etc.). */
  invalid: string[];
}

/**
 * Emit all three forms. Every page of every cluster carries the SAME set (hreflang is
 * reciprocal: A declaring B is worthless when B declares nothing), which is also why the
 * x-default entry is added to every page's block, not just one.
 */
export function renderHreflang(clusters: HreflangCluster[], xDefault: string | null): RenderResult {
  const invalid: string[] = [];
  if (xDefault && normalizeHreflangUrl(xDefault) === "") {
    invalid.push(`x-default: "${xDefault}" is not an absolute http(s) URL`);
  }
  const headParts: string[] = [];
  const sitemapParts: string[] = [];
  const headerParts: string[] = [];

  for (const cluster of clusters) {
    const set = pageSet(cluster, xDefault);
    const { invalid: problems, valid } = validateHreflangEntries(set);
    invalid.push(...problems);
    if (!valid.length) continue;

    for (const page of valid) {
      // <head> tags
      headParts.push(`<!-- ${page.href} -->`);
      for (const e of valid) {
        headParts.push(`<link rel="alternate" hreflang="${e.lang}" href="${e.href}">`);
      }
      headParts.push("");
      // sitemap xhtml:link entries
      sitemapParts.push("  <url>");
      sitemapParts.push(`    <loc>${escapeXml(page.href)}</loc>`);
      for (const e of valid) {
        sitemapParts.push(`    <xhtml:link rel="alternate" hreflang="${e.lang}" href="${escapeXml(e.href)}"/>`);
      }
      sitemapParts.push("  </url>");
      // HTTP header (RFC 8288)
      headerParts.push(`# ${page.href}`);
      headerParts.push(`Link: ${valid.map(e => `<${e.href}>; rel="alternate"; hreflang="${e.lang}"`).join(", ")}`);
    }
  }

  const sitemap = sitemapParts.join("\n");
  const sitemapXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    `${sitemap}\n` +
    `</urlset>\n`;

  return {
    head: headParts.join("\n").trimEnd(),
    sitemap,
    header: headerParts.join("\n").trimEnd(),
    sitemapXml,
    invalid,
  };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── live verification (pure half; the fetching lives in the verify route) ───────

export interface HreflangDiff {
  url: string;
  /** true when the live set matches the expected set exactly. */
  matches: boolean;
  /** Expected entries the page does not declare. */
  missing: HreflangEntry[];
  /** Entries the page declares that the expected set does not include. */
  extra: HreflangEntry[];
}

/** Compare what a page declares live against what it should declare. Pure, order-insensitive. */
export function diffHreflangPage(expected: HreflangEntry[], found: HreflangEntry[]): Pick<HreflangDiff, "matches" | "missing" | "extra"> {
  const key = (e: HreflangEntry) => `${hreflangKey(e.lang)}\u0000${normalizeHreflangUrl(e.href)}`;
  const expectedKeys = new Set(expected.map(key));
  const foundKeys = new Set(found.map(key));
  const missing = expected.filter(e => !foundKeys.has(key(e)));
  const extra = found.filter(e => !expectedKeys.has(key(e)));
  return { matches: missing.length === 0 && extra.length === 0, missing, extra };
}
