// The reporting-only URL fold: fragment variants and the www/apex host pair must collapse
// into ONE row, and when the site's registered host is known the pair folds TOWARD it —
// a www-canonical site keeps www, an apex-canonical site keeps apex — so the printed URL
// matches the form the site itself canonicalizes to instead of always stripping www.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePageUrl, siteHostOf, stripUrlFragment } from "./url-normalize";

test("fragments always strip", () => {
  assert.equal(stripUrlFragment("https://a.com/x#toc-2"), "https://a.com/x");
  assert.equal(stripUrlFragment("https://a.com/x"), "https://a.com/x");
  assert.equal(normalizePageUrl("https://www.a.com/x#anchor", "https://www.a.com"), "https://www.a.com/x");
});

test("siteHostOf accepts the shapes Site.url appears in", () => {
  assert.equal(siteHostOf("https://www.example.com/"), "www.example.com");
  assert.equal(siteHostOf("example.com"), "example.com");
  assert.equal(siteHostOf("https://example.com"), "example.com");
  assert.equal(siteHostOf(""), "");
});

test("with a registered host, the pair folds toward it", () => {
  // www-canonical site: apex labels relabel to www, not the other way
  assert.equal(normalizePageUrl("https://example.com/p", "https://www.example.com"), "https://www.example.com/p");
  assert.equal(normalizePageUrl("https://www.example.com/p", "https://www.example.com"), "https://www.example.com/p");
  // apex-canonical site: www labels fold to apex
  assert.equal(normalizePageUrl("https://www.example.com/p", "example.com"), "https://example.com/p");
  // registered host given bare, without protocol
  assert.equal(normalizePageUrl("https://example.com/p", "www.example.com"), "https://www.example.com/p");
});

test("a host that is neither twin is left alone", () => {
  // subdomains are NOT the www/apex pair — folding them would mislabel the page
  assert.equal(normalizePageUrl("https://blog.example.com/p", "https://www.example.com"), "https://blog.example.com/p");
  assert.equal(normalizePageUrl("https://other.com/p", "https://www.example.com"), "https://other.com/p");
});

test("without a registered host the historical default holds: www folds to apex", () => {
  assert.equal(normalizePageUrl("https://www.example.com/p"), "https://example.com/p");
  assert.equal(normalizePageUrl("https://www.example.com/p", ""), "https://example.com/p");
  assert.equal(normalizePageUrl("https://example.com/p"), "https://example.com/p");
});
