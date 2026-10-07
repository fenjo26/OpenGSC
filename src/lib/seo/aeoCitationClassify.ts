// AEO citation classification — Wave A. Deterministic, synchronous, no network, no AI: given a
// cited domain/URL the classifier answers "who crowds us out of AI answers: Reddit, review
// sites, or competitors?" with plain host/path rules. Anything the rules cannot prove lands in
// "other" — an honest "unknown", never a guess dressed up as a category.
//
// The classifier must stay importable from client components (AeoTracker badges) and from
// server aggregation (visibility store) alike, which is why it has no imports at all: its only
// dependency is the shape of the citations JSON stored on AeoCheck rows.

export type CitationCategory =
  | "brand" | "competitor" | "forum" | "social" | "video" | "developer"
  | "ecommerce" | "reviews" | "reference" | "institutional" | "editorial" | "other";

export type CitationPageType =
  | "homepage" | "article" | "listicle" | "howto" | "comparison" | "review"
  | "product" | "doc" | "forum-thread" | "video" | "other";

export const CITATION_CATEGORIES: CitationCategory[] = [
  "brand", "competitor", "forum", "social", "video", "developer",
  "ecommerce", "reviews", "reference", "institutional", "editorial", "other",
];

/** A citation as stored in AeoCheck.citations — `category`/`pageType` are added by this wave and
 *  are absent on rows written before it (the read path backfills them lazily). */
export interface ClassifiedCitation {
  url: string;
  domain: string;
  title: string;
  category: CitationCategory;
  pageType: CitationPageType;
}

// ─── host normalization ───────────────────────────────────────────────────────

// Local twin of hostOf in seo/aeo.ts — kept here so the module stays import-free (see the
// header). Same rules: lowercase, drop scheme/path, drop the www label.
function normalizeHost(input: string): string {
  let d = String(input ?? "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "");
  d = d.split("/")[0];
  return d.replace(/^www\./, "");
}

function hostLabels(host: string): string[] {
  return host.split(".").filter(Boolean);
}

// Host-boundary match, the same rule isOurs uses everywhere else in the tracker: a subdomain
// belongs to the apex, a lookalike ("notexample.com") does not.
function hostMatches(domain: string, host: string): boolean {
  const d = normalizeHost(domain);
  const h = normalizeHost(host);
  if (!d || !h) return false;
  return d === h || d.endsWith("." + h);
}

// ─── domain categories ────────────────────────────────────────────────────────

// Domain-level rules are deliberately CONSERVATIVE: a label literally named "forum"/"forums"
// is a strong signal, but "community.example.com" is not (it may be a marketing page), so it
// stays "other". Page-type heuristics (classifyPageType) carry the URL-shape half.
const FORUM_HOSTS = ["reddit.com", "quora.com", "stackexchange.com", "discourse.org", "discourse.group"];

const SOCIAL_HOSTS = [
  "facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com",
  "linkedin.com", "pinterest.com", "threads.net", "mastodon.social",
];

const VIDEO_HOSTS = ["youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "rutube.ru"];

const DEVELOPER_HOSTS = ["github.com", "stackoverflow.com", "gitlab.com", "developer.mozilla.org", "npmjs.com"];

// Marketplace families where the first label is the brand (amazon.de, ebay.co.uk, …) — matched
// by label rather than by enumerating every regional domain.
const ECOMMERCE_FIRST_LABELS = new Set(["amazon", "ebay"]);
const ECOMMERCE_HOSTS = ["etsy.com", "aliexpress.com", "walmart.com", "alibaba.com"];

const REVIEWS_HOSTS = ["trustpilot.com", "sitejabber.com", "g2.com", "capterra.com", "reviews.io", "yelp.com"];

const REFERENCE_HOSTS = ["wikipedia.org", "wikimedia.org", "britannica.com", "dictionary.com"];

// Mainstream news domains we are confident about. Deliberately SHORT and extensible: an unknown
// news-looking domain must not be guessed into "editorial" — it goes to "other" until added
// here by a human who has actually looked at it.
const EDITORIAL_HOSTS = [
  "nytimes.com", "washingtonpost.com", "wsj.com", "ft.com", "theguardian.com",
  "bbc.com", "bbc.co.uk", "cnn.com", "reuters.com", "bloomberg.com", "forbes.com",
  "spiegel.de", "lemonde.fr",
];

function matchesAnyHost(domain: string, hosts: string[]): boolean {
  return hosts.some(h => hostMatches(domain, h));
}

/** Stanford and the Cabinet Office in one rule: *.edu, *.gov, and the second-level academic/
 *  government suffixes (.edu.au, .gov.uk, .ac.jp, *.ac.*). The bare ".ac" TLD (Ascension
 *  Island) is NOT counted — the pattern requires a country code after it. */
function isInstitutional(host: string): boolean {
  return /\.(edu|gov|ac)\.[a-z]{2}$/.test(host) || /\.(edu|gov)$/.test(host);
}

export function categorizeDomain(
  domain: string,
  brandDomains: string[] = [],
  competitorDomains: string[] = [],
): CitationCategory {
  const host = normalizeHost(domain);
  if (!host) return "other";

  // Brand and competitor win over every platform rule — a competitor on a reddit.com subdomain
  // (a hosted community) is still "who crowds us out", and that is the question being answered.
  if (brandDomains.some(b => hostMatches(host, b))) return "brand";
  if (competitorDomains.some(c => hostMatches(host, c))) return "competitor";

  const labels = hostLabels(host);
  // forums.example.com / example.forum.io — a host label that is literally "forum(s)".
  if (matchesAnyHost(host, FORUM_HOSTS) || labels.some(l => l === "forum" || l === "forums")) return "forum";
  // stackoverflow.com is developer (it is), stackexchange.com is forum (its sites are Q&A
  // communities) — the two families are split on purpose.
  if (matchesAnyHost(host, SOCIAL_HOSTS)) return "social";
  if (matchesAnyHost(host, VIDEO_HOSTS)) return "video";
  if (matchesAnyHost(host, DEVELOPER_HOSTS)) return "developer";
  if (ECOMMERCE_FIRST_LABELS.has(labels[0] ?? "") || matchesAnyHost(host, ECOMMERCE_HOSTS)) return "ecommerce";
  if (matchesAnyHost(host, REVIEWS_HOSTS)) return "reviews";
  if (matchesAnyHost(host, REFERENCE_HOSTS)) return "reference";
  if (isInstitutional(host)) return "institutional";
  if (matchesAnyHost(host, EDITORIAL_HOSTS)) return "editorial";
  return "other";
}

// ─── page types ───────────────────────────────────────────────────────────────

function urlParts(url: string): { host: string; path: string; query: string } {
  const raw = String(url ?? "").trim();
  if (!raw) return { host: "", path: "", query: "" };
  try {
    const u = new URL(raw);
    return { host: u.hostname.toLowerCase(), path: u.pathname, query: u.search };
  } catch {
    // Not a parseable absolute URL (Gemini's grounding uris sometimes are not): treat the part
    // after the host as the path so the shape rules still have something to read.
    const m = raw.match(/^(?:https?:\/\/)?([^/?#]+)([^?#]*)/i);
    const host = m ? m[1].replace(/^www\./, "").toLowerCase() : "";
    const path = m ? m[2] : "";
    const qIdx = raw.indexOf("?");
    return { host, path, query: qIdx >= 0 ? raw.slice(qIdx) : "" };
  }
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter(Boolean);
}

// Title hints are a FALLBACK for entries whose URL carries no path (a bare domain) — the title
// of the cited page is the only shape information left. Deliberately few, deliberately literal.
function pageTypeFromTitle(title: string): CitationPageType | null {
  const t = String(title ?? "");
  if (!t.trim()) return null;
  if (/\b(top|best)\s+\d+\b/i.test(t)) return "listicle";
  if (/\bhow\s+to\b/i.test(t)) return "howto";
  if (/\svs\.?\s/i.test(t)) return "comparison";
  if (/\breview\b/i.test(t)) return "review";
  return null;
}

export function classifyPageType(url: string, title = ""): CitationPageType {
  const { host, path, query } = urlParts(url);
  const segments = segmentsOf(path);

  // No path at all: the title is the only hint, and failing that the link points at a homepage.
  if (!segments.length) return pageTypeFromTitle(title) ?? "homepage";

  // A youtube-style player URL — checked before the generic segment rules because /watch is
  // meaningless on any other host and the query param is the real signal.
  if (segments[segments.length - 1] === "watch" && /[?&]v=/.test(query)) return "video";

  // Forum thread paths across platforms: Discourse /t/, phpBB viewtopic, the classic /thread and
  // /topic, and Reddit's /r/<sub>/comments/<id>/ — the last one is what powers the Reddit cut.
  const threadish = segments.some(s =>
    s === "t" && segments.length > 1 || s === "thread" || s === "topic" || s.startsWith("viewtopic") || s === "comments",
  );
  if (threadish) return "forum-thread";

  // Site-wide documentation: a /docs(umentation) segment, or a developer.* host whose whole
  // purpose is docs (developer.mozilla.org pages are reference material, not articles).
  if (host.startsWith("developer.") || segments.some(s => s === "docs" || s === "documentation" || s.startsWith("docs-"))) return "doc";
  if (segments.some(s => s.startsWith("top-") || s.startsWith("best-")) || /(^|\/)top-\d+/.test(path)) return "listicle";
  if (/how-to|howto/.test(path) || segments.some(s => s === "guide" || s.endsWith("-guide"))) return "howto";
  if (/-vs-/.test(path) || segments.some(s => s === "vs" || s.startsWith("compare"))) return "comparison";
  if (segments.some(s => s.startsWith("review") || s.endsWith("-review"))) return "review";
  if (segments.some(s => s.startsWith("product") || s === "p" || s === "dp")) return "product";

  // /2026/03/ or /2026/03/12/ — the classic blog date folder, checked here so /news/top-x keeps
  // its more specific listicle verdict.
  if (/\/\d{4}\/\d{2}\//.test(path) || segments.some(s => s === "blog" || s === "news" || s === "article")) return "article";
  return "other";
}

// ─── Reddit ───────────────────────────────────────────────────────────────────

export function isRedditDomain(domain: string): boolean {
  return hostMatches(domain, "reddit.com");
}

/** "https://www.reddit.com/r/Cars/comments/abc/…" → "Cars" (captured verbatim; grouping code
 *  lowercases, display keeps the subreddit's own casing). Any URL shape without an /r/<name>
 *  segment — an old.reddit.com shortlink, a share link — returns null rather than a guess. */
export function extractSubreddit(url: string): string | null {
  const { path } = urlParts(url);
  const m = path.match(/\/r\/([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

// ─── entry-level convenience ──────────────────────────────────────────────────

function isCategory(v: unknown): v is CitationCategory {
  return typeof v === "string" && (CITATION_CATEGORIES as string[]).includes(v);
}

const PAGE_TYPES = ["homepage", "article", "listicle", "howto", "comparison", "review", "product", "doc", "forum-thread", "video", "other"] as const;
function isPageType(v: unknown): v is CitationPageType {
  return typeof v === "string" && (PAGE_TYPES as readonly string[]).includes(v);
}

/** Classify a raw citation list (the AeoCheck.citations JSON, parsed). Entries that already
 *  carry a valid category/pageType keep it — write-time enrichment survives the read path; only
 *  the gaps (rows written before this wave) are filled, so re-reading is idempotent. */
export function classifyCitations(
  raw: { url: string; domain: string; title: string; category?: unknown; pageType?: unknown }[],
  brandDomains: string[] = [],
  competitorDomains: string[] = [],
): ClassifiedCitation[] {
  return (Array.isArray(raw) ? raw : []).map(c => {
    const url = String(c?.url ?? "");
    const domain = String(c?.domain ?? "");
    const title = String(c?.title ?? "");
    return {
      url,
      domain,
      title,
      category: isCategory(c?.category)
        ? c.category
        : categorizeDomain(domain || url, brandDomains, competitorDomains),
      pageType: isPageType(c?.pageType) ? c.pageType : classifyPageType(url, title),
    };
  });
}

// ─── aggregates ───────────────────────────────────────────────────────────────

export interface CategoryCount {
  category: CitationCategory;
  count: number;
  /** Share of classified citations, 0..1 — the "Category share" axis of the UI chart. */
  share: number;
}

/** Citation slots per category, sorted by count then by the fixed category order (a stable,
 *  deterministic tiebreak). Empty input → empty list, which callers render as "no data". */
export function categoryCounts(citations: { category: CitationCategory }[]): CategoryCount[] {
  const counts = new Map<CitationCategory, number>();
  for (const c of citations) {
    if (!c || !isCategory(c.category)) continue;
    counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((s, n) => s + n, 0);
  const order = new Map(CITATION_CATEGORIES.map((c, i) => [c, i]));
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count, share: total ? count / total : 0 }))
    .sort((a, b) => b.count - a.count || (order.get(a.category) ?? 0) - (order.get(b.category) ?? 0));
}

export interface RedditCut {
  /** Reddit citation slots (any reddit.com host, thread or not). */
  count: number;
  /** r/<name> ranked by citation slots, lowercase-grouped, top 10. */
  subreddits: { name: string; count: number }[];
}

/** The Reddit/communities cut: how much of the citation mass is Reddit, and which subreddits
 *  it concentrates in — the actionable half of "who crowds us out". */
export function redditCut(citations: { url: string; domain: string }[]): RedditCut {
  let count = 0;
  const subs = new Map<string, number>();
  for (const c of citations) {
    if (!c || !isRedditDomain(c.domain || c.url)) continue;
    count += 1;
    const sub = extractSubreddit(c.url);
    if (sub) {
      const key = sub.toLowerCase();
      subs.set(key, (subs.get(key) ?? 0) + 1);
    }
  }
  const subreddits = [...subs.entries()]
    .map(([name, n]) => ({ name, count: n }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 10);
  return { count, subreddits };
}
