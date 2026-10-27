import test from "node:test";
import assert from "node:assert/strict";
import { sitemapCoverage } from "./sitemapCheck";
import { AUDIT_RULE_BY_ID, evaluateAuditPageRules, type AuditPageFacts } from "./rules";

test("coverage counts same-host listed URLs, folds spellings, samples the unchecked ones", () => {
  const cov = sitemapCoverage(
    ["https://x.gr/", "https://x.gr/tours/", "http://www.x.gr/tours", "https://x.gr/a", "https://x.gr/b", "https://cdn.other.com/x"],
    ["https://x.gr/", "https://x.gr/tours"],
    "https://x.gr/",
    { seeded: false, partial: false },
  );
  assert.equal(cov.listed, 4);
  assert.equal(cov.checked, 2);
  assert.equal(cov.notChecked, 2);
  assert.deepEqual(cov.sample, ["https://x.gr/a", "https://x.gr/b"]);
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

test("a listed redirect, error or non-canonical page gets its sitemap finding", () => {
  const redirect = evaluateAuditPageRules(facts({ inSitemap: true, hasHtml: false, httpStatus: 301 }));
  assert.ok(redirect.includes("sitemap_redirect") && redirect.includes("redirect"));
  const missing = evaluateAuditPageRules(facts({ inSitemap: true, hasHtml: false, httpStatus: 404 }));
  assert.ok(missing.includes("sitemap_error") && missing.includes("http_error"));
  assert.ok(evaluateAuditPageRules(facts({ inSitemap: true, hasHtml: false, httpStatus: 0 })).includes("sitemap_error"));
  const nonCanonical = evaluateAuditPageRules(facts({ inSitemap: true, canonicalMismatch: true }));
  assert.ok(nonCanonical.includes("sitemap_non_canonical") && nonCanonical.includes("canonical_mismatch"));
});

test("a healthy listed page, and anything without an inventory, stays silent", () => {
  assert.deepEqual(evaluateAuditPageRules(facts({ inSitemap: true })), []);
  assert.deepEqual(evaluateAuditPageRules(facts({ inSitemap: false, hasHtml: false, httpStatus: 301 })), ["redirect"]);
  assert.deepEqual(evaluateAuditPageRules(facts({ hasHtml: false, httpStatus: 301 })), ["redirect"]);
});

test("sitemap findings score: they are facts about the owner's own list", () => {
  for (const id of ["sitemap_redirect", "sitemap_error", "sitemap_non_canonical"]) {
    assert.notEqual(AUDIT_RULE_BY_ID.get(id)?.affectsScore, false, id);
    assert.equal(AUDIT_RULE_BY_ID.get(id)?.severity, "warning", id);
  }
});
