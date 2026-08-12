import test from "node:test";
import assert from "node:assert/strict";
import { extractAuditHtml, missingSecurityHeaders, robotsDirectivesConflict } from "./pageSignals";
import { evaluateAuditPageRules, type AuditPageFacts } from "./rules";

const healthyFacts = (overrides: Partial<AuditPageFacts> = {}): AuditPageFacts => ({
  hasHtml: true,
  isRoot: false,
  isHttps: true,
  httpStatus: 200,
  loadMs: 120,
  redirectHops: 0,
  redirectLoop: false,
  title: "A useful page title",
  titleDuplicate: false,
  metaDescription: "A concise description of this useful page.",
  robots: "index, follow",
  robotsConflict: false,
  canonical: "https://example.com/page",
  canonicalInvalid: false,
  canonicalMismatch: false,
  h1Count: 1,
  wordCount: 500,
  imagesNoAlt: 0,
  brokenLinkCount: 0,
  jsRendered: false,
  viewportPresent: true,
  htmlLang: "en",
  jsonLdInvalid: 0,
  organizationSchemaIncomplete: false,
  openGraphMissing: 0,
  twitterCardIncomplete: false,
  mixedContentCount: 0,
  missingSecurityHeaders: 0,
  sitemapSeeded: false,
  internalInboundLinks: 2,
  ...overrides,
});

test("a complete HTML page has no Site Audit findings", () => {
  assert.deepEqual(evaluateAuditPageRules(healthyFacts()), []);
});

test("JS shell remains informational and suppresses raw-DOM content claims", () => {
  const issues = evaluateAuditPageRules(healthyFacts({ jsRendered: true, wordCount: 0, h1Count: 0 }));
  assert.equal(issues.includes("js_rendered"), true);
  assert.equal(issues.includes("thin_content"), false);
  assert.equal(issues.includes("h1_missing"), false);
});

test("new technical checks are evaluated in the same registry", () => {
  const issues = evaluateAuditPageRules(healthyFacts({
    isRoot: true,
    redirectHops: 3,
    robotsConflict: true,
    canonical: null,
    viewportPresent: false,
    jsonLdInvalid: 1,
    mixedContentCount: 2,
    missingSecurityHeaders: 4,
  }));
  for (const expected of ["redirect_chain", "robots_conflict", "canonical_missing", "viewport_missing", "jsonld_invalid", "mixed_content", "security_headers_missing"]) {
    assert.equal(issues.includes(expected), true, expected);
  }
});

test("HTML extraction handles attribute order, JSON-LD and social metadata deterministically", () => {
  const html = `<!doctype html><html lang="en"><head>
    <title>Example</title>
    <meta content="A description" name="description">
    <meta content="width=device-width" name="viewport">
    <meta content="Open graph title" property="og:title">
    <meta property="og:description" content="Open graph description">
    <meta property="og:image" content="https://example.com/cover.jpg">
    <meta name="twitter:card" content="summary_large_image">
    <script type="application/ld+json">{"@type":"Organization","name":"Example"}</script>
    <script type="application/ld+json">{not valid}</script>
  </head><body><h1>Example</h1><img src="http://cdn.example.com/image.jpg"></body></html>`;
  const signals = extractAuditHtml(html);
  assert.equal(signals.metaDesc, "A description");
  assert.equal(signals.viewportPresent, true);
  assert.equal(signals.htmlLang, "en");
  assert.equal(signals.jsonLdCount, 2);
  assert.equal(signals.jsonLdInvalid, 1);
  assert.equal(signals.organizationSchemaIncomplete, true);
  assert.deepEqual(signals.openGraphMissing, []);
  assert.equal(signals.twitterCardIncomplete, true);
  assert.deepEqual(signals.mixedContentUrls, ["http://cdn.example.com/image.jpg"]);
});

test("robots and security checks distinguish conflict from absence", () => {
  assert.equal(robotsDirectivesConflict("index, noindex, follow"), true);
  assert.equal(robotsDirectivesConflict("noindex, nofollow"), false);
  assert.deepEqual(missingSecurityHeaders({
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "strict-transport-security": "max-age=31536000",
  }, true), []);
});

test("only a sitemap-seeded page without internal inbound links is an orphan candidate", () => {
  assert.equal(evaluateAuditPageRules(healthyFacts({ sitemapSeeded: true, internalInboundLinks: 0 })).includes("orphan_sitemap_page"), true);
  assert.equal(evaluateAuditPageRules(healthyFacts({ sitemapSeeded: false, internalInboundLinks: 0 })).includes("orphan_sitemap_page"), false);
});
