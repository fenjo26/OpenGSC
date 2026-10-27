import test from "node:test";
import assert from "node:assert/strict";
import {
  hasNoindex, noindexAlertWorthy, noindexEvidence, noindexNeutralSetting, noindexReasons, summarizeNoindex,
  NOINDEX_GSC_MIN_IMPRESSIONS, type NoindexPageInput, type NoindexSignals,
} from "./noindex";
import { evaluateAuditPageRules, AUDIT_RULE_BY_ID, AUDIT_RULES, type AuditPageFacts } from "./rules";
import { computeHealthScore } from "./healthScore";

const quiet: NoindexSignals = { isRoot: false, inSitemap: false, gscImpressions: 0, gscClicks: 0, wasIndexableOn: null };

test("hasNoindex reads meta and header values, including the `none` shorthand", () => {
  assert.equal(hasNoindex("noindex, follow"), true);
  assert.equal(hasNoindex("googlebot: noindex"), true);
  assert.equal(hasNoindex("none"), true);
  assert.equal(hasNoindex("index, follow"), false);
  assert.equal(hasNoindex("noindexer"), false);
  assert.equal(hasNoindex("max-snippet:-1, none-of-this"), false);
  assert.equal(hasNoindex(""), false);
});

test("a closed page with nothing pointing the other way is intentional", () => {
  assert.deepEqual(noindexReasons(quiet), []);
  // GSC impressions below the floor are noise, not traffic.
  assert.deepEqual(noindexReasons({ ...quiet, gscImpressions: NOINDEX_GSC_MIN_IMPRESSIONS - 1, gscClicks: 1 }), []);
});

test("every reason fires on its own fact, strongest first", () => {
  assert.deepEqual(noindexReasons({ ...quiet, isRoot: true }), ["homepage"]);
  assert.deepEqual(noindexReasons({ ...quiet, inSitemap: true }), ["sitemap"]);
  assert.deepEqual(noindexReasons({ ...quiet, gscImpressions: NOINDEX_GSC_MIN_IMPRESSIONS }), ["gsc_traffic"]);
  assert.deepEqual(noindexReasons({ ...quiet, wasIndexableOn: "2026-10-20" }), ["was_indexable"]);
  assert.deepEqual(
    noindexReasons({ isRoot: true, inSitemap: true, gscImpressions: 500, gscClicks: 9, wasIndexableOn: "2026-10-20" }),
    ["homepage", "was_indexable", "gsc_traffic", "sitemap"],
  );
});

test("evidence names the directive and every reason in plain words", () => {
  const s: NoindexSignals = { ...quiet, inSitemap: true, gscImpressions: 340, gscClicks: 12, wasIndexableOn: "2026-10-20" };
  assert.equal(
    noindexEvidence(noindexReasons(s), s, "noindex, follow"),
    "noindex, follow · indexable in the audit of 2026-10-20 · 340 impressions, 12 clicks in GSC over 28 d · listed in the sitemap",
  );
});

const row = (url: string, extra: Partial<NoindexPageInput> = {}): NoindexPageInput =>
  ({ url, hasHtml: true, httpStatus: 200, noindex: false, reasons: [], ...extra });

test("summary splits closed pages and ranks the sample by evidence", () => {
  const sum = summarizeNoindex([
    row("https://x.gr/"),
    row("https://x.gr/about"),
    row("https://x.gr/contact"),
    row("https://x.gr/blog"),
    row("https://x.gr/cart", { noindex: true }),
    row("https://x.gr/login", { noindex: true }),
    row("https://x.gr/tours", { noindex: true, reasons: ["sitemap"] }),
    row("https://x.gr/transfer", { noindex: true, reasons: ["was_indexable", "gsc_traffic"] }),
    row("https://x.gr/404", { httpStatus: 404, noindex: true }),
    row("https://x.gr/feed", { hasHtml: false }),
  ]);
  assert.equal(sum.htmlPages, 8);
  assert.equal(sum.pages, 4);
  assert.equal(sum.suspicious, 2);
  assert.equal(sum.intentional, 2);
  assert.equal(sum.homepage, false);
  assert.equal(sum.sitewide, false);
  assert.deepEqual(sum.sample.map(s => s.url), ["https://x.gr/transfer", "https://x.gr/tours"]);
});

test("a closed homepage, or nearly every page closed, is site-wide", () => {
  assert.equal(summarizeNoindex([row("https://x.gr/", { noindex: true, reasons: ["homepage"] }), row("https://x.gr/a")]).sitewide, true);
  const most = Array.from({ length: 10 }, (_, i) => row(`https://x.gr/p${i}`, { noindex: i < 8 }));
  assert.equal(summarizeNoindex(most).sitewide, true);
  const half = Array.from({ length: 10 }, (_, i) => row(`https://x.gr/p${i}`, { noindex: i < 5 }));
  assert.equal(summarizeNoindex(half).sitewide, false, "a tag-heavy blog is not a closed site");
  const tiny = Array.from({ length: 4 }, (_, i) => row(`https://x.gr/p${i}`, { noindex: true }));
  assert.equal(summarizeNoindex(tiny).sitewide, false, "too few pages to call it site-wide");
});

test("alerts fire on events, not on standing state, and never in neutral mode", () => {
  const sample = (reasons: NoindexPageInput["reasons"]) => ({ sitewide: false, neutral: false, sample: [{ url: "https://x.gr/a", reasons: [...reasons] }] });
  assert.equal(noindexAlertWorthy(sample(["was_indexable"])), true);
  assert.equal(noindexAlertWorthy(sample(["homepage"])), true);
  assert.equal(noindexAlertWorthy(sample(["sitemap", "gsc_traffic"])), false);
  assert.equal(noindexAlertWorthy({ sitewide: true, neutral: false, sample: [] }), true);
  assert.equal(noindexAlertWorthy({ sitewide: true, neutral: true, sample: [] }), false);
  assert.equal(noindexAlertWorthy(undefined), false);
});

test("the neutral switch is read leniently from Site.auditSettings", () => {
  assert.equal(noindexNeutralSetting(JSON.stringify({ mode: "inherit", noindexNeutral: true })), true);
  assert.equal(noindexNeutralSetting(JSON.stringify({ mode: "cron", cron: "0 3 * * 1" })), false);
  assert.equal(noindexNeutralSetting("{garbage"), false);
  assert.equal(noindexNeutralSetting(null), false);
});

// ─── rules: the plain noindex finding is free, the suspicious one is critical ─────

const facts = (overrides: Partial<AuditPageFacts> = {}): AuditPageFacts => ({
  hasHtml: true, isRoot: false, isHttps: true, httpStatus: 200, loadMs: 120, redirectHops: 0, redirectLoop: false,
  title: "x", titleDuplicate: true, metaDescription: "", robots: "noindex, follow", robotsConflict: false,
  canonical: null, canonicalInvalid: false, canonicalMismatch: false, h1Count: 0, h1Text: "", wordCount: 20,
  imagesNoAlt: 3, brokenLinkCount: 0, jsRendered: false, viewportPresent: true, viewportResponsive: true, htmlLang: "en",
  jsonLdInvalid: 0, organizationSchemaIncomplete: false, openGraphMissing: 2, twitterCardIncomplete: true,
  mixedContentCount: 0, missingSecurityHeaders: 0, sitemapSeeded: false, internalInboundLinks: 1,
  ...overrides,
});

test("an intentionally closed page shows only the free noindex finding", () => {
  const issues = evaluateAuditPageRules(facts({ noindexIntentional: true, noindexReasons: [] }));
  assert.deepEqual(issues, ["noindex"]);
  assert.equal(AUDIT_RULE_BY_ID.get("noindex")!.severity, "info");
  assert.equal(AUDIT_RULE_BY_ID.get("noindex")!.affectsScore, false);
});

test("a suspicious page is critical and keeps its content findings", () => {
  const issues = evaluateAuditPageRules(facts({ noindexIntentional: false, noindexReasons: ["sitemap"] }));
  assert.ok(issues.includes("noindex_suspicious"));
  assert.ok(!issues.includes("noindex"), "exactly one of the two noindex findings");
  assert.ok(issues.includes("title_too_short") && issues.includes("h1_missing") && issues.includes("title_duplicate"));
  assert.equal(AUDIT_RULE_BY_ID.get("noindex_suspicious")!.severity, "critical");
});

test("status and link findings still fire on an intentionally closed page", () => {
  const issues = evaluateAuditPageRules(facts({ noindexIntentional: true, noindexReasons: [], brokenLinkCount: 2, loadMs: 5000 }));
  assert.ok(issues.includes("broken_links") && issues.includes("slow_response"));
  for (const id of ["http_error", "fetch_failed", "redirect", "redirect_chain", "redirect_loop", "broken_links", "internal_redirect_links", "mixed_content", "noindex", "noindex_suspicious", "robots_conflict"]) {
    assert.notEqual(AUDIT_RULE_BY_ID.get(id)?.indexableOnly, true, `${id} must not be skipped on closed pages`);
  }
});

test("the single-page scanner (no triage facts) keeps every rule as before", () => {
  const issues = evaluateAuditPageRules(facts());
  assert.ok(issues.includes("noindex") && issues.includes("title_too_short") && issues.includes("h1_missing"));
});

test("every indexableOnly rule is a content or metadata kind of check", () => {
  for (const rule of AUDIT_RULES.filter(r => r.indexableOnly)) {
    assert.ok(["metadata", "content", "rendering", "performance", "links"].includes(rule.category), rule.id);
  }
});

// ─── health score: closed-on-purpose pages leave the average ─────────────────

test("intentionally closed pages no longer drag the score to zero", () => {
  const rows = [
    { url: "https://x.gr/", httpStatus: 200, issues: [] as string[] },
    { url: "https://x.gr/a", httpStatus: 200, issues: ["images_no_alt"] },
    ...Array.from({ length: 20 }, (_, i) => ({ url: `https://x.gr/tag/${i}`, httpStatus: 200, issues: ["noindex"], intentionalNoindex: true })),
  ];
  const result = computeHealthScore(rows);
  assert.equal(result.noindexExcluded, 20);
  assert.equal(result.scoredPages, 2);
  assert.equal(result.healthScore, Math.round((100 + 92) / 2));
});

test("a closed page with its own scored finding stays in the average", () => {
  const rows = [
    { url: "https://x.gr/", httpStatus: 200, issues: [] as string[] },
    { url: "https://x.gr/tag/1", httpStatus: 200, issues: ["noindex", "broken_links"], intentionalNoindex: true },
  ];
  const result = computeHealthScore(rows);
  assert.equal(result.noindexExcluded, 0);
  assert.equal(result.healthScore, 50);
});

test("a suspicious noindex scores 0 — unless the site made noindex neutral", () => {
  const rows = [
    { url: "https://x.gr/", httpStatus: 200, issues: ["noindex_suspicious"] },
    { url: "https://x.gr/a", httpStatus: 200, issues: [] as string[] },
  ];
  assert.equal(computeHealthScore(rows).healthScore, 50);
  const neutral = computeHealthScore(
    rows.map(r => ({ ...r, intentionalNoindex: r.issues.length > 0 })),
    { ignoreRuleIds: new Set(["noindex_suspicious"]) },
  );
  assert.equal(neutral.healthScore, 100);
  assert.equal(neutral.noindexExcluded, 1);
  assert.equal(neutral.pagesWithScoredIssues, 0);
});
