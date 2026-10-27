/**
 * Trust signals for the Site Audit (the measurable slice of E-E-A-T).
 *
 * What a crawler can verify, and nothing it would have to guess:
 *   - article pages (og:type article, or Article/BlogPosting/NewsArticle schema) that name no
 *     author and carry no publication or update date — the two facts quality raters and AI
 *     answer engines look for first on editorial content;
 *   - whether the site links to an About, Contact, Privacy and Terms page at all, recognised
 *     by URL in the languages the app speaks plus Greek (Greek slugs are matched both in the
 *     alphabet and transliterated).
 * Service pages and listings are deliberately not asked for a byline: a transfer booking page has
 * no author, and flagging it would be noise. All of these inform; none moves the health score —
 * they are signals of trust, not defects.
 *
 * Pure and Prisma-free.
 */

export type TrustPage = "about" | "contact" | "privacy" | "terms";
export const TRUST_PAGES: readonly TrustPage[] = ["about", "contact", "privacy", "terms"];

/** Path tokens per kind, accent-free and lowercase. A path segment matches when it contains one. */
const TRUST_PATTERNS: Record<TrustPage, string[]> = {
  about: [
    "about", "o-nas", "o-nam", "o-kompanii", "pro-nas", "o-sebe",
    "σχετικα", "sxetika", "poioi-eimaste", "ποιοι-ειμαστε", "η-εταιρεια", "i-etaireia",
    "uber-uns", "ueber-uns", "a-propos", "qui-sommes-nous", "quienes-somos", "sobre-nosotros", "sobre-nos",
    "over-ons", "chi-siamo", "关于",
  ],
  contact: [
    "contact", "kontakt", "svyaz", "επικοινωνια", "epikoinonia", "contacto", "contactez", "contatti", "联系",
  ],
  privacy: [
    "privacy", "konfidencialnost", "konfidentsialnost", "personalnye-dannye", "personal-data", "datenschutz",
    "confidentialite", "privacidad", "privacybeleid", "aporrito", "απορρητο", "gdpr", "隐私",
  ],
  terms: [
    "terms", "usloviya", "soglashenie", "oferta", "agb", "conditions-generales", "mentions-legales", "cgv", "cgu",
    "terminos", "condiciones", "voorwaarden", "oroi", "οροι", "条款", "impressum",
  ],
};

const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Which trust page, if any, a URL is — by its path. */
export function trustPageKind(url: string): TrustPage | null {
  let path: string;
  try { path = new URL(url).pathname; } catch { return null; }
  try { path = decodeURIComponent(path); } catch { /* keep the raw path */ }
  const segments = fold(path).split("/").filter(Boolean).map(s => s.replace(/\.(html?|php|aspx?)$/, ""));
  for (const kind of TRUST_PAGES) {
    if (segments.some(segment => TRUST_PATTERNS[kind].some(token => segment.includes(token)))) return kind;
  }
  return null;
}

/**
 * The first URL found for each trust page among every URL the crawl saw — crawled pages and every
 * internal link target, because a privacy page linked from the footer counts even if the crawl
 * limit stopped before fetching it.
 */
export function findTrustPages(urls: Iterable<string>): Record<TrustPage, string | null> {
  const found: Record<TrustPage, string | null> = { about: null, contact: null, privacy: null, terms: null };
  for (const url of urls) {
    const kind = trustPageKind(url);
    if (kind && !found[kind]) found[kind] = url;
  }
  return found;
}

export function missingTrustPages(found: Record<TrustPage, string | null>): TrustPage[] {
  return TRUST_PAGES.filter(kind => !found[kind]);
}

const ARTICLE_TYPES = new Set(["article", "blogposting", "newsarticle", "techarticle", "scholarlyarticle", "report", "liveblogposting"]);

export interface ArticleSignals {
  articleLike: boolean;
  authorPresent: boolean;
  datePresent: boolean;
}

/**
 * Article detection and byline/date presence from the raw HTML plus the parsed head pieces the
 * audit extractor already has. Liberal on what counts as an author or a date (meta, schema,
 * microdata, rel=author, a byline class, <time datetime>) — the finding is about absence.
 */
export function articleSignals(input: {
  html: string;
  ogType: string;
  jsonLdNodes: Record<string, unknown>[];
  metaAuthor: string;
  publishedMeta: string;
}): ArticleSignals {
  const types = (node: Record<string, unknown>) =>
    (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]]).map(t => String(t ?? "").toLowerCase());
  const articleNodes = input.jsonLdNodes.filter(node => types(node).some(t => ARTICLE_TYPES.has(t)));
  const articleLike = input.ogType.trim().toLowerCase() === "article" || articleNodes.length > 0;
  const present = (value: unknown): boolean => {
    if (value == null) return false;
    if (Array.isArray(value)) return value.some(present);
    if (typeof value === "object") return Object.keys(value as object).length > 0;
    return String(value).trim() !== "";
  };
  const nodeHas = (key: string) => articleNodes.some(node => present(node[key]));
  const html = input.html;
  const authorPresent = !!input.metaAuthor.trim()
    || nodeHas("author")
    || /\brel=["']?author\b/i.test(html)
    || /\bitemprop=["']?author\b/i.test(html)
    || /\bclass=["'][^"']*\b(?:author|byline|post-author|entry-author|vcard)\b/i.test(html);
  const datePresent = !!input.publishedMeta.trim()
    || nodeHas("datePublished") || nodeHas("dateModified")
    || /\bitemprop=["']?date(?:Published|Modified)\b/i.test(html)
    || /<time\b[^>]*\bdatetime=/i.test(html);
  return { articleLike, authorPresent, datePresent };
}
