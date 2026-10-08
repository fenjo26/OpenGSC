import assert from "node:assert/strict";
import test from "node:test";
import {
  parseKeyssoEnvelope, mapKeyssoDashboard, mapKeyssoRefDomain, keyssoRemainingCredits,
  keyssoErrorText, keyssoNextStep, KEYSSO_202_DELAYS_MS, KEYSSO_ERROR_RETRIES,
} from "./keyssoParse";
import {
  parseMetricsProvider, isKeywordCapable, domainUnits, estimateKeyssoProfileUnits,
  gatewayStatusFromError, UNIT_PRICE_USD, KEYSSO_REFDOMAIN_PAGE_SIZE,
} from "./metricsPricing";

// Fixtures are trimmed copies of live GroupBuySEO gateway answers captured 2026-10-08
// (probe-results.txt). The docs call their sample fields illustrative; these are not.

const LIVE_REFDOMAINS = {
  current_page: 1, per_page: 1, last_page: 119961, total: 119961,
  data: [{
    id: 410012818, did: 410012818, name: "twingreen.ru",
    outlinks_count: 274, outlinks_active_count: 223, outlinks_archive_count: 51,
    ips: 0, total_backips_count: 0, dr: 12, vis: 0,
    total_backdomains_count: 0, total_outdomains_count: 6, rel_type: [],
  }],
};

const LIVE_LIMITS = {
  analysis: 49999, apiRequest: 49994, users: 1, keysReportLimit: 49999, recordsPerReport: 49999,
  sitesCompare: 0, projects: 0, wordstat: 0, aiTracker: 0, monitoring: 0,
};

test("pagination envelope: total and last_page come from the wrapper, rows from data", () => {
  const env = parseKeyssoEnvelope(LIVE_REFDOMAINS);
  assert.equal(env.total, 119961);
  assert.equal(env.lastPage, 119961);
  assert.equal(env.page, 1);
  assert.equal(env.rows.length, 1);
});

test("a bare array is accepted without inventing a total", () => {
  const env = parseKeyssoEnvelope([{ name: "a.ru" }]);
  assert.equal(env.rows.length, 1);
  assert.equal(env.total, null);
});

test("refdomain row: name → domain, dr → dr, and outlinks_count is NOT the link count to the target", () => {
  const row = mapKeyssoRefDomain(LIVE_REFDOMAINS.data[0])!;
  assert.equal(row.refDomain, "twingreen.ru");
  assert.equal(row.dr, 12);
  // outlinks_count is the donor's own outbound total (the Majestic ExtBackLinks trap again).
  assert.equal(row.linksToTarget, null);
  // `ips` is a count of IPs, not an address.
  assert.equal(row.ip, "");
  // No follow flag in the row → unknown, never a fabricated dofollow.
  assert.equal(row.nofollow, null);
});

test("refdomain rows without a domain are dropped; IDN hosts survive", () => {
  assert.equal(mapKeyssoRefDomain({ dr: 5 }), null);
  assert.equal(mapKeyssoRefDomain({ name: "ulyanovsk.товарищ-грядка.рф" })!.refDomain, "ulyanovsk.товарищ-грядка.рф");
  assert.equal(mapKeyssoRefDomain({ name: "WWW.Example.RU" })!.refDomain, "example.ru");
});

test("domain_dashboard: dr is top-level; vis/it50 kept apart from Ahrefs-style traffic", () => {
  const d = mapKeyssoDashboard({ id: 1, name: "wildberries.ru", dr: 47, vis: 1413965, it50: 14661471, concs: [] });
  assert.equal(d.dr, 47);
  assert.equal(d.vis, 1413965);
  assert.equal(d.it50, 14661471);
});

test("limits: apiRequest is the remaining GBS balance, found flat or nested", () => {
  assert.equal(keyssoRemainingCredits(LIVE_LIMITS), 49994);
  assert.equal(keyssoRemainingCredits({ limits: { apiRequest: { remaining: 7 } } }), 7);
  assert.equal(keyssoRemainingCredits({ nothing: 1 }), null);
});

test("errors read as '<provider> <status>' so the shared diagnosis chain works", () => {
  const e = keyssoErrorText(402, '{"message":"Insufficient API credits"}');
  assert.equal(e, "keysso 402: Insufficient API credits");
  assert.equal(gatewayStatusFromError(e), 402);
  assert.equal(gatewayStatusFromError(keyssoErrorText(401, '{"message":"Unauthenticated"}')), 401);
});

test("202 is polled with its own back-off and gives up after the last delay", () => {
  KEYSSO_202_DELAYS_MS.forEach((ms, i) => {
    assert.deepEqual(keyssoNextStep(202, i, 0), { action: "wait", ms, kind: "pending" });
  });
  const end = keyssoNextStep(202, KEYSSO_202_DELAYS_MS.length, 0);
  assert.equal(end.action, "give_up");
});

test("429 and 5xx retry a bounded number of times; 4xx never retries", () => {
  assert.equal(keyssoNextStep(429, 0, 0).action, "wait");
  assert.equal(keyssoNextStep(503, 0, KEYSSO_ERROR_RETRIES - 1).action, "wait");
  assert.equal(keyssoNextStep(503, 0, KEYSSO_ERROR_RETRIES).action, "done");
  assert.equal(keyssoNextStep(402, 0, 0).action, "done");
  assert.equal(keyssoNextStep(200, 0, 0).action, "done");
});

test("provider wiring: parse, keyword guard, prices", () => {
  assert.equal(parseMetricsProvider("keysso"), "keysso");
  // Yandex keywords must never fill a Google keyword screen.
  assert.equal(isKeywordCapable("keysso"), false);
  assert.equal(isKeywordCapable("ahrefs"), true);
  assert.equal(domainUnits("keysso"), 3);
  assert.equal(UNIT_PRICE_USD.keysso, 0.0002);
  // Stats pair + one credit per page: wildberries' 119 961 domains = 1 200 pages + 2.
  assert.equal(estimateKeyssoProfileUnits(119961), 2 + Math.ceil(119961 / KEYSSO_REFDOMAIN_PAGE_SIZE));
  assert.equal(estimateKeyssoProfileUnits(0), 3);
});
