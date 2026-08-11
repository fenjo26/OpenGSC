import test from "node:test";
import assert from "node:assert/strict";
import { buildRelatedIntentGroups, inferPageRole, intentTokens, siteBrandTerms, type RelatedIntentMetric } from "./relatedIntent";

const row = (query: string, url: string, date: string, impressions: number, position: number): RelatedIntentMetric => ({
  query, url, date, impressions, position, clicks: Math.round(impressions * 0.08), ctr: 0.08,
});

test("Related Intent groups different queries only when ranking evidence also supports a conflict", () => {
  const metrics = [
    row("best crm software", "https://example.com/blog/best-crm", "2026-08-01", 80, 7),
    row("best crm software", "https://example.com/crm", "2026-08-01", 50, 9),
    row("top crm tools", "https://example.com/blog/best-crm", "2026-08-01", 45, 8),
    row("top crm tools", "https://example.com/crm", "2026-08-01", 65, 6),
  ];
  const groups = buildRelatedIntentGroups(metrics, { siteId: "site-1", siteName: "example.com", minImpressions: 30 });
  assert.equal(groups.length, 1);
  assert.deepEqual(new Set(groups[0].queries), new Set(["best crm software", "top crm tools"]));
  assert.equal(groups[0].pages.length, 2);
  assert.equal(groups[0].intent, "commercial");
  assert.equal(groups[0].recommendation, "differentiate");
  assert.equal(groups[0].evidence.rankingUrlOverlap, 100);
});

test("a shared homepage alone does not join unrelated queries", () => {
  const metrics = [
    row("weather tomorrow", "https://example.com/", "2026-08-01", 100, 4),
    row("accounting calculator", "https://example.com/", "2026-08-01", 100, 4),
  ];
  assert.deepEqual(buildRelatedIntentGroups(metrics, { siteId: "site-1", siteName: "example.com" }), []);
});

test("brand filtering, multilingual tokens and page roles stay deterministic", () => {
  assert.deepEqual(siteBrandTerms("sc-domain:www.example.co.uk"), ["example"]);
  assert.equal(intentTokens("Как выбрать CRM для бизнеса").includes("crm"), true);
  assert.equal(intentTokens("最佳搜索工具").some(token => token.length === 2), true);
  assert.equal(inferPageRole("https://example.com/blog/crm-guide", ["crm guide"]), "guide");

  const branded = [
    row("example crm", "https://example.com/crm", "2026-08-01", 80, 5),
    row("example crm software", "https://example.com/software", "2026-08-01", 60, 6),
  ];
  assert.deepEqual(buildRelatedIntentGroups(branded, { siteId: "site-1", siteName: "example.com", brandTerms: ["example"] }), []);
});

test("dominant-page changes are exposed as flip-flop evidence", () => {
  const metrics = [
    row("crm comparison", "https://example.com/a", "2026-08-01", 80, 5),
    row("crm comparison", "https://example.com/b", "2026-08-01", 20, 9),
    row("crm comparisons", "https://example.com/a", "2026-08-01", 50, 6),
    row("crm comparisons", "https://example.com/b", "2026-08-01", 30, 8),
    row("crm comparison", "https://example.com/a", "2026-08-02", 10, 10),
    row("crm comparison", "https://example.com/b", "2026-08-02", 90, 4),
    row("crm comparisons", "https://example.com/a", "2026-08-02", 20, 9),
    row("crm comparisons", "https://example.com/b", "2026-08-02", 70, 5),
  ];
  const [group] = buildRelatedIntentGroups(metrics, { siteId: "site-1", siteName: "example.com" });
  assert.ok(group);
  assert.equal(group.evidence.flipFlops >= 2, true);
});
