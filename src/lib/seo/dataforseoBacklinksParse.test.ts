import assert from "node:assert/strict";
import test from "node:test";
import {
  dfsAuth, dfsStatusToHttp, parseDfsEnvelope, dfsUsdToUnits, dfsDay, dfsTarget,
  mapDfsSummary, dfsDofollowPct, mapDfsRefDomain, dfsBacklinkToExportRow, mapDfsBacklinksResult,
  mapDfsHistory, mapDfsNewLost, dfsBalanceUsd, monthsAgo,
} from "./dataforseoBacklinksParse";
import {
  parseMetricsProvider, isKeywordCapable, domainUnits, gatewayStatusFromError, UNIT_PRICE_USD,
  estimateCostUsd, DATAFORSEO_REQUEST_UNITS, DATAFORSEO_ROW_UNITS, DATAFORSEO_STATS_UNITS,
  estimateDataforseoRowsUnits, estimateDataforseoProfileUnits, formatProviderUnits, metersInDollars,
} from "./metricsPricing";
import { mapApiRow } from "./backlinksApi";

// Fixture shapes follow the documented response of each endpoint (docs.dataforseo.com/v3/backlinks,
// fetched 2026-10-10); numbers in the summary are the ones from issue #26's live test.

const ok = (result: unknown, cost = 0.024036) => ({
  version: "0.1.20260901", status_code: 20000, status_message: "Ok.", cost, tasks_count: 1, tasks_error: 0,
  tasks: [{ id: "t1", status_code: 20000, status_message: "Ok.", cost, result_count: 1, result: [result] }],
});

test("pricing: the issue's real summary charge is 24 036 micro-dollar units", () => {
  assert.equal(DATAFORSEO_STATS_UNITS, 24_036);
  assert.equal(dfsUsdToUnits(0.024036), 24_036);
  assert.ok(Math.abs(estimateCostUsd(DATAFORSEO_STATS_UNITS, "dataforseo") - 0.024036) < 1e-12);
  assert.equal(UNIT_PRICE_USD.dataforseo, 0.000001);
});

test("pricing: pages of 1000 pay one request fee each", () => {
  assert.equal(estimateDataforseoRowsUnits(0), DATAFORSEO_REQUEST_UNITS);
  assert.equal(estimateDataforseoRowsUnits(222), DATAFORSEO_REQUEST_UNITS + 222 * DATAFORSEO_ROW_UNITS);
  assert.equal(estimateDataforseoRowsUnits(1000), DATAFORSEO_REQUEST_UNITS + 1000 * DATAFORSEO_ROW_UNITS);
  assert.equal(estimateDataforseoRowsUnits(1001), 2 * DATAFORSEO_REQUEST_UNITS + 1001 * DATAFORSEO_ROW_UNITS);
  // 49 domains (the issue's site): summary + one page ≈ $0.0498
  assert.equal(estimateDataforseoProfileUnits(49), DATAFORSEO_STATS_UNITS + DATAFORSEO_REQUEST_UNITS + 49 * DATAFORSEO_ROW_UNITS);
  assert.equal(domainUnits("dataforseo"), DATAFORSEO_STATS_UNITS);
});

test("provider plumbing: parse, keyword guard, dollars on screen", () => {
  assert.equal(parseMetricsProvider("dataforseo"), "dataforseo");
  assert.equal(isKeywordCapable("dataforseo"), false);
  assert.equal(metersInDollars("dataforseo"), true);
  assert.equal(metersInDollars("ahrefs"), false);
  assert.equal(formatProviderUnits(24_036, "dataforseo"), "$0.0240");
  assert.equal(formatProviderUnits(12_500_000, "dataforseo"), "$12.50");
  assert.equal(formatProviderUnits(0, "dataforseo"), "$0");
  assert.equal(gatewayStatusFromError("dataforseo 402: 40200 Payment Required"), 402);
});

test("auth: login:password is encoded, a ready token passes through", () => {
  assert.equal(dfsAuth("me@x.com:secret"), Buffer.from("me@x.com:secret").toString("base64"));
  assert.equal(dfsAuth("  bWVAeC5jb206c2VjcmV0 "), "bWVAeC5jb206c2VjcmV0");
});

test("status codes fold onto the three-digit statuses the UI branches on", () => {
  assert.equal(dfsStatusToHttp(20000), 200);
  assert.equal(dfsStatusToHttp(40100), 401);
  assert.equal(dfsStatusToHttp(40101), 401);
  assert.equal(dfsStatusToHttp(40200), 402);
  assert.equal(dfsStatusToHttp(40201), 402);
  assert.equal(dfsStatusToHttp(40202), 429);
  assert.equal(dfsStatusToHttp(40204), 403);
  assert.equal(dfsStatusToHttp(40400), 404);
  assert.equal(dfsStatusToHttp(40501), 400);
  assert.equal(dfsStatusToHttp(50000), 500);
});

test("envelope: a task failing inside a 200 is an error, and its cost is still read", () => {
  const env = parseDfsEnvelope(200, {
    status_code: 20000, cost: 0,
    tasks: [{ status_code: 40200, status_message: "Payment Required.", cost: 0, result: null }],
  });
  assert.equal(env.ok, false);
  if (!env.ok) {
    assert.equal(env.status, 402);
    assert.match(env.error, /^dataforseo 402: 40200/);
    assert.equal(gatewayStatusFromError(env.error), 402);
    assert.equal(env.costUsd, 0);
  }
  const top = parseDfsEnvelope(200, { status_code: 40100, status_message: "You are not authorized." });
  assert.equal(top.ok, false);
  if (!top.ok) assert.equal(top.status, 401);
  const http = parseDfsEnvelope(401, { status_code: 40100, status_message: "Unauthorized" });
  assert.equal(http.ok, false);
  if (!http.ok) assert.equal(gatewayStatusFromError(http.error), 401);
  const empty = parseDfsEnvelope(200, { status_code: 20000, tasks: [] });
  assert.equal(empty.ok, false);
  const good = parseDfsEnvelope(200, ok({ target: "x.gr", rank: 21 }));
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.result.rank, 21);
    assert.equal(good.costUsd, 0.024036);
  }
});

test("summary: the issue #26 numbers, rank is DataForSEO's own", () => {
  const s = mapDfsSummary({
    target: "example.gr", first_seen: "2021-04-02 08:11:42 +00:00", rank: 21, backlinks: 222,
    backlinks_spam_score: 48, broken_backlinks: 2, referring_domains: 49, referring_domains_nofollow: 9,
    referring_main_domains: 45,
  });
  assert.deepEqual(s, {
    rank: 21, backlinks: 222, refDomains: 49, refMainDomains: 45, refDomainsNofollow: 9,
    brokenBacklinks: 2, spamScore: 48, firstSeen: "2021-04-02",
  });
  assert.equal(dfsDofollowPct(s), 82);
  assert.equal(dfsDofollowPct({ ...s, refDomainsNofollow: null }), null);
  assert.equal(dfsDofollowPct({ ...s, refDomains: 0 }), null);
});

test("referring domain: nofollow only when every referring page is nofollow", () => {
  const base = {
    type: "backlinks_referring_domain", domain: "WWW.Donor.com", rank: 37, backlinks: 12,
    first_seen: "2022-01-05 00:00:00 +00:00", backlinks_spam_score: 3,
    referring_pages: 4, referring_pages_nofollow: 1,
  };
  assert.deepEqual(mapDfsRefDomain(base), {
    refDomain: "donor.com", rank: 37, linksToTarget: 12, dofollow: true, firstSeen: "2022-01-05", spamScore: 3,
  });
  assert.equal(mapDfsRefDomain({ ...base, referring_pages_nofollow: 4 })!.dofollow, false);
  assert.equal(mapDfsRefDomain({ ...base, referring_pages: null })!.dofollow, true);
  assert.equal(mapDfsRefDomain({ ...base, domain: "localhost" }), null);
});

const BACKLINK = {
  type: "backlink", domain_from: "blog.donor.com", url_from: "https://blog.donor.com/post",
  domain_to: "site.gr", url_to: "https://site.gr/transfer", is_new: false, is_lost: false,
  backlink_spam_score: 12, rank: 3, page_from_rank: 5, domain_from_rank: 40,
  page_from_status_code: 200, first_seen: "2023-05-01 12:00:00 +00:00", last_seen: "2026-10-01 01:00:00 +00:00",
  item_type: "anchor", attributes: null, dofollow: true, anchor: "taxi thessaloniki",
  text_pre: "Book a", text_post: "today", semantic_location: "article", is_broken: false,
};

test("backlink → Ahrefs all-backlinks shape, through the shared mapApiRow", () => {
  const raw = dfsBacklinkToExportRow(BACKLINK)!;
  assert.equal(raw.domain_rating_source, undefined, "DataForSEO rank must never pose as Ahrefs DR");
  const row = mapApiRow(raw)!;
  assert.equal(row.urlFrom, "https://blog.donor.com/post");
  assert.equal(row.urlTo, "https://site.gr/transfer");
  assert.equal(row.domainFrom, "blog.donor.com");
  assert.equal(row.apiAnchor, "taxi thessaloniki");
  assert.equal(row.apiDofollow, true);
  assert.equal(row.apiNofollow, false);
  assert.equal(row.apiContent, true);
  assert.equal(row.apiLost, false);
  assert.equal(row.apiDr, null);
  assert.equal(row.apiSnippet, "Book a today");
  assert.equal(row.apiFirstSeen, "2023-05-01");
  assert.equal(row.apiLastSeen, "2026-10-01");
  assert.equal(row.apiHttpCode, 200);
  assert.equal(row.apiSpamScore, 12);
});

test("backlink: rel attributes, footer placement, lost and broken", () => {
  const nf = mapApiRow(dfsBacklinkToExportRow({ ...BACKLINK, dofollow: false, attributes: ["nofollow", "sponsored"] })!)!;
  assert.equal(nf.apiDofollow, false);
  assert.equal(nf.apiNofollow, true);
  assert.equal(nf.apiSponsored, true);
  const footer = mapApiRow(dfsBacklinkToExportRow({ ...BACKLINK, semantic_location: "footer" })!)!;
  assert.equal(footer.apiContent, false);
  const unknownLoc = mapApiRow(dfsBacklinkToExportRow({ ...BACKLINK, semantic_location: null })!)!;
  assert.equal(unknownLoc.apiContent, true);
  const lost = mapApiRow(dfsBacklinkToExportRow({ ...BACKLINK, is_lost: true, is_broken: true })!)!;
  assert.equal(lost.apiLost, true);
  assert.equal(lost.apiLostReason, "broken");
  const img = dfsBacklinkToExportRow({ ...BACKLINK, item_type: "image" })!;
  assert.equal(img.is_image, true);
  assert.equal(dfsBacklinkToExportRow({ ...BACKLINK, url_from: "blog.donor.com/x" }), null);
});

test("ahrefs rows carry no spam score", () => {
  const row = mapApiRow({ url_from: "https://a.com/x", url_to: "https://b.com/", is_dofollow: true })!;
  assert.equal(row.apiSpamScore, null);
});

test("backlinks page: token and counts", () => {
  const p = mapDfsBacklinksResult({ total_count: 222, items_count: 2, search_after_token: "tok", items: [BACKLINK, { url_from: "" }] });
  assert.equal(p.rows.length, 1);
  assert.equal(p.itemsCount, 2);
  assert.equal(p.totalCount, 222);
  assert.equal(p.searchAfterToken, "tok");
  assert.equal(mapDfsBacklinksResult({ items: [] }).searchAfterToken, null);
});

test("history and new/lost come back oldest first", () => {
  const h = mapDfsHistory({ items: [
    { date: "2026-09-01 00:00:00 +00:00", rank: 22, backlinks: 230, referring_domains: 50, new_backlinks: 9, lost_backlinks: 1 },
    { date: "2026-08-01 00:00:00 +00:00", rank: 21, backlinks: 222, referring_domains: 49 },
    { date: null },
  ] });
  assert.deepEqual(h.map(x => x.date), ["2026-08-01", "2026-09-01"]);
  assert.equal(h[1].newBacklinks, 9);
  assert.equal(h[0].newBacklinks, null);
  const nl = mapDfsNewLost({ items: [
    { date: "2026-10-04", new_backlinks: 3, lost_backlinks: 1, new_referring_domains: 1, lost_referring_domains: 0 },
    { date: "2026-09-27", new_backlinks: null },
  ] });
  assert.deepEqual(nl.map(x => x.date), ["2026-09-27", "2026-10-04"]);
  assert.equal(nl[0].newBacklinks, 0);
  assert.equal(nl[1].lostBacklinks, 1);
});

test("small helpers", () => {
  assert.equal(dfsDay("2026-10-10 05:00:00 +00:00"), "2026-10-10");
  assert.equal(dfsDay("garbage"), "");
  assert.equal(dfsTarget("https://www.Site.gr/path?x"), "site.gr");
  assert.equal(dfsBalanceUsd({ money: { balance: 41.5 } }), 41.5);
  assert.equal(dfsBalanceUsd({}), null);
  assert.equal(monthsAgo(new Date("2026-10-10T00:00:00Z"), 12), "2025-10-01");
  assert.equal(dfsUsdToUnits(null), 0);
});
