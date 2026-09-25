// Hreflang generator tests (N1 brief): grouping by path tail (`/demo/` ↔ `/en/demo/`),
// prefix rules, x-default handling, the three output formats as snapshot-style strings, and
// the live-diff comparison used by the verify pass.

import test from "node:test";
import assert from "node:assert/strict";

import {
  stripLanguageSegment,
  tailOf,
  applyPrefixRules,
  groupHreflang,
  pageSet,
  renderHreflang,
  diffHreflangPage,
} from "./index";

// ─── language-segment stripping ───────────────────────────────────────────────────

test("stripLanguageSegment removes a leading language folder only", () => {
  assert.equal(stripLanguageSegment("/en/demo/"), "/demo/");
  assert.equal(stripLanguageSegment("/fr"), "/");
  assert.equal(stripLanguageSegment("/zh-hant/a/b"), "/a/b");
  assert.equal(stripLanguageSegment("/pt-br/demo"), "/demo");
  assert.equal(stripLanguageSegment("/demo/"), "/demo/"); // page slug, not a locale
  assert.equal(stripLanguageSegment("/blog/demo/"), "/blog/demo/"); // 4 letters — not a locale
});

test("tailOf combines the stripped path with the query", () => {
  assert.equal(tailOf("https://site.fr/en/demo/?x=1"), "/demo/?x=1");
  assert.equal(tailOf("https://site.fr/demo/"), "/demo/");
  assert.equal(tailOf("not a url"), "");
});

// ─── grouping by tail ─────────────────────────────────────────────────────────────

const ROWS = [
  { url: "https://site.fr/demo/", lang: "fr" },
  { url: "https://site.fr/en/demo/", lang: "en" },
  { url: "https://site.fr/guide/", lang: "fr" },
  { url: "https://site.fr/en/guide/", lang: "en" },
  { url: "https://site.fr/en/lonely/", lang: "en" }, // no French counterpart
];

test("groupHreflang: /demo/ and /en/demo/ land in one cluster; loners go to singles", () => {
  const { clusters, singles, invalid } = groupHreflang(ROWS);
  assert.equal(invalid.length, 0);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.map(c => c.tail).sort(), ["/demo/", "/guide/"]);
  assert.equal(clusters[0].entries.length, 2);
  assert.equal(singles.length, 1);
  assert.equal(singles[0].tail, "/lonely/");
});

test("groupHreflang: root / and /en/ group together", () => {
  const { clusters } = groupHreflang([
    { url: "https://site.fr/", lang: "fr" },
    { url: "https://site.fr/en/", lang: "en" },
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].tail, "/");
});

test("groupHreflang: bad codes and non-absolute URLs are rejected with a message", () => {
  const { invalid } = groupHreflang([
    { url: "https://site.fr/demo/", lang: "en-UK" }, // GB, not UK
    { url: "/relative/path", lang: "fr" },
    { url: "https://site.fr/demo/", lang: "fr" },
  ]);
  assert.equal(invalid.length, 2);
  assert.ok(invalid[0].includes("not a valid hreflang code"));
  assert.ok(invalid[1].includes("not an absolute http(s) URL"));
});

test("groupHreflang: one URL under two languages is flagged, second row dropped", () => {
  const { invalid, clusters } = groupHreflang([
    { url: "https://site.fr/demo/", lang: "fr" },
    { url: "https://site.fr/demo/", lang: "en" },
  ]);
  assert.equal(invalid.length, 1);
  assert.ok(invalid[0].includes("one URL, one language"));
  assert.equal(clusters.length, 0);
});

test("groupHreflang: duplicate (lang, url) rows collapse silently", () => {
  const { clusters, invalid } = groupHreflang([
    { url: "https://site.fr/demo/", lang: "fr" },
    { url: "https://site.fr/demo/", lang: "fr" },
    { url: "https://site.fr/en/demo/", lang: "en" },
  ]);
  assert.equal(invalid.length, 0);
  assert.equal(clusters[0].entries.length, 2);
});

// ─── prefix rules ─────────────────────────────────────────────────────────────────

test("applyPrefixRules: no prefix means the fallback language, longest prefix wins", () => {
  const { rows, unmatched } = applyPrefixRules(
    ["https://site.fr/demo/", "https://site.fr/en/demo/", "https://site.fr/de/demo/"],
    [
      { prefix: "/en/", lang: "en" },
      { prefix: "/", lang: "fr" }, // fallback
    ],
  );
  assert.equal(unmatched.length, 0);
  assert.deepEqual(rows, [
    { url: "https://site.fr/demo/", lang: "fr" },
    { url: "https://site.fr/en/demo/", lang: "en" },
    { url: "https://site.fr/de/demo/", lang: "fr" }, // /de/ has no rule → fallback /
  ]);
});

test("applyPrefixRules: URLs no rule matches land in unmatched", () => {
  const { unmatched } = applyPrefixRules(["https://site.fr/en-x/demo/"], [{ prefix: "/en/", lang: "en" }]);
  // "/en-x/demo/" starts with "/en" but not "/en/" — no match.
  assert.equal(unmatched.length, 1);
});

// ─── x-default ────────────────────────────────────────────────────────────────────

test("pageSet appends x-default once, last, for every page of the cluster", () => {
  const { clusters } = groupHreflang(ROWS.slice(0, 2));
  const set = pageSet(clusters[0], "https://site.fr/demo/");
  assert.deepEqual(set.map(e => e.lang), ["en", "fr", "x-default"]);
  assert.equal(set[2].href, "https://site.fr/demo/");
});

test("pageSet without x-default keeps just the languages", () => {
  const { clusters } = groupHreflang(ROWS.slice(0, 2));
  assert.deepEqual(pageSet(clusters[0], null).map(e => e.lang), ["en", "fr"]);
});

// ─── the three output formats ─────────────────────────────────────────────────────

test("renderHreflang: <head> block, one comment + full set per page", () => {
  const { clusters } = groupHreflang(ROWS.slice(0, 2));
  const out = renderHreflang(clusters, "https://site.fr/demo/");
  assert.equal(out.invalid.length, 0);
  const lines = out.head.split("\n");
  // Pages are emitted in the cluster's lang-sorted order (en first); every page carries the
  // SAME full set — reciprocity — including its own self-reference.
  assert.equal(lines[0], "<!-- https://site.fr/en/demo/ -->");
  assert.deepEqual(lines.slice(1, 4), [
    '<link rel="alternate" hreflang="en" href="https://site.fr/en/demo/">',
    '<link rel="alternate" hreflang="fr" href="https://site.fr/demo/">',
    '<link rel="alternate" hreflang="x-default" href="https://site.fr/demo/">',
  ]);
  assert.equal(lines[5], "<!-- https://site.fr/demo/ -->");
  assert.deepEqual(lines.slice(6, 9), lines.slice(1, 4));
});

test("renderHreflang: sitemap xhtml:link block", () => {
  const { clusters } = groupHreflang(ROWS.slice(0, 2));
  const out = renderHreflang(clusters, null);
  const lines = out.sitemap.split("\n");
  assert.equal(lines[0], "  <url>");
  assert.equal(lines[1], "    <loc>https://site.fr/en/demo/</loc>");
  assert.equal(lines[2], '    <xhtml:link rel="alternate" hreflang="en" href="https://site.fr/en/demo/"/>');
  assert.equal(lines[3], '    <xhtml:link rel="alternate" hreflang="fr" href="https://site.fr/demo/"/>');
});

test("renderHreflang: standalone .xml document for download", () => {
  const { clusters } = groupHreflang(ROWS.slice(0, 2));
  const out = renderHreflang(clusters, null);
  assert.ok(out.sitemapXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(out.sitemapXml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'));
  assert.ok(out.sitemapXml.includes('xmlns:xhtml="http://www.w3.org/1999/xhtml"'));
  assert.ok(out.sitemapXml.includes("<loc>https://site.fr/demo/</loc>"));
  assert.ok(out.sitemapXml.trimEnd().endsWith("</urlset>"));
});

test("renderHreflang: HTTP Link header, one line per page", () => {
  const { clusters } = groupHreflang(ROWS.slice(0, 2));
  const out = renderHreflang(clusters, null);
  const lines = out.header.split("\n");
  assert.equal(lines[0], "# https://site.fr/en/demo/");
  assert.equal(
    lines[1],
    'Link: <https://site.fr/en/demo/>; rel="alternate"; hreflang="en", <https://site.fr/demo/>; rel="alternate"; hreflang="fr"',
  );
  assert.equal(lines[2], "# https://site.fr/demo/");
});

test("renderHreflang: a bad x-default URL is reported, not silently dropped", () => {
  const { clusters } = groupHreflang(ROWS.slice(0, 2));
  const out = renderHreflang(clusters, "site.fr/demo");
  assert.equal(out.invalid.length, 1);
  assert.ok(out.invalid[0].includes("x-default"));
});

// ─── live diff ────────────────────────────────────────────────────────────────────

test("diffHreflangPage: exact match, missing and extra entries", () => {
  const expected = [
    { lang: "fr", href: "https://site.fr/demo/" },
    { lang: "en", href: "https://site.fr/en/demo/" },
  ];
  // Matches (order-insensitive, trailing slash and case normalized away).
  assert.equal(diffHreflangPage(expected, [
    { lang: "en", href: "https://site.fr/en/demo" },
    { lang: "fr", href: "https://www.site.fr/demo/" },
  ]).matches, true);
  // Missing the en entry.
  const d1 = diffHreflangPage(expected, [{ lang: "fr", href: "https://site.fr/demo/" }]);
  assert.equal(d1.matches, false);
  assert.deepEqual(d1.missing.map(e => e.lang), ["en"]);
  // Extra entry the plan does not include.
  const d2 = diffHreflangPage(expected, [
    ...expected,
    { lang: "de", href: "https://site.fr/de/demo/" },
  ]);
  assert.equal(d2.matches, false);
  assert.deepEqual(d2.extra.map(e => e.lang), ["de"]);
});
