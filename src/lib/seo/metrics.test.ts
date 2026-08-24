import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateUnits, perRowCost, AHREFS_UNIT_FLOOR, gatewayStatusFromError,
  estimateProfileUnits, refdomainsPageParams,
} from "./metrics";

// The estimate is the number the cap is charged and the user is quoted, so these tests pin the
// three ways it can lie: suffix variants falling through to the 1-unit default, filter columns
// escaping the bill, and the floor quietly disappearing.

test("_prev and _merged suffixes bill at the base column's tier", () => {
  // Explicitly listed variant…
  assert.equal(perRowCost("site-explorer/organic-keywords", ["volume_prev"]), 10);
  // …and one the per-endpoint table never named — stripping must find `traffic` (10) anyway.
  assert.equal(perRowCost("site-explorer/all-backlinks", ["traffic_merged"]), 10);
  // Suffix stripping must not touch names that merely end similarly.
  assert.equal(perRowCost("site-explorer/all-backlinks", ["refdomains_source_domain"]), 5);
});

test("fields used in where/order_by are billed even when not selected", () => {
  const without = estimateUnits("site-explorer/organic-keywords", ["keyword"], 100);
  const withFilter = estimateUnits("site-explorer/organic-keywords", ["keyword"], 100, ["keyword_difficulty"]);
  assert.equal(withFilter - without, 10 * 100);
});

test("a field named in both select and filters is billed once", () => {
  const once = estimateUnits("keywords-explorer/overview", ["volume"], 100);
  const namedTwice = estimateUnits("keywords-explorer/overview", ["volume"], 100, ["volume"]);
  assert.equal(namedTwice, once);
});

test("the 50-unit floor applies to cheap and empty requests", () => {
  assert.equal(estimateUnits("site-explorer/refdomains", ["domain"], 1), AHREFS_UNIT_FLOOR);
  // Zero rows still reserve one row's worth — the floor dominates either way.
  assert.equal(estimateUnits("site-explorer/refdomains", ["domain"], 0), AHREFS_UNIT_FLOOR);
});

test("global tiers price endpoints the per-endpoint table never listed", () => {
  // The backlink export fields are all 1-unit; the tempting neighbours are not.
  assert.equal(perRowCost("site-explorer/all-backlinks", ["url_from", "anchor", "is_dofollow"]), 3);
  assert.equal(perRowCost("site-explorer/all-backlinks", ["traffic"]), 10);
  assert.equal(perRowCost("site-explorer/all-backlinks", ["traffic_domain"]), 10);
  assert.equal(perRowCost("site-explorer/all-backlinks", ["class_c"]), 5);
  assert.equal(perRowCost("site-explorer/refdomains", ["dofollow_refdomains"]), 5);
  // AI-citation columns carry the 15-unit tier on any endpoint.
  assert.equal(perRowCost("site-explorer/anchor-text", ["chatgpt", "perplexity"]), 30);
});

test("gatewayStatusFromError extracts the HTTP status from module error strings", () => {
  assert.equal(gatewayStatusFromError("ahrefs 502: upstream data path unavailable"), 502);
  assert.equal(gatewayStatusFromError("semrush 401: ERROR 2026 BAD KEY"), 401);
  assert.equal(gatewayStatusFromError("no_key"), null);
  assert.equal(gatewayStatusFromError(undefined), null);
});

// The profile pull has no row ceiling any more, so the paging params and their price are what
// keeps a "pull everything" refresh honest. The field list below is restated on purpose: it is
// a price-affecting contract (all 1-unit columns), and a test that spells it out fails loudly
// the day someone adds a 10-unit column to it.
const REFDOMAIN_FIELDS = ["domain", "domain_rating", "links_to_target", "dofollow_links", "first_seen"];

test("refdomains pages: first page is DR-desc, offset pages carry offset, keyset pages flip to cursor order", () => {
  const first = refdomainsPageParams({ target: "site.com", limit: 1000 });
  assert.equal(first.get("order_by"), "domain_rating:desc");
  assert.ok(!first.has("offset"));
  assert.ok(!first.has("where"));

  const next = refdomainsPageParams({ target: "site.com", limit: 1000, offset: 1000 });
  assert.equal(next.get("offset"), "1000");
  assert.equal(next.get("order_by"), "domain_rating:desc");

  const cursor = refdomainsPageParams({ target: "site.com", limit: 1000, afterDomain: "zeta.com" });
  assert.equal(cursor.get("order_by"), "domain:asc");
  assert.ok(!cursor.has("offset"));
  assert.deepEqual(JSON.parse(cursor.get("where")!), { and: [{ field: "domain", is: ["gt", "zeta.com"] }] });
});

test("refdomains DR filter rides along in both paging modes as the same billed field", () => {
  const drOnly = refdomainsPageParams({ target: "site.com", limit: 1000, minDr: 30 });
  assert.deepEqual(JSON.parse(drOnly.get("where")!), { and: [{ field: "domain_rating", is: ["gte", 30] }] });

  const keysetDr = refdomainsPageParams({ target: "site.com", limit: 1000, afterDomain: "a.com", minDr: 30 });
  const conds = JSON.parse(keysetDr.get("where")!).and;
  assert.equal(conds.length, 2);
  assert.deepEqual(conds[0], { field: "domain", is: ["gt", "a.com"] });
});

test("estimateProfileUnits prices the stats call, the full row set, and one floor of tail slack", () => {
  // 5 one-unit fields a row, so a full 1000-domain profile is 5000 units of rows.
  assert.equal(estimateUnits("site-explorer/refdomains", REFDOMAIN_FIELDS, 1000), 5000);
  assert.equal(estimateProfileUnits(1000), AHREFS_UNIT_FLOOR * 2 + 5000);
  // Zero domains still means three floored requests worst-case: stats, a one-row page, slack.
  assert.equal(estimateProfileUnits(0), AHREFS_UNIT_FLOOR * 3);
});
