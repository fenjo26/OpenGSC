import test from "node:test";
import assert from "node:assert/strict";
import { extractAuditHtml, missingSecurityHeaders, robotsDirectivesConflict, viewportIsResponsive } from "./pageSignals";
import { evaluateAuditPageRules, AUDIT_RULE_BY_ID, AUDIT_RULES, type AuditPageFacts } from "./rules";
import { META_LIMITS } from "@/lib/seo/metaLimits";

const healthyFacts = (overrides: Partial<AuditPageFacts> = {}): AuditPageFacts => ({
  hasHtml: true,
  isRoot: false,
  isHttps: true,
  httpStatus: 200,
  loadMs: 120,
  redirectHops: 0,
  redirectLoop: false,
  title: "A useful page title long enough to pass every metadata check",
  titleDuplicate: false,
  metaDescription: "A concise description of this useful page, long enough to sit inside the healthy 150 to 165 character band without ever triggering a metadata length rule.",
  robots: "index, follow",
  robotsConflict: false,
  canonical: "https://example.com/page",
  canonicalInvalid: false,
  canonicalMismatch: false,
  h1Count: 1,
  h1Text: "A useful page title long enough to pass every metadata check",
  wordCount: 500,
  imagesNoAlt: 0,
  brokenLinkCount: 0,
  jsRendered: false,
  viewportPresent: true,
  viewportResponsive: true,
  htmlLang: "en",
  hreflangInvalid: [],
  hreflangNoReturn: [],
  hreflangSelfMissing: false,
  hreflangTargetBad: [],
  hreflangXDefaultMissing: false,
  langHreflangMismatch: "",
  internalRedirectLinks: [],
  imagesNoDimensions: 0,
  htmlBytes: 40_000,
  mainQuery: null,
  cwvPoor: null,
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

test("too-short title and description are flagged, and empty tags stay a missing-tag problem alone", () => {
  // Boundaries mirror the too-long rules (65 / 165): the healthy bands are 50–65 and 150–165.
  assert.equal(evaluateAuditPageRules(healthyFacts({ title: "x".repeat(49) })).includes("title_too_short"), true);
  assert.equal(evaluateAuditPageRules(healthyFacts({ title: "x".repeat(50) })).includes("title_too_short"), false);
  assert.equal(evaluateAuditPageRules(healthyFacts({ metaDescription: "x".repeat(149) })).includes("description_too_short"), true);
  assert.equal(evaluateAuditPageRules(healthyFacts({ metaDescription: "x".repeat(150) })).includes("description_too_short"), false);
  const noTitle = evaluateAuditPageRules(healthyFacts({ title: "" }));
  assert.equal(noTitle.includes("title_missing"), true);
  assert.equal(noTitle.includes("title_too_short"), false);
  const noDescription = evaluateAuditPageRules(healthyFacts({ metaDescription: "" }));
  assert.equal(noDescription.includes("description_missing"), true);
  assert.equal(noDescription.includes("description_too_short"), false);
});

test("meta length thresholds come from META_LIMITS, not literals", () => {
  // The generator (T1) aims inside the target band; the audit flags outside the audit band.
  // One source of truth — a generator change must never drift from the audit again.
  const rules = new Map(AUDIT_RULES.map(rule => [rule.id, rule]));
  const tooLongTitle = rules.get("title_too_long")!;
  const tooShortTitle = rules.get("title_too_short")!;
  const tooLongDesc = rules.get("description_too_long")!;
  const tooShortDesc = rules.get("description_too_short")!;
  assert.equal(tooLongTitle.evaluate(healthyFacts({ title: "x".repeat(META_LIMITS.title.auditMax) })), false);
  assert.equal(tooLongTitle.evaluate(healthyFacts({ title: "x".repeat(META_LIMITS.title.auditMax + 1) })), true);
  assert.equal(tooShortTitle.evaluate(healthyFacts({ title: "x".repeat(META_LIMITS.title.auditMin) })), false);
  assert.equal(tooShortTitle.evaluate(healthyFacts({ title: "x".repeat(META_LIMITS.title.auditMin - 1) })), true);
  assert.equal(tooLongDesc.evaluate(healthyFacts({ metaDescription: "x".repeat(META_LIMITS.description.auditMax) })), false);
  assert.equal(tooLongDesc.evaluate(healthyFacts({ metaDescription: "x".repeat(META_LIMITS.description.auditMax + 1) })), true);
  assert.equal(tooShortDesc.evaluate(healthyFacts({ metaDescription: "x".repeat(META_LIMITS.description.auditMin) })), false);
  assert.equal(tooShortDesc.evaluate(healthyFacts({ metaDescription: "x".repeat(META_LIMITS.description.auditMin - 1) })), true);
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
  assert.equal(signals.h1Text, "Example");
  assert.deepEqual(signals.hreflang, []);
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

// ─── wave-oct rules: each fires on its own fact and stays silent on the neighbours ──

test("each new rule fires on its fact and not on a healthy page", () => {
  const cases: [string, Partial<AuditPageFacts>][] = [
    ["hreflang_invalid", { hreflangInvalid: ["en-UK: not a valid hreflang code"] }],
    ["hreflang_no_return", { hreflangNoReturn: ["/ ← en: no link back"] }],
    ["hreflang_self_missing", { hreflangSelfMissing: true }],
    ["hreflang_target_bad", { hreflangTargetBad: ["en → /en/: redirect 301"] }],
    ["hreflang_x_default_missing", { hreflangXDefaultMissing: true }],
    ["lang_hreflang_mismatch", { langHreflangMismatch: 'lang="fr" vs hreflang "en"' }],
    ["viewport_not_responsive", { viewportResponsive: false }],
    ["images_no_dimensions", { imagesNoDimensions: 3 }],
    ["internal_redirect_links", { internalRedirectLinks: ["https://example.com/old/"] }],
    ["html_too_large", { htmlBytes: 2 * 1024 * 1024 + 1 }],
    ["title_query_mismatch", { mainQuery: { query: "casino en ligne", impressions: 540 }, title: "Jeux de hasard et paris sportifs pour les joueurs français", h1Text: "Nos jeux" }],
    ["cwv_poor", { cwvPoor: "LCP 4.3 s (field)" }],
  ];
  for (const [code, patch] of cases) {
    const issues = evaluateAuditPageRules(healthyFacts(patch));
    assert.equal(issues.includes(code), true, `${code} must fire on its fact`);
    // Exactly the one rule fires — the patch must not trip unrelated checks.
    assert.deepEqual(issues, [code], `${code} fired alone`);
  }
});

test("boundary facts of the new rules stay silent", () => {
  assert.equal(evaluateAuditPageRules(healthyFacts({ htmlBytes: 2 * 1024 * 1024 })).includes("html_too_large"), false);
  assert.equal(evaluateAuditPageRules(healthyFacts({ imagesNoDimensions: 0 })).includes("images_no_dimensions"), false);
  // A page with a viewport but no main query is silent: no GSC data is no finding.
  assert.equal(evaluateAuditPageRules(healthyFacts({ title: "Nothing alike", h1Text: "Whatever", mainQuery: null })).includes("title_query_mismatch"), false);
  // Title or H1 carrying ANY significant token keeps the page aligned.
  assert.equal(evaluateAuditPageRules(healthyFacts({
    mainQuery: { query: "casino en ligne", impressions: 540 },
    title: "Best casinos 2026", h1Text: "Nos jeux",
  })).includes("title_query_mismatch"), false);
  // Viewport missing is viewport_missing's business, not viewport_not_responsive.
  assert.equal(evaluateAuditPageRules(healthyFacts({ viewportPresent: false, viewportResponsive: false })).includes("viewport_not_responsive"), false);
});

test("hint-level rules never affect the score", () => {
  // The README's hard rule: a heuristic may inform, never lower the health score.
  for (const id of ["title_query_mismatch", "cwv_poor", "hreflang_self_missing", "hreflang_x_default_missing", "lang_hreflang_mismatch", "images_no_dimensions", "html_too_large"]) {
    const rule = AUDIT_RULE_BY_ID.get(id);
    assert.ok(rule, id);
    assert.equal(rule!.affectsScore, false, `${id} must not affect the score`);
  }
  // The hreflang warnings that state verifiable facts do affect it.
  for (const id of ["hreflang_invalid", "hreflang_no_return", "hreflang_target_bad", "viewport_not_responsive", "internal_redirect_links"]) {
    const rule = AUDIT_RULE_BY_ID.get(id);
    assert.notEqual(rule!.affectsScore, false, `${id} must affect the score`);
  }
});

test("viewport responsiveness: device-width required, zoom blocking rejected", () => {
  assert.equal(viewportIsResponsive("width=device-width, initial-scale=1"), true);
  assert.equal(viewportIsResponsive("width=1200"), false);
  assert.equal(viewportIsResponsive("width=device-width, user-scalable=no"), false);
  assert.equal(viewportIsResponsive("width=device-width, maximum-scale=1"), false);
  assert.equal(viewportIsResponsive("width=device-width, maximum-scale=2"), true);
});

test("image dimension extraction catches missing size pairs and exempts small icons", () => {
  const html = `<body>
    <img src="/content/photo.jpg">
    <img src="/a.jpg" width="640" height="480">
    <img src="/b.jpg" style="width:100px;height:50px">
    <img src="data:image/png;base64,AAAA">
    <img src="/icon.svg" width="16">
    <img src="/big.svg">
  </body>`;
  const signals = extractAuditHtml(html);
  // photo.jpg (nothing), big.svg (no size at all) — the two real risks.
  assert.equal(signals.imagesNoDimensions, 2);
});
