import assert from "node:assert/strict";
import test from "node:test";
import {
  parseKeyssoEnvelope, mapKeyssoDashboard, mapKeyssoRefDomain, keyssoRemainingCredits,
  keyssoErrorText, keyssoNextStep, KEYSSO_202_DELAYS_MS, KEYSSO_ERROR_RETRIES,
  keyssoAnswerSources, mapKeyssoAiAnswer, mapKeyssoAiCompetitor, keyssoDate, keyssoBacklinkToExportRow,
  mapKeyssoDirectAd, mapKeyssoDirectKeyword, mapKeyssoKeyword,
} from "./keyssoParse";
import {
  parseMetricsProvider, isKeywordCapable, domainUnits, estimateKeyssoProfileUnits,
  gatewayStatusFromError, UNIT_PRICE_USD, KEYSSO_REFDOMAIN_PAGE_SIZE, keyssoListUnits, YANDEX_MARKET,
  KEYSSO_BASES, parseKeyssoBase, yandexMarketKey, isYandexMarketKey, keyssoBaseLabel,
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

// Trimmed from a live `organic/ai-answers` row (probe3, 2026-10-08): the answer is HTML with the
// sources as <a href> — the same host can appear twice (inline and in the sources block).
const LIVE_AI_ANSWER = {
  word: "касторовое масло индийское отзывы", ws: 9, wsk: 5, superwsk: 1,
  ai_answer: '<strong>Покупатели</strong> … <span class="ai-answer-link"><a href="https://reviews.yandex.ru/product/x" target="_blank">reviews.yandex.ru</a></span>'
    + '<span class="ai-answer-link"><a href="https://market.yandex.ru/card/y/reviews">market.yandex.ru</a></span>'
    + '<div class="ai-answer-sources"><a href="https://reviews.yandex.ru/product/x">reviews.yandex.ru</a>'
    + '<a href="https://wildberries.ru/catalog/138996254/detail.aspx">wildberries.ru</a>'
    + '<a href="https://ozon.ru/product/z/reviews/">ozon.ru</a></div>',
};

test("AI answer: sources are distinct hosts in order; our place and URL come from them", () => {
  assert.deepEqual(keyssoAnswerSources(LIVE_AI_ANSWER.ai_answer).map(s => s.host),
    ["reviews.yandex.ru", "market.yandex.ru", "wildberries.ru", "ozon.ru"]);
  const a = mapKeyssoAiAnswer(LIVE_AI_ANSWER, "wildberries.ru")!;
  assert.equal(a.query, "касторовое масло индийское отзывы");
  assert.equal(a.wsk, 5);
  assert.equal(a.rank, 3);
  assert.equal(a.url, "https://wildberries.ru/catalog/138996254/detail.aspx");
});

test("AI answer: a subdomain counts as the site; an absent site leaves rank and URL empty", () => {
  const sub = mapKeyssoAiAnswer({ word: "q", ai_answer: '<a href="https://m.example.ru/p">m</a>' }, "example.ru")!;
  assert.equal(sub.rank, 1);
  const none = mapKeyssoAiAnswer({ word: "q", ai_answer: '<a href="https://other.ru/">o</a>' }, "example.ru")!;
  assert.equal(none.rank, null);
  assert.equal(none.url, "");
  // A lookalike suffix is not a subdomain.
  assert.equal(mapKeyssoAiAnswer({ word: "q", ai_answer: '<a href="https://notexample.ru/">x</a>' }, "example.ru")!.rank, null);
  assert.equal(mapKeyssoAiAnswer({ ai_answer: "" }, "example.ru"), null);
});

test("AI competitors: name, shared count and their own AI-answer reach", () => {
  const c = mapKeyssoAiCompetitor({ id: 30079137, name: "sweetmarin.ru", cnt: 57, vis: 11165, queries_in_ai_answers: 560 })!;
  assert.deepEqual(c, { domain: "sweetmarin.ru", shared: 57, aiQueries: 560 });
});

// Live `links/backlinks` row (probe 1, 2026-10-08).
const LIVE_BACKLINK = {
  id: 241384346, source_did: 241384346, source_name: "list-vk.com", domain_exist: true,
  source_url: "https://list-vk.com/274450183", source_title: "Чикокер …", source_ip: "195.161.68.20",
  source_dr: 30, url: "https://wildberries.ru/catalog/7256043/detail.aspx", anchor: "Подробнее...",
  link_type: 1, rel_type: [], created_at: "05.08.2023", updated_at: "05.08.2023", status: 1,
};

test("Keys.so dates: dd.mm.yyyy and dd.mm.yy hh:mm both become ISO days", () => {
  assert.equal(keyssoDate("05.08.2023"), "2023-08-05");
  assert.equal(keyssoDate("10.07.23 17:46"), "2023-07-10");
  assert.equal(keyssoDate(""), "");
  assert.equal(keyssoDate("2023-08-05"), "");
});

test("backlink row → all-backlinks shape the SiteBacklink writer already understands", () => {
  const r = keyssoBacklinkToExportRow(LIVE_BACKLINK)!;
  assert.equal(r.url_from, "https://list-vk.com/274450183");
  assert.equal(r.url_to, "https://wildberries.ru/catalog/7256043/detail.aspx");
  assert.equal(r.anchor, "Подробнее...");
  assert.equal(r.domain_rating_source, 30);
  assert.equal(r.first_seen_link, "2023-08-05");
  assert.equal(r.is_lost, false);
  // No rel attribute → follow.
  assert.equal(r.is_dofollow, true);
  assert.equal(r.is_nofollow, false);
});

test("any rel code reads as not passing weight; rows without a source URL are dropped", () => {
  const r = keyssoBacklinkToExportRow({ ...LIVE_BACKLINK, rel_type: [1] })!;
  assert.equal(r.is_dofollow, false);
  assert.equal(r.is_nofollow, true);
  assert.equal(keyssoBacklinkToExportRow({ ...LIVE_BACKLINK, source_url: "" }), null);
  assert.equal(keyssoBacklinkToExportRow({ ...LIVE_BACKLINK, status: 0 })!.is_lost, true);
});

// Live `context/ads` / `context/keywords` / `similarkeys` rows (probe 4, 2026-10-08), trimmed.
test("Direct ad: header/txt/keyscnt, landing URL stripped of per-click query noise", () => {
  const a = mapKeyssoDirectAd({
    id: 2555396596, header: "Перфоратор профессиональный. Акции каждый день.",
    txt: "Перфоратор способен обрабатывать различные материалы…", keyscnt: 5,
    url: "https://www.wildberries.ru/catalog/227424775/detail.aspx?utm_source=ya_direct&yclid=1468", serp: "22.08.2026",
  })!;
  assert.equal(a.url, "https://www.wildberries.ru/catalog/227424775/detail.aspx");
  assert.equal(a.keys, 5);
  assert.equal(a.seen, "2026-08-22");
  assert.equal(mapKeyssoDirectAd({ txt: "no header" }), null);
});

test("Direct keyword and similar-phrase rows keep Wordstat exact frequency apart from broad", () => {
  const k = mapKeyssoDirectKeyword({ word: "роял канин для щенков", pos: 62, ws: 4, wsk: 2, header: "Original Choice" })!;
  assert.deepEqual(k, { keyword: "роял канин для щенков", position: 62, wsk: 2, title: "Original Choice" });
  const s2 = mapKeyssoKeyword({ word: "Fox Cake", ws: 61, wsk: 1, kei: 1 })!;
  assert.deepEqual(s2, { keyword: "fox cake", ws: 61, wsk: 1, kei: 1 });
});

test("list pricing: a credit per started 100 rows; the Yandex market has its own key", () => {
  assert.equal(keyssoListUnits(1), 1);
  assert.equal(keyssoListUnits(100), 1);
  assert.equal(keyssoListUnits(150), 2);
  assert.equal(keyssoListUnits(1000), 10);
  assert.equal(YANDEX_MARKET, "yandex");
});

test("Yandex regions: documented codes only, Moscow by default, stored apart per region", () => {
  assert.equal(KEYSSO_BASES.length, 20);
  assert.equal(parseKeyssoBase("SPB"), "spb");
  // Keys.so's Google bases and junk fall back to Moscow — this is the Yandex market.
  assert.equal(parseKeyssoBase("gru"), "msk");
  assert.equal(parseKeyssoBase(undefined), "msk");
  // Moscow keeps the key results were stored under before regions existed.
  assert.equal(yandexMarketKey("msk"), "yandex");
  assert.equal(yandexMarketKey("spb"), "yandex_spb");
  assert.equal(isYandexMarketKey("yandex_spb"), true);
  assert.equal(isYandexMarketKey("ru"), false);
  assert.equal(keyssoBaseLabel("spb", "ru"), "Санкт-Петербург");
  assert.equal(keyssoBaseLabel("spb", "de"), "Saint Petersburg");
});
