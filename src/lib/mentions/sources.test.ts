// T6 source parsers over REAL Wikimedia API responses in ./__fixtures__/ (no network).
// sources.ts imports ./parse (→ aeoTracker → @/lib/prisma), so DATABASE_URL points at a
// scratch file before the module loads — the donors.test.ts trick.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SourcesModule = typeof import("./sources");
let sources!: SourcesModule;

const fix = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "opengsc-mentions-src-"));
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  sources = await import("./sources");
});

// ── Wikipedia list=search (real response, srsearch="Golden Crown", srlimit=5) ──

test("search rows become mention hits with clean snippets and the last-edit timestamp", () => {
  const hits = sources.parseWikiSearchResponse(fix("wikipedia-search.json"), "en", "Golden Crown");
  assert.equal(hits.length, 5);
  const first = hits[0];
  assert.equal(first.title, "Golden Crown");
  assert.equal(first.url, "https://en.wikipedia.org/wiki/Golden_Crown");
  assert.equal(first.kind, "mention");
  assert.equal(first.source, "wikipedia");
  assert.equal(first.term, "Golden Crown");
  assert.equal(first.publisher, "Wikipedia");
  assert.equal(first.publishedAt, "2025-09-17T20:25:10Z");
  // the snippet arrives with <span class="searchmatch"> markup and &#039; entities
  assert.ok(!first.snippet.includes("<"));
  assert.ok(first.snippet.includes("Iran"));
  assert.ok(first.snippet.length <= 300);
});

// ── Wikipedia list=exturlusage (real response, euquery=openai.com) ────────────

test("exturlusage rows become 'link' hits — Wikipedia pages linking out to the host", () => {
  const hits = sources.parseWikiExturlResponse(fix("wikipedia-exturlusage.json"), "en", "openai.com");
  assert.equal(hits.length, 2);
  assert.ok(hits.every(h => h.kind === "link" && h.source === "wikipedia"));
  assert.ok(hits.every(h => h.term === "openai.com"));
  const titles = hits.map(h => h.title);
  assert.ok(titles.includes("The International 2017"));
  assert.ok(titles.includes("Timeline of artificial intelligence"));
  // the evidence is the external link itself
  assert.equal(hits[0].snippet, "https://blog.openai.com/dota-2/");
  assert.equal(hits[0].url, "https://en.wikipedia.org/wiki/The_International_2017");
  assert.equal(hits[0].publishedAt, null);
});

// ── Wikidata wbgetentities (real response: Q21708200 + Q96237091, both with P856) ──

test("the first entity whose P856 matches the host becomes the single 'entity' row, rev in snippet", () => {
  const hits = sources.parseWikidataEntities(fix("wikidata-entities.json"), "openai.com", "OpenAI");
  assert.equal(hits.length, 1);
  const row = hits[0];
  assert.equal(row.source, "wikidata");
  assert.equal(row.kind, "entity");
  assert.equal(row.url, "https://www.wikidata.org/wiki/Q21708200");
  assert.equal(row.title, "OpenAI");
  assert.equal(row.snippet, "rev:2549069534 · American artificial intelligence research organization");
});

test("a subdomain-only P856 (beta.openai.com) is not the site's host — no entity row", () => {
  assert.deepEqual(sources.parseWikidataEntities(fix("wikidata-entities.json"), "example.com", "Example"), []);
});

test("malformed responses parse to empty, never throw", () => {
  assert.deepEqual(sources.parseWikiSearchResponse({}, "en", "x"), []);
  assert.deepEqual(sources.parseWikiSearchResponse({ query: { search: [{}, { title: "A" }] } }, "en", "x").length, 1);
  assert.deepEqual(sources.parseWikiExturlResponse({ error: "ratelimited" }, "en", "x"), []);
  assert.deepEqual(sources.parseWikidataEntities({ entities: {} }, "x.com", "X"), []);
});
