import test from "node:test";
import assert from "node:assert/strict";
import { findTrustPages, missingTrustPages, trustPageKind } from "./eeat";
import { extractAuditHtml } from "./pageSignals";
import { AUDIT_RULE_BY_ID, evaluateAuditPageRules, type AuditPageFacts } from "./rules";

test("trust pages are recognised by URL across languages, Greek in both alphabets", () => {
  assert.equal(trustPageKind("https://x.gr/about-us/"), "about");
  assert.equal(trustPageKind("https://x.gr/o-nas"), "about");
  assert.equal(trustPageKind("https://x.gr/" + encodeURIComponent("σχετικά-με-εμάς") + "/"), "about");
  assert.equal(trustPageKind("https://x.gr/epikoinonia"), "contact");
  assert.equal(trustPageKind("https://x.gr/ru/kontakty"), "contact");
  assert.equal(trustPageKind("https://x.gr/privacy-policy.html"), "privacy");
  assert.equal(trustPageKind("https://x.gr/politika-konfidencialnosti"), "privacy");
  assert.equal(trustPageKind("https://x.gr/" + encodeURIComponent("πολιτική-απορρήτου")), "privacy");
  assert.equal(trustPageKind("https://x.gr/terms-and-conditions"), "terms");
  assert.equal(trustPageKind("https://x.gr/de/impressum"), "terms");
  assert.equal(trustPageKind("https://x.gr/transfer-thessaloniki-airport"), null);
  assert.equal(trustPageKind("not a url"), null);
});

test("missing trust pages are those no crawled or linked URL matched", () => {
  const found = findTrustPages(["https://x.gr/", "https://x.gr/contact", "https://x.gr/privacy", "https://x.gr/contact-2"]);
  assert.deepEqual(found, { about: null, contact: "https://x.gr/contact", privacy: "https://x.gr/privacy", terms: null });
  assert.deepEqual(missingTrustPages(found), ["about", "terms"]);
});

const doc = (head: string, body: string) => `<html><head>${head}</head><body>${body}</body></html>`;

test("article detection: og:type article or Article schema; a service page is not an article", () => {
  assert.equal(extractAuditHtml(doc('<meta property="og:type" content="article">', "<p>x</p>")).articleLike, true);
  assert.equal(extractAuditHtml(doc('<script type="application/ld+json">{"@type":"BlogPosting","headline":"x"}</script>', "")).articleLike, true);
  assert.equal(extractAuditHtml(doc('<meta property="og:type" content="website">', "<article>card</article>")).articleLike, false);
});

test("author and date are found in meta, schema, microdata, rel=author, byline classes and <time>", () => {
  const og = '<meta property="og:type" content="article">';
  const none = extractAuditHtml(doc(og, "<p>text</p>"));
  assert.equal(none.authorPresent, false);
  assert.equal(none.datePresent, false);
  assert.equal(extractAuditHtml(doc(og + '<meta name="author" content="Ruslan">', "")).authorPresent, true);
  assert.equal(extractAuditHtml(doc('<script type="application/ld+json">{"@type":"Article","author":{"@type":"Person","name":"R"},"datePublished":"2026-10-01"}</script>', "")).authorPresent, true);
  assert.equal(extractAuditHtml(doc('<script type="application/ld+json">{"@type":"Article","author":{"@type":"Person","name":"R"},"datePublished":"2026-10-01"}</script>', "")).datePresent, true);
  assert.equal(extractAuditHtml(doc(og, '<span class="post-author">R</span>')).authorPresent, true);
  assert.equal(extractAuditHtml(doc(og, '<a rel="author" href="/r">R</a>')).authorPresent, true);
  assert.equal(extractAuditHtml(doc(og + '<meta property="article:published_time" content="2026-10-01T10:00:00Z">', "")).datePresent, true);
  assert.equal(extractAuditHtml(doc(og, '<time datetime="2026-10-01">1 Oct</time>')).datePresent, true);
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

test("trust rules fire on their facts, only articles are asked for a byline, none of them scores", () => {
  assert.deepEqual(evaluateAuditPageRules(facts({ articleLike: true, authorPresent: false, datePresent: false })), ["article_no_author", "article_no_date"]);
  assert.deepEqual(evaluateAuditPageRules(facts({ articleLike: false, authorPresent: false, datePresent: false })), []);
  assert.deepEqual(evaluateAuditPageRules(facts({ isRoot: true, trustPagesMissing: ["about"] })), ["trust_pages_missing"]);
  assert.deepEqual(evaluateAuditPageRules(facts({ isRoot: false, trustPagesMissing: ["about"] })), []);
  assert.deepEqual(evaluateAuditPageRules(facts({ isRoot: true, trustPagesMissing: [] })), []);
  for (const id of ["article_no_author", "article_no_date", "trust_pages_missing"]) {
    assert.equal(AUDIT_RULE_BY_ID.get(id)?.affectsScore, false, id);
    assert.equal(AUDIT_RULE_BY_ID.get(id)?.severity, "info", id);
  }
});
