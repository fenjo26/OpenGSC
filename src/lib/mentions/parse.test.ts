// T6 pure helpers against REAL fixtures in ./__fixtures__/ (see the brief's test list).
// parse.ts imports parseBrandTerms from aeoTracker (the brief says import, not copy), which
// statically imports @/lib/prisma — so DATABASE_URL must point at a scratch file before the
// module loads. Same trick as drops/donors.test.ts; only pure helpers are exercised here.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ParseModule = typeof import("./parse");
let parse!: ParseModule;

const NEWS_FIXTURE = readFileSync(new URL("./__fixtures__/google-news-rss.xml", import.meta.url), "utf8");

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "opengsc-mentions-"));
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  parse = await import("./parse");
});

// ── parseGoogleNewsRss — real feed response (8 real items + 1 synthetic CDATA item) ──

test("parses every <item> of the real fixture", () => {
  const hits = parse.parseGoogleNewsRss(NEWS_FIXTURE, "openai", "en");
  assert.equal(hits.length, 10);
  assert.ok(hits.every(h => h.source === "news" && h.kind === "mention" && h.term === "openai" && h.lang === "en"));
  assert.ok(hits.every(h => h.url.startsWith("https://news.google.com/rss/articles/")));
});

test("splits the trailing ' - Publisher' off the title when it matches <source>", () => {
  const hits = parse.parseGoogleNewsRss(NEWS_FIXTURE, "openai", "en");
  const first = hits[0];
  assert.equal(first.title, "Introducing GPT-6 Sol and Luna");
  assert.equal(first.publisher, "OpenAI");
  // A publisher with spaces splits too (real item 3: The New York Times).
  const nyt = hits.find(h => h.publisher === "The New York Times");
  assert.ok(nyt, " NYT item present");
  assert.ok(!nyt.title.endsWith(" - The New York Times"));
  // A title whose tail does NOT equal the source text keeps its title intact.
  const politico = hits.find(h => h.publisher === "Politico");
  assert.ok(politico && politico.title.length > 0);
});

test("CDATA titles pass through verbatim; entity-encoded titles are decoded", () => {
  const hits = parse.parseGoogleNewsRss(NEWS_FIXTURE, "openai", "en");
  // CDATA is not parsed in XML — its content is literal, entities included.
  const cdata = hits.find(h => h.url.includes("CBMisyntheticCDATAfixtureitem0"));
  assert.ok(cdata, " CDATA item parsed");
  assert.equal(cdata.title, "OpenAI & partners announce «shared» safety standard");
  assert.equal(cdata.publisher, "Example Publisher");
  assert.ok(!cdata.snippet.includes("<"));
  assert.ok(cdata.snippet.includes("OpenAI & partner"));
  assert.ok(cdata.snippet.includes("Example Publisher"));

  // A non-CDATA title with named and numeric entities decodes exactly once.
  const entity = hits.find(h => h.url.includes("CBMisyntheticEntityTitleFixtureitem"));
  assert.ok(entity, " entity-title item parsed");
  assert.equal(entity.title, "Regulator clears OpenAI & partner deal — «shared» standard adopted");
  assert.equal(entity.publisher, "Example Wire");
});

test("parses pubDate into ISO and strips HTML from real descriptions", () => {
  const hits = parse.parseGoogleNewsRss(NEWS_FIXTURE, "openai", "en");
  assert.equal(hits[0].publishedAt, new Date("Wed, 23 Sep 2026 16:30:34 GMT").toISOString());
  for (const h of hits.slice(0, 8)) {
    assert.ok(!h.snippet.includes("<a"), "real descriptions carry an <a> tag before stripping");
    assert.ok(h.snippet.length <= 301, " snippet capped at 300 chars (+ellipsis)");
  }
});

test("returns [] for a feed without items", () => {
  assert.deepEqual(parse.parseGoogleNewsRss('<?xml version="1.0"?><rss><channel></channel></rss>', "x", "en"), []);
});

// ── matchesTerm — word boundary, diacritics, mustInclude ───────────────────────

test("word boundary: Crown does not match Crowning", () => {
  assert.equal(parse.matchesTerm("Crown appointed new chef", { term: "Crown", mustInclude: [] }), true);
  assert.equal(parse.matchesTerm("Crowning achievement", { term: "Crown", mustInclude: [] }), false);
  assert.equal(parse.matchesTerm("The crown. Yes.", { term: "crown", mustInclude: [] }), true);
  assert.equal(parse.matchesTerm("uncrowned king", { term: "crown", mustInclude: [] }), false);
});

test("case- and diacritics-insensitive, Cyrillic boundaries work the same", () => {
  assert.equal(parse.matchesTerm("OPENAI launches GPT", { term: "openai", mustInclude: [] }), true);
  assert.equal(parse.matchesTerm("Café Söhne öffnet", { term: "cafe sohne", mustInclude: [] }), true);
  assert.equal(parse.matchesTerm("Ромашка — цветок", { term: "ромашка", mustInclude: [] }), true);
  assert.equal(parse.matchesTerm("Ромашковый чай", { term: "ромашка", mustInclude: [] }), false);
});

test("multi-word terms tolerate flexible whitespace", () => {
  assert.equal(parse.matchesTerm("Golden\tCrown casino", { term: "Golden Crown", mustInclude: [] }), true);
});

test("mustInclude: the term alone is not enough when context words are configured", () => {
  const t = { term: "Golden Crown", mustInclude: ["slot", "casino", "machine"] };
  assert.equal(parse.matchesTerm("Golden Crown hotel reopens", t), false);
  assert.equal(parse.matchesTerm("Golden Crown slot machine revenue up", t), true);
  // one of the context words is enough
  assert.equal(parse.matchesTerm("Golden Crown casino licensed", t), true);
  // context words are word-boundary matches too: 'casinos' is not 'casino'
  assert.equal(parse.matchesTerm("Golden Crown casinos licensed", t), false);
  assert.equal(parse.matchesTerm("Golden Crown commission met", t), false);
});

test("empty term never matches", () => {
  assert.equal(parse.matchesTerm("anything", { term: "  ", mustInclude: [] }), false);
});

// ── isExcluded ────────────────────────────────────────────────────────────────

test("isExcluded checks title and snippet, not publisher", () => {
  const hit: import("./types").MentionHit = {
    source: "news", kind: "mention", term: "brand", url: "https://example.com/a",
    title: "Brand wins award", snippet: "annual ceremony", publisher: "Casino Gazette",
    lang: "en", publishedAt: null,
  };
  assert.equal(parse.isExcluded(hit, ["casino"]), false); // publisher-only hit does not exclude
  assert.equal(parse.isExcluded(hit, ["lottery", "ceremony"]), true);
  assert.equal(parse.isExcluded(hit, []), false);
});

// ── normalizeMentionUrl ───────────────────────────────────────────────────────

test("lowercases the host and strips utm/fbclid/gclid and the fragment", () => {
  assert.equal(
    parse.normalizeMentionUrl("https://Example.com/News/Story?utm_source=rss&id=7&fbclid=abc&gclid=xy#comments"),
    "https://example.com/News/Story?id=7",
  );
  assert.equal(
    parse.normalizeMentionUrl("https://news.google.com/rss/articles/CBMi?oc=5"),
    "https://news.google.com/rss/articles/CBMi?oc=5",
  );
});

test("a URL longer than 191 chars collapses to a 40-char hex sha1", () => {
  const long = `https://example.com/${"a".repeat(250)}`;
  const key = parse.normalizeMentionUrl(long);
  assert.equal(key.length, 40);
  assert.match(key, /^[0-9a-f]{40}$/);
  // stable
  assert.equal(key, parse.normalizeMentionUrl(long));
});

// ── deriveTerms ───────────────────────────────────────────────────────────────

test("deriveTerms: JSON array, comma string, both become terms with empty mustInclude", () => {
  // The host label joins only when the branded keywords did not already cover it — and the
  // label is the registered domain ("example"), not the subdomain ("shop").
  assert.deepEqual(
    parse.deriveTerms('["Golden Crown","casino"]', "shop.example.com"),
    [{ term: "Golden Crown", mustInclude: [] }, { term: "casino", mustInclude: [] }, { term: "example", mustInclude: [] }],
  );
  assert.deepEqual(
    parse.deriveTerms("alpha, beta", "cdn.alpha.co.uk"),
    [{ term: "alpha", mustInclude: [] }, { term: "beta", mustInclude: [] }], // "alpha" already covered, "co" is not a brand
  );
});

test("deriveTerms: empty keywords fall back to the host without its TLD; short labels are skipped", () => {
  assert.deepEqual(parse.deriveTerms(null, "goldencrown.com"), [{ term: "goldencrown", mustInclude: [] }]);
  assert.deepEqual(parse.deriveTerms("", "abc.io"), []);
  assert.deepEqual(parse.deriveTerms('["openai"]', "openai.com"), [{ term: "openai", mustInclude: [] }]); // no dup with host label
});
