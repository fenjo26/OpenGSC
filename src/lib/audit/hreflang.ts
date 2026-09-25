// Hreflang audit — pure parsing and validation, no Prisma, no fetch.
//
// Google pairs hreflang annotations by reciprocity: if A declares B as its French version,
// B must declare A back. A one-directional annotation is silently ignored, and the user-visible
// symptom — Google showing the wrong language version — points nowhere near the markup. These
// helpers read a page's hreflang set from the three places it can live (head <link> tags, the
// HTTP `Link` header, and xhtml:link entries in a sitemap), validate it, and run the
// cross-page reciprocity checks over the whole crawled set.
//
// Targets OUTSIDE the crawl are never errors: we did not look at them, so we know nothing
// ("unknown is not an error"). Same principle for a target whose fetch failed.

// ─── code validity (BCP 47 as used by hreflang: ISO 639-1 primary + optional script/region) ───

/** ISO 639-1 two-letter language codes (the complete registry; "eng"-style 3-letter codes are not valid here). */
const ISO639_1 = new Set([
  "aa","ab","ae","af","ak","am","an","ar","as","av","ay","az","ba","be","bg","bh","bi","bm","bn","bo","br","bs",
  "ca","ce","ch","co","cr","cs","cu","cv","cy","da","de","dv","dz","ee","el","en","eo","es","et","eu","fa","ff",
  "fi","fj","fo","fr","fy","ga","gd","gl","gn","gu","gv","ha","he","hi","ho","hr","ht","hu","hy","hz","ia","id",
  "ie","ig","ii","ik","io","is","it","iu","ja","jv","ka","kg","ki","kj","kk","kl","km","kn","ko","kr","ks","ku",
  "kv","kw","ky","la","lb","lg","li","ln","lo","lt","lu","lv","mg","mh","mi","mk","ml","mn","mr","ms","mt","my",
  "na","nb","nd","ne","ng","nl","nn","no","nr","nv","ny","oc","oj","om","or","os","pa","pi","pl","ps","pt","qu",
  "rm","rn","ro","ru","rw","sa","sc","sd","se","sg","si","sk","sl","sm","sn","so","sq","sr","ss","st","su","sv",
  "sw","ta","te","tg","th","ti","tk","tl","tn","to","tr","ts","tt","tw","ty","ug","uk","ur","uz","ve","vi","vo",
  "wa","wo","xh","yi","yo","za","zh","zu",
]);

/** ISO 3166-1 alpha-2 country codes. "UK" is deliberately absent — the code is GB, which is the most common hreflang typo. */
const ISO3166_1 = new Set([
  "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ","BA","BB","BD","BE","BF","BG",
  "BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS","BT","BV","BW","BY","BZ","CA","CC","CD","CF","CG","CH","CI",
  "CK","CL","CM","CN","CO","CR","CU","CV","CW","CX","CY","CZ","DE","DJ","DK","DM","DO","DZ","EC","EE","EG","EH",
  "ER","ES","ET","FI","FJ","FK","FM","FO","FR","GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ",
  "GR","GS","GT","GU","GW","GY","HK","HM","HN","HR","HT","HU","ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT",
  "JE","JM","JO","JP","KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ","LA","LB","LC","LI","LK","LR","LS",
  "LT","LU","LV","LY","MA","MC","MD","ME","MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU",
  "MV","MW","MX","MY","MZ","NA","NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ","OM","PA","PE","PF","PG",
  "PH","PK","PL","PM","PN","PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW","SA","SB","SC","SD","SE","SG",
  "SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV","SX","SY","SZ","TC","TD","TF","TG","TH","TJ","TK",
  "TL","TM","TN","TO","TR","TT","TV","TW","TZ","UA","UG","UM","US","UY","UZ","VA","VC","VE","VG","VI","VN","VU",
  "WF","WS","YE","YT","ZA","ZM","ZW",
]);

/**
 * A valid hreflang value: `x-default`, or an ISO 639-1 language optionally extended with an
 * ISO 15924 script (`zh-Hant`) and/or an ISO 3166-1 / UN M49 region (`fr-CH`, `es-419`).
 * Case-insensitive per BCP 47 (`en-gb` is the same tag as `en-GB`); the classic mistakes are
 * rejected: `en-UK` (the country code is GB), `fr_FR` (underscore), `eng` (not 2-letter).
 */
export function isValidHreflangCode(code: string): boolean {
  const value = code.trim();
  if (value.toLowerCase() === "x-default") return true;
  const parts = value.split("-");
  if (parts.length > 3) return false;
  const lang = parts[0] ?? "";
  if (!/^[a-zA-Z]{2}$/.test(lang) || !ISO639_1.has(lang.toLowerCase())) return false;
  let region = parts.slice(1);
  // A 4-letter subtag is an ISO 15924 script (zh-Hant, sr-Latn; case-insensitive per BCP 47).
  // No 4-letter regions exist, so the shape alone disambiguates script from region.
  if (region.length >= 1 && /^[a-zA-Z]{4}$/.test(region[0] ?? "")) {
    region = region.slice(1);
  }
  for (const part of region) {
    if (/^[A-Za-z]{2}$/.test(part)) {
      if (!ISO3166_1.has(part.toUpperCase())) return false;
    } else if (!/^\d{3}$/.test(part)) {
      return false;
    }
  }
  return true;
}

/** First subtag lowercased — the language itself, used for <html lang> comparison. */
export function hreflangPrimary(code: string): string {
  return code.trim().toLowerCase().split("-")[0] ?? "";
}

/** Lowercased tag for "same language listed twice" detection (en == EN == en). */
export const hreflangKey = (code: string): string => code.trim().toLowerCase();

// ─── URL normalization (shared by reciprocity, self-entry and target checks) ───

/**
 * Comparable form of an absolute URL: lowercase host without `www.`, no hash, no trailing
 * slash (except on the root). Query strings are kept — they are part of the page's identity.
 * Returns "" when the value is not an absolute http(s) URL.
 */
export function normalizeHreflangUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.protocol}//${host}${path}${u.search}`;
  } catch {
    return "";
  }
}

// ─── source 1: <link rel="alternate" hreflang> in <head> ───

export interface HreflangEntry {
  lang: string;
  href: string;
}

function tagAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const key = match[1].toLowerCase();
    if (key === "link" || key === "meta" || key === "html" || key === "script") continue;
    const raw = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[key] = raw
      .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  }
  return attrs;
}

/** `<link rel="alternate" hreflang="fr" href="…">` tags from the document head (first 200 KB, same window as the other head signals). */
export function parseHreflangHead(html: string): HreflangEntry[] {
  const head = html.slice(0, 200_000);
  const out: HreflangEntry[] = [];
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = tagAttributes(tag);
    const rels = (attrs.rel || "").toLowerCase().split(/\s+/);
    if (!rels.includes("alternate")) continue;
    const lang = (attrs.hreflang || "").trim();
    const href = (attrs.href || "").trim();
    if (lang && href) out.push({ lang, href });
  }
  return out;
}

// ─── source 2: the HTTP `Link` header (RFC 8288) ───

/**
 * `<https://example.fr/>; rel="alternate"; hreflang="fr"` entries from a Link header.
 * Entries are comma-separated and commas also occur inside quoted parameters, so the split
 * happens only on commas outside angle brackets and quotes.
 */
export function parseHreflangLinkHeader(header: string): HreflangEntry[] {
  if (!header.trim()) return [];
  const parts: string[] = [];
  let current = "";
  let inAngle = false;
  let inQuote = false;
  for (const char of header) {
    if (char === '"' && !inAngle) inQuote = !inQuote;
    if (char === "<" && !inQuote) inAngle = true;
    if (char === ">" && !inQuote) inAngle = false;
    if (char === "," && !inAngle && !inQuote) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);

  const out: HreflangEntry[] = [];
  for (const part of parts) {
    const uriMatch = part.match(/<([^>]*)>/);
    if (!uriMatch) continue;
    const href = uriMatch[1].trim();
    let relAlternate = false;
    let lang = "";
    for (const param of part.matchAll(/([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^\s;,]+))/g)) {
      const key = (param[1] || "").toLowerCase();
      const value = param[2] ?? param[3] ?? "";
      if (key === "rel" && value.toLowerCase().split(/\s+/).includes("alternate")) relAlternate = true;
      if (key === "hreflang") lang = value.trim();
    }
    if (relAlternate && lang && href) out.push({ lang, href });
  }
  return out;
}

// ─── source 3: xhtml:link inside <url> entries of a sitemap ───

/**
 * hreflang declared in an XML sitemap: `<url><loc>page</loc><xhtml:link rel="alternate"
 * hreflang="en" href="…"/></url>`. Returns page URL → its entries; pages without
 * xhtml:link children are absent from the map.
 */
export function parseHreflangSitemap(xml: string): Map<string, HreflangEntry[]> {
  const out = new Map<string, HreflangEntry[]>();
  for (const urlBlock of xml.match(/<url\b[^>]*>([\s\S]*?)<\/url>/gi) ?? []) {
    const loc = urlBlock.match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i)?.[1]?.trim();
    if (!loc) continue;
    const entries: HreflangEntry[] = [];
    for (const linkTag of urlBlock.match(/<(?:\w+:)?link\b[^>]*>/gi) ?? []) {
      const attrs = tagAttributes(linkTag);
      const rels = (attrs.rel || "").toLowerCase().split(/\s+/);
      if (!rels.includes("alternate")) continue;
      const lang = (attrs.hreflang || "").trim();
      const href = (attrs.href || "").trim();
      if (lang && href) entries.push({ lang, href });
    }
    if (entries.length) out.set(loc, entries);
  }
  return out;
}

/**
 * Union of the sources, exact duplicates removed. A page "has hreflang" when the merged
 * set is non-empty — one source listing it is enough.
 */
export function mergeHreflangEntries(...lists: HreflangEntry[][]): HreflangEntry[] {
  const seen = new Set<string>();
  const out: HreflangEntry[] = [];
  for (const list of lists) {
    for (const entry of list) {
      const key = `${hreflangKey(entry.lang)}\u0000${entry.href.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

// ─── per-page validation ───

export interface HreflangValidated {
  /** Human-readable problems ("en-UK: not a valid hreflang code"), one per finding. */
  invalid: string[];
  /** Entries that passed validation, for the cross-page checks. */
  valid: HreflangEntry[];
}

/**
 * The three per-entry problems the audit can state with certainty: a malformed value, a
 * relative or non-http href, and the same language listed twice with different URLs
 * (Google keeps only one — the other is dropped silently).
 */
export function validateHreflangEntries(entries: HreflangEntry[]): HreflangValidated {
  const invalid: string[] = [];
  const valid: HreflangEntry[] = [];
  const seen = new Map<string, string>(); // lang key → normalized href of its first valid entry

  for (const entry of entries) {
    const lang = entry.lang.trim();
    const href = entry.href.trim();
    if (!isValidHreflangCode(lang)) {
      invalid.push(`${lang || "(empty)"}: not a valid hreflang code`);
      continue;
    }
    if (normalizeHreflangUrl(href) === "") {
      invalid.push(`${lang}: "${href}" is not an absolute http(s) URL`);
      continue;
    }
    const key = hreflangKey(lang);
    const previous = seen.get(key);
    const normalized = normalizeHreflangUrl(href);
    if (previous !== undefined && previous !== normalized) {
      invalid.push(`${lang} listed twice with different URLs`);
      continue;
    }
    if (previous !== undefined) continue; // exact duplicate across sources — keep one copy
    seen.set(key, normalized);
    valid.push(entry);
  }
  return { invalid, valid };
}

// ─── cross-page checks over the whole crawl ───

/** What the crawl knows about a page that an hreflang entry points at. Absent = never looked at. */
export interface HreflangTargetState {
  httpStatus: number; // 0 = fetch failed (unknown, not an error)
  noindex: boolean;
  /** Absolute canonical when present; mismatch is judged against the target's own URL. */
  canonical: string | null;
}

export interface HreflangPageInput {
  url: string;
  /** Value of <html lang> on the page, "" when absent. */
  htmlLang: string;
  /** Merged entries from all three sources; empty = the page has no hreflang set. */
  entries: HreflangEntry[];
}

export interface HreflangPageFindings {
  invalid: string[];
  selfMissing: boolean;
  /** "lang → URL: why the target is not a valid alternate", for targets the crawl DID fetch. */
  targetBad: string[];
  /** Pages that declare this page as their alternate while this page never links back. */
  noReturn: string[];
  /** True only on one representative page per distinct hreflang set (site-scope rule). */
  xDefaultMissing: boolean;
  /** "" or evidence like `lang="fr" vs hreflang "en"`. */
  langMismatch: string;
}

const shortUrl = (url: string): string => {
  try { return new URL(url).pathname + new URL(url).search || "/"; } catch { return url; }
};

/**
 * All hreflang findings for one crawl, keyed by page URL (only pages WITH a set are included).
 *
 * Everything here is decided from the crawl alone. A target outside `targetStates` was never
 * fetched, so the target checks simply do not apply to it — that is a statement about our
 * knowledge, not a pass mark.
 */
export function checkHreflangSite(
  pages: HreflangPageInput[],
  targetStates: Map<string, HreflangTargetState>,
): Map<string, HreflangPageFindings> {
  // First pass: validate each page's set and index it by normalized URL for reciprocity.
  const validated = new Map<string, { input: HreflangPageInput; valid: HreflangEntry[]; invalid: string[] }>();
  for (const page of pages) {
    if (!page.entries.length) continue;
    const { invalid, valid } = validateHreflangEntries(page.entries);
    validated.set(normalizeHreflangUrl(page.url), { input: page, valid, invalid });
  }

  // Reciprocity: A declares B (both crawled) while B's set never links back to A. The finding
  // lands on B — that is the page whose set must gain the return entry — and the evidence
  // names A, the page doing the pointing.
  const noReturn = new Map<string, string[]>();
  for (const [normA, { input: pageA, valid }] of validated) {
    for (const entry of valid) {
      if (hreflangKey(entry.lang) === "x-default") continue;
      const normB = normalizeHreflangUrl(entry.href);
      if (!normB || normB === normA) continue;
      const back = validated.get(normB);
      if (!back) continue; // target outside the crawl — unknown, not an error
      const linksBack = back.valid.some(other => normalizeHreflangUrl(other.href) === normA);
      if (!linksBack) {
        const list = noReturn.get(normB) ?? [];
        list.push(`${shortUrl(pageA.url)} → here (${entry.lang}), no link back`);
        noReturn.set(normB, list);
      }
    }
  }

  const findings = new Map<string, HreflangPageFindings>();
  // x-default is site-scope: the same set usually repeats on every page of the cluster, so it
  // is reported once per distinct set, on the first page carrying it (crawl order).
  const xDefaultReportedSets = new Set<string>();
  for (const { input, valid, invalid } of validated.values()) {
    const selfNorm = normalizeHreflangUrl(input.url);
    const ownEntry = valid.find(entry => normalizeHreflangUrl(entry.href) === selfNorm) ?? null;

    const targetBad: string[] = [];
    for (const entry of valid) {
      const state = targetStates.get(normalizeHreflangUrl(entry.href));
      if (!state) continue; // never fetched
      if (state.httpStatus === 0) continue; // fetch failed — unknown is not an error
      let bad = "";
      if (state.httpStatus >= 300 && state.httpStatus < 400) bad = `redirect ${state.httpStatus}`;
      else if (state.httpStatus !== 200) bad = `HTTP ${state.httpStatus}`;
      else if (state.noindex) bad = "noindex";
      else if (state.canonical && normalizeHreflangUrl(state.canonical) !== normalizeHreflangUrl(entry.href)) {
        bad = `canonical → ${shortUrl(state.canonical)}`;
      }
      if (bad) targetBad.push(`${entry.lang} → ${shortUrl(entry.href)}: ${bad}`);
    }

    let langMismatch = "";
    if (input.htmlLang && ownEntry) {
      const pageLang = hreflangPrimary(input.htmlLang);
      const entryLang = hreflangPrimary(ownEntry.lang);
      if (pageLang && entryLang && pageLang !== entryLang) {
        langMismatch = `lang="${input.htmlLang}" vs hreflang "${ownEntry.lang}"`;
      }
    }

    const languages = new Set(valid.filter(e => hreflangKey(e.lang) !== "x-default").map(e => hreflangPrimary(e.lang)));
    const hasXDefault = valid.some(e => hreflangKey(e.lang) === "x-default");
    let xDefaultMissing = false;
    if (languages.size >= 2 && !hasXDefault) {
      const signature = valid.map(e => `${hreflangKey(e.lang)}|${normalizeHreflangUrl(e.href)}`).sort().join(";");
      if (!xDefaultReportedSets.has(signature)) {
        xDefaultReportedSets.add(signature);
        xDefaultMissing = true;
      }
    }

    findings.set(input.url, {
      invalid,
      selfMissing: !ownEntry,
      targetBad,
      noReturn: (noReturn.get(selfNorm) ?? []).slice(0, 4),
      xDefaultMissing,
      langMismatch,
    });
  }
  return findings;
}
