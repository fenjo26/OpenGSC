import assert from "node:assert/strict";
import test from "node:test";
import { siteQueryFor, normalizeUrlForCompare, classifySerpIndex } from "./serpIndex";

// ─── the site: query ───────────────────────────────────────────────────────────

test("siteQueryFor: a homepage becomes site:host", () => {
  assert.equal(siteQueryFor("https://example.com/"), "site:example.com");
  assert.equal(siteQueryFor("https://example.com"), "site:example.com");
  assert.equal(siteQueryFor("http://example.com/?utm_source=x"), "site:example.com");
});

test("siteQueryFor: a page keeps its path, drops scheme/query/hash/trailing slash", () => {
  assert.equal(siteQueryFor("https://example.com/guides/bonuses/"), "site:example.com/guides/bonuses");
  assert.equal(siteQueryFor("https://www.example.com/page?id=7#top"), "site:www.example.com/page");
});

test("siteQueryFor: a bare domain and a broken string", () => {
  assert.equal(siteQueryFor("example.com/en/"), "site:example.com/en");
  assert.equal(siteQueryFor(""), null);
  assert.equal(siteQueryFor("not a url at all …"), null);
});

// ─── URL normalisation ─────────────────────────────────────────────────────────

test("normalizeUrlForCompare: www, scheme, trailing slash and tracking params are stripped", () => {
  assert.equal(normalizeUrlForCompare("https://www.Example.com/Page/"), normalizeUrlForCompare("http://example.com/Page"));
  assert.equal(
    normalizeUrlForCompare("https://example.com/page?utm_source=feed&utm_medium=rss&gclid=abc"),
    "example.com/page",
  );
  assert.equal(normalizeUrlForCompare("https://example.com/page#section"), "example.com/page");
});

test("normalizeUrlForCompare: a real content parameter survives", () => {
  assert.equal(normalizeUrlForCompare("https://example.com/list?page=2"), "example.com/list?page=2");
  assert.notEqual(normalizeUrlForCompare("https://example.com/list?page=2"), normalizeUrlForCompare("https://example.com/list?page=3"));
});

test("normalizeUrlForCompare: the bare host and the root path are the same URL", () => {
  assert.equal(normalizeUrlForCompare("https://example.com"), normalizeUrlForCompare("https://example.com/"));
});

// ─── the verdict ───────────────────────────────────────────────────────────────

test("classifySerpIndex: found when a result carries the same normalized URL", () => {
  const r = classifySerpIndex(
    "https://example.com/page",
    [{ url: "https://www.example.com/page?utm_source=serp" }, { url: "https://other.example.org/" }],
    null,
  );
  assert.equal(r.status, "indexed");
  assert.equal(r.matchedUrl, "https://www.example.com/page?utm_source=serp");
});

test("classifySerpIndex: an empty successful SERP is not_indexed", () => {
  const r = classifySerpIndex("https://example.com/gone", [], null);
  assert.equal(r.status, "not_indexed");
  assert.equal(r.matchedUrl, null);
});

test("classifySerpIndex: sibling pages without the exact URL are still not_indexed for THIS url", () => {
  const r = classifySerpIndex(
    "https://example.com/",
    [{ url: "https://example.com/blog" }, { url: "https://example.com/shop" }],
    null,
  );
  assert.equal(r.status, "not_indexed");
});

test("classifySerpIndex: a provider error is error — a captcha is NEVER 'not indexed'", () => {
  const r = classifySerpIndex("https://example.com/page", [], "parserResultProblem (captcha suspected)");
  assert.equal(r.status, "error");
  const empty = classifySerpIndex("https://example.com/page", [{ url: "https://example.com/page" }], "serper 429: rate limited");
  assert.equal(empty.status, "error", "even a SERP that contains the URL cannot outrank a provider error");
  assert.equal(empty.matchedUrl, null);
});

test("classifySerpIndex: an unparseable target is our error, not a verdict", () => {
  assert.equal(classifySerpIndex("…", [], null).status, "error");
});
