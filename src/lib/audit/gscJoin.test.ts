import test from "node:test";
import assert from "node:assert/strict";
import { canonicalOverride, findGscOrphans, gscPageKey, latestInspections, GSC_INSPECTION_MAX_AGE_DAYS, GSC_ORPHAN_MIN_IMPRESSIONS, type InspectionRow } from "./gscJoin";
import { AUDIT_RULE_BY_ID, evaluateAuditPageRules, type AuditPageFacts } from "./rules";

const NOW = Date.parse("2026-10-27T10:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000);

test("page key folds protocol, www, trailing slash and fragment; keeps the query", () => {
  assert.equal(gscPageKey("http://www.x.gr/tours/"), "x.gr/tours");
  assert.equal(gscPageKey("https://x.gr/tours#prices"), "x.gr/tours");
  assert.equal(gscPageKey("https://x.gr/?lang=el"), "x.gr/?lang=el");
  assert.equal(gscPageKey("ftp://x.gr/a"), "");
  assert.equal(gscPageKey("not a url"), "");
});

test("the freshest inspection wins across both stores; stale and dateless rows are dropped", () => {
  const rows: InspectionRow[] = [
    { url: "https://x.gr/a", status: "Submitted and indexed", checkedAt: daysAgo(10) },
    { url: "https://x.gr/a/", status: "Crawled - currently not indexed", checkedAt: daysAgo(2) },
    { url: "https://x.gr/b", status: "Crawled - currently not indexed", checkedAt: daysAgo(GSC_INSPECTION_MAX_AGE_DAYS + 1) },
    { url: "https://x.gr/c", status: "Submitted and indexed", checkedAt: null },
    { url: "https://x.gr/d", status: "Something new from Google", checkedAt: daysAgo(1) },
  ];
  const map = latestInspections(rows, NOW);
  assert.deepEqual(map.get("x.gr/a"), { indexed: false, status: "Crawled - currently not indexed", checkedOn: "2026-10-25", googleCanonical: null });
  assert.equal(map.has("x.gr/b"), false);
  assert.equal(map.has("x.gr/c"), false);
  assert.equal(map.get("x.gr/d")?.indexed, null, "an unknown status is unknown, not 'not indexed'");
});

test("on a tie the row that knows Google's canonical is kept", () => {
  const at = daysAgo(3);
  const map = latestInspections([
    { url: "https://x.gr/a", status: "Duplicate, Google chose different canonical than user", checkedAt: at, googleCanonical: "https://x.gr/b" },
    { url: "https://x.gr/a", status: "Duplicate, Google chose different canonical than user", checkedAt: at },
  ], NOW);
  assert.equal(map.get("x.gr/a")?.googleCanonical, "https://x.gr/b");
});

test("Google's canonical counts only when it differs from the declared one (or the page itself)", () => {
  const state = (googleCanonical: string | null) => ({ indexed: false, status: "x", checkedOn: "2026-10-25", googleCanonical });
  assert.equal(canonicalOverride("https://x.gr/a", null, state("https://x.gr/b")), "https://x.gr/b");
  assert.equal(canonicalOverride("https://x.gr/a", "https://x.gr/b", state("https://x.gr/b/")), null, "Google agrees with the declared canonical");
  assert.equal(canonicalOverride("https://x.gr/a", "https://x.gr/a", state("http://www.x.gr/a/")), null, "same page, different spelling");
  assert.equal(canonicalOverride("https://x.gr/a", "https://x.gr/a", state("https://x.gr/c")), "https://x.gr/c");
  assert.equal(canonicalOverride("https://x.gr/a", null, state(null)), null);
  assert.equal(canonicalOverride("https://x.gr/a", null, null), null);
});

test("orphans: same host only, crawled spellings excluded, variants merged, floor applied", () => {
  const gsc = new Map([
    ["https://x.gr/", { impressions: 900, clicks: 40 }],
    ["https://x.gr/old-tour", { impressions: 300, clicks: 5 }],
    ["http://www.x.gr/old-tour/", { impressions: 50, clicks: 1 }],
    ["https://x.gr/old-tour#faq", { impressions: 10, clicks: 0 }],
    ["https://x.gr/rare", { impressions: GSC_ORPHAN_MIN_IMPRESSIONS - 1, clicks: 0 }],
    ["https://blog.x.gr/post", { impressions: 500, clicks: 9 }],
    ["https://x.gr/wp-admin/x", { impressions: 80, clicks: 0 }],
    ["https://x.gr/brochure.pdf", { impressions: 70, clicks: 2 }],
    ["https://x.gr/landing", { impressions: 25, clicks: 0 }],
  ]);
  const result = findGscOrphans(gsc, ["https://www.x.gr/"], "https://x.gr/", {
    partial: false,
    skip: url => url.includes("/wp-admin/") || url.endsWith(".pdf"),
  });
  assert.equal(result.count, 2);
  assert.equal(result.partial, false);
  assert.deepEqual(result.sample, [
    { url: "https://x.gr/old-tour", impressions: 360, clicks: 6 },
    { url: "https://x.gr/landing", impressions: 25, clicks: 0 },
  ]);
});

test("orphans carry the partial flag when the crawl hit its limit", () => {
  const result = findGscOrphans(new Map([["https://x.gr/a", { impressions: 100, clicks: 1 }]]), [], "https://x.gr/", { partial: true });
  assert.equal(result.count, 1);
  assert.equal(result.partial, true);
});

// ─── rules ───────────────────────────────────────────────────────────────────

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
const notIndexed = { indexed: false, status: "Crawled - currently not indexed", checkedOn: "2026-10-25" };

test("gsc_not_indexed fires on an indexable page Google reports as out of the index", () => {
  assert.deepEqual(evaluateAuditPageRules(facts({ gscInspection: notIndexed })), ["gsc_not_indexed"]);
  assert.deepEqual(evaluateAuditPageRules(facts({ gscInspection: { ...notIndexed, indexed: true } })), []);
  assert.deepEqual(evaluateAuditPageRules(facts({ gscInspection: { ...notIndexed, indexed: null } })), []);
  assert.deepEqual(evaluateAuditPageRules(facts({ gscInspection: null })), []);
});

test("pages that ask to stay out of the index are expected to be out of it", () => {
  assert.equal(evaluateAuditPageRules(facts({ gscInspection: notIndexed, robots: "noindex" })).includes("gsc_not_indexed"), false);
  assert.equal(evaluateAuditPageRules(facts({ gscInspection: notIndexed, canonicalMismatch: true })).includes("gsc_not_indexed"), false);
  assert.equal(evaluateAuditPageRules(facts({ gscInspection: notIndexed, httpStatus: 404 })).includes("gsc_not_indexed"), false);
});

test("gsc_canonical_other fires on Google's override, not on its absence", () => {
  assert.deepEqual(evaluateAuditPageRules(facts({ gscCanonicalOther: "https://x.gr/b" })), ["gsc_canonical_other"]);
  assert.deepEqual(evaluateAuditPageRules(facts({ gscCanonicalOther: null })), []);
});

test("both Google-verdict rules inform and never move the score", () => {
  for (const id of ["gsc_not_indexed", "gsc_canonical_other"]) {
    assert.equal(AUDIT_RULE_BY_ID.get(id)?.affectsScore, false, id);
    assert.equal(AUDIT_RULE_BY_ID.get(id)?.severity, "warning", id);
  }
});
