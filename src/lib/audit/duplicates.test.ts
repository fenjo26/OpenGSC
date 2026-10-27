import test from "node:test";
import assert from "node:assert/strict";
import { contentShingles, descriptionKey, findNearDuplicates, jaccardSorted, mainContentText, MIN_SHINGLES } from "./duplicates";
import { AUDIT_RULE_BY_ID, evaluateAuditPageRules, type AuditPageFacts } from "./rules";

// A deterministic pseudo-text generator: different seeds give unrelated prose.
const WORDS = "transfer airport taxi driver booking price route halkidiki beach hotel luggage child seat minibus van night day flight delay meet greet sign comfortable private shared return trip".split(" ");
// The city placeholder appears every 40 words — about how often a real route page names it.
function prose(seed: number, words = 400): string {
  let x = seed;
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    out.push(i % 40 === 20 ? "CITY" : WORDS[x % WORDS.length] + (x % 7));
  }
  return out.join(" ");
}
const page = (main: string, chrome = "") =>
  `<html><body><header><nav>Home Tours Contact ${chrome}</nav></header><main><h1>Title</h1><p>${main}</p></main><aside>${chrome}</aside><footer>© 2026 ${chrome}</footer></body></html>`;
const swapCity = (text: string, city: string) => text.replace(/CITY/g, city);

test("main content excludes header, nav, footer, aside, scripts and comments", () => {
  const text = mainContentText(`<html><body><header>HEAD</header><nav>MENU</nav><main>Real <b>words</b> here<script>var x=1</script><!-- hidden --></main><footer>FOOT</footer></body></html>`);
  assert.match(text, /Real\s+words\s+here/);
  for (const noise of ["HEAD", "MENU", "FOOT", "var x", "hidden"]) assert.ok(!text.includes(noise), noise);
});

test("main content falls back to article, then to body minus chrome", () => {
  assert.match(mainContentText(`<body><nav>MENU</nav><article>Story text</article></body>`), /Story text/);
  const body = mainContentText(`<body><nav>MENU</nav><div>Plain text</div><footer>F</footer></body>`);
  assert.match(body, /Plain text/);
  assert.ok(!body.includes("MENU"));
});

test("shingles are sorted, unique and empty for empty pages", () => {
  const s = contentShingles(page(prose(1)));
  assert.ok(s.length > MIN_SHINGLES);
  for (let i = 1; i < s.length; i++) assert.ok(s[i] > s[i - 1]);
  assert.equal(contentShingles("<html><body></body></html>").length, 0);
  assert.equal(jaccardSorted(s, s), 1);
});

test("a template with only the city swapped is a near-duplicate; unrelated pages are not", () => {
  const base = prose(42);
  const pages = [
    { url: "https://x.gr/transfer-kassandra", shingles: contentShingles(page(swapCity(base, "kassandra"))) },
    { url: "https://x.gr/transfer-sithonia", shingles: contentShingles(page(swapCity(base, "sithonia"))) },
    { url: "https://x.gr/transfer-athos", shingles: contentShingles(page(swapCity(base, "athos"))) },
    { url: "https://x.gr/about", shingles: contentShingles(page(prose(7))) },
    { url: "https://x.gr/blog/beaches", shingles: contentShingles(page(prose(99))) },
  ];
  const result = findNearDuplicates(pages);
  assert.deepEqual([...result.byUrl.keys()].sort(), ["https://x.gr/transfer-athos", "https://x.gr/transfer-kassandra", "https://x.gr/transfer-sithonia"]);
  assert.equal(result.clusters.count, 1);
  assert.equal(result.clusters.pages, 3);
  assert.equal(result.clusters.sample[0].size, 3);
  const k = result.byUrl.get("https://x.gr/transfer-kassandra")!;
  assert.equal(k.others, 2);
  assert.ok(k.similarity >= 0.8 && k.similarity < 1, String(k.similarity));
});

test("text repeated on nearly every page is site chrome and does not make pages duplicates", () => {
  // A long boilerplate block inside <main> on all 12 pages, plus short unique text per page.
  const boiler = prose(500, 600);
  const pages = Array.from({ length: 12 }, (_, i) => ({
    url: `https://x.gr/p${i}`,
    shingles: contentShingles(page(`${boiler} ${prose(1000 + i, 120)}`)),
  }));
  assert.equal(findNearDuplicates(pages).byUrl.size, 0);
});

test("pages with too little text are not compared", () => {
  const pages = [
    { url: "https://x.gr/a", shingles: contentShingles(page("short identical text here")) },
    { url: "https://x.gr/b", shingles: contentShingles(page("short identical text here")) },
  ];
  assert.equal(findNearDuplicates(pages).byUrl.size, 0);
});

test("a large crawl stays fast", () => {
  const pages = Array.from({ length: 1500 }, (_, i) => ({ url: `https://x.gr/p${i}`, shingles: contentShingles(page(prose(i + 1, 300))) }));
  // Two planted duplicates among them.
  pages.push({ url: "https://x.gr/copy", shingles: pages[10].shingles });
  const started = Date.now();
  const result = findNearDuplicates(pages);
  const ms = Date.now() - started;
  assert.ok(ms < 15_000, `took ${ms} ms`);
  assert.ok(result.byUrl.has("https://x.gr/copy") && result.byUrl.has("https://x.gr/p10"));
});

test("description key ignores case and whitespace; empty stays empty", () => {
  assert.equal(descriptionKey("  Airport  Transfer\nThessaloniki "), "airport transfer thessaloniki");
  assert.equal(descriptionKey(""), "");
});

const facts = (overrides: Partial<AuditPageFacts> = {}): AuditPageFacts => ({
  hasHtml: true, isRoot: false, isHttps: true, httpStatus: 200, loadMs: 120, redirectHops: 0, redirectLoop: false,
  title: "A useful page title long enough to pass every metadata check", titleDuplicate: false,
  metaDescription: "A concise description of this useful page, long enough to sit inside the healthy 150 to 165 character band without ever triggering a metadata length rule.",
  robots: "index, follow", robotsConflict: false, canonical: "https://x.gr/a", canonicalInvalid: false, canonicalMismatch: false,
  h1Count: 1, h1Text: "A useful page", wordCount: 500, imagesNoAlt: 0, brokenLinkCount: 0, jsRendered: false,
  viewportPresent: true, viewportResponsive: true, htmlLang: "en", jsonLdInvalid: 0, organizationSchemaIncomplete: false,
  openGraphMissing: 0, twitterCardIncomplete: false, mixedContentCount: 0, missingSecurityHeaders: 0,
  sitemapSeeded: false, internalInboundLinks: 2,
  ...overrides,
});

test("duplicate rules fire on their facts; content similarity informs, description duplicates score", () => {
  assert.deepEqual(evaluateAuditPageRules(facts({ descriptionDuplicate: true })), ["description_duplicate"]);
  assert.deepEqual(evaluateAuditPageRules(facts({ nearDuplicate: { with: "https://x.gr/b", similarity: 0.93, others: 1 } })), ["content_near_duplicate"]);
  assert.deepEqual(evaluateAuditPageRules(facts({ descriptionDuplicate: false, nearDuplicate: null })), []);
  assert.equal(AUDIT_RULE_BY_ID.get("content_near_duplicate")?.affectsScore, false);
  assert.notEqual(AUDIT_RULE_BY_ID.get("description_duplicate")?.affectsScore, false);
  // A page closed on purpose is not checked for either.
  assert.deepEqual(evaluateAuditPageRules(facts({ robots: "noindex", noindexIntentional: true, descriptionDuplicate: true, nearDuplicate: { with: "x", similarity: 1, others: 1 } })), ["noindex"]);
});
