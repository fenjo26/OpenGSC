import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKLINK_EXPORT_FIELDS, EXPORT_PAGE_SIZE, PROBE_UNITS, STATS_UNITS,
  buildPageQuery, decidePaginationMode, domainOfUrl, estimateExportUnits,
  mapApiRow, monthSlices, normalizeUrlFrom, planEvents,
} from "./backlinksApi";

// ─── Field set and pricing ─────────────────────────────────────────────────────

// The three fields the ТЗ forbids by name. They cost 10/10/5 units against 1, and the gateway
// bills a field named in `where`/`order_by` even when it is not returned — so the guard has to
// hold everywhere a field name can appear, not just in `select`.
const FORBIDDEN = ["traffic", "traffic_domain", "refdomains_source"];

test("export field set is the twenty 1-unit fields and no premium field", () => {
  assert.equal(BACKLINK_EXPORT_FIELDS.length, 20);
  for (const f of FORBIDDEN) assert.ok(!BACKLINK_EXPORT_FIELDS.includes(f as never), `${f} must not be selected`);
});

test("no paging strategy names a premium field anywhere in the query", () => {
  const queries = [
    buildPageQuery({ target: "example.com", limit: EXPORT_PAGE_SIZE, offset: 0 }),
    buildPageQuery({ target: "example.com", limit: EXPORT_PAGE_SIZE, offset: 5000 }),
    buildPageQuery({ target: "example.com", limit: EXPORT_PAGE_SIZE, afterUrlFrom: "https://d.com/a" }),
    buildPageQuery({ target: "example.com", limit: EXPORT_PAGE_SIZE, seenFrom: "2026-01-01", seenTo: "2026-02-01" }),
  ];
  for (const q of queries) {
    const full = q.toString();
    for (const f of FORBIDDEN) assert.ok(!full.includes(f), `${f} leaked into ${full}`);
  }
});

test("pricing: 20 units a row, floored at 50, 10k rows ≈ 200k units", () => {
  assert.equal(estimateExportUnits(EXPORT_PAGE_SIZE), 20_000);
  assert.equal(estimateExportUnits(2), 50);           // floor
  assert.equal(estimateExportUnits(0), 50);           // an empty page still bills the floor
  assert.equal(estimateExportUnits(10_000), 200_000); // the CONTRACT.md §5 worked example
  assert.equal(PROBE_UNITS, 100);
  assert.equal(STATS_UNITS, 50);
});

// ─── Query building ────────────────────────────────────────────────────────────

test("offset page: full field set, all_time, aggregation=all, subdomains, desc order", () => {
  const q = buildPageQuery({ target: "example.com", limit: 1000, offset: 3000 });
  assert.equal(q.get("target"), "example.com");
  assert.equal(q.get("mode"), "subdomains");
  assert.equal(q.get("limit"), "1000");
  assert.equal(q.get("offset"), "3000");
  assert.equal(q.get("history"), "all_time");
  assert.equal(q.get("aggregation"), "all");
  assert.equal(q.get("select"), BACKLINK_EXPORT_FIELDS.join(","));
  assert.equal(q.get("order_by"), "first_seen_link:desc");
  assert.ok(!q.get("where"));
});

test("offset=0 is omitted — the gateway default and the first page are the same request", () => {
  assert.ok(!buildPageQuery({ target: "a.com", limit: 1000, offset: 0 }).get("offset"));
});

test("keyset page: strictly-greater url_from cursor, ascending order, no offset", () => {
  const q = buildPageQuery({ target: "example.com", limit: 1000, afterUrlFrom: "https://donor.ru/page" });
  assert.deepEqual(JSON.parse(String(q.get("where"))), {
    and: [{ field: "url_from", is: ["gt", "https://donor.ru/page"] }],
  });
  assert.equal(q.get("order_by"), "url_from:asc");
  assert.ok(!q.get("offset"));
});

test("slice page: half-open first_seen_link window, ascending order", () => {
  const q = buildPageQuery({ target: "example.com", limit: 1000, seenFrom: "2026-01-01", seenTo: "2026-02-01" });
  assert.deepEqual(JSON.parse(String(q.get("where"))), {
    and: [
      { field: "first_seen_link", is: ["gte", "2026-01-01"] },
      { field: "first_seen_link", is: ["lt", "2026-02-01"] },
    ],
  });
  assert.equal(q.get("order_by"), "first_seen_link:asc");
});

test("monthSlices covers the lookback in adjacent half-open windows", () => {
  const slices = monthSlices(new Date(Date.UTC(2026, 7, 24)), 3); // Aug 2026
  assert.equal(slices.length, 3);
  assert.deepEqual(slices[0], { from: "2026-06-01", to: "2026-07-01" });
  assert.equal(slices[0].to, slices[1].from); // no gap, no overlap
  assert.equal(slices[2].to, "2026-09-01");   // the last window ends after "now"
});

// ─── Normalization ─────────────────────────────────────────────────────────────

test("normalizeUrlFrom folds scheme, www, case, fragment and trailing slash", () => {
  assert.equal(normalizeUrlFrom("https://WWW.Example.com/Blog/Post/"), "example.com/Blog/Post");
  assert.equal(normalizeUrlFrom("example.com/blog/post"), "example.com/blog/post");
  assert.equal(normalizeUrlFrom("http://example.com/?utm=x"), "example.com/?utm=x");
  assert.equal(normalizeUrlFrom("https://example.com/page#section"), "example.com/page");
  assert.equal(normalizeUrlFrom("https://example.com"), "example.com/");
  assert.equal(normalizeUrlFrom(""), "");
});

test("normalizeUrlFrom keeps the query string and distinct ports", () => {
  assert.notEqual(normalizeUrlFrom("example.com/a?x=1"), normalizeUrlFrom("example.com/a?x=2"));
  assert.equal(normalizeUrlFrom("example.com:8080/a"), "example.com:8080/a");
});

test("domainOfUrl extracts the donor host", () => {
  assert.equal(domainOfUrl("https://www.donor.ru/blog/statya"), "donor.ru");
  assert.equal(domainOfUrl("donor.ru/blog"), "donor.ru");
  assert.equal(domainOfUrl("not a url at all .."), "");
});

// ─── Row mapping ───────────────────────────────────────────────────────────────

const RAW_ROW = {
  url_from: "https://www.Donor.ru/blog/post",
  url_to: "https://example.com/landing",
  anchor: "купить окна",
  alt: "",
  is_dofollow: true, is_nofollow: false, is_sponsored: false, is_ugc: false,
  is_content: true, is_image: false,
  domain_rating_source: 43.7,
  first_seen_link: "2026-03-15T00:00:00Z",
  last_seen: "2026-08-01",
  is_lost: false,
  lost_reason: null,
  http_code: 200,
  js_crawl: false,
  link_type: "Text",
  snippet_left: "Ремонт и ",
  snippet_right: " в Москве и области, звоните",
};

test("mapApiRow maps every api* column", () => {
  const r = mapApiRow(RAW_ROW)!;
  assert.ok(r);
  assert.equal(r.urlFrom, "https://www.Donor.ru/blog/post"); // stored as it arrived
  assert.equal(r.urlFromNorm, "donor.ru/blog/post");
  assert.equal(r.urlTo, "https://example.com/landing");
  assert.equal(r.domainFrom, "donor.ru");
  assert.equal(r.apiSeen, true);            // an all_time row is a link Ahrefs has seen
  assert.equal(r.apiLost, false);
  assert.equal(r.apiLostReason, "");
  assert.equal(r.apiAnchor, "купить окна");
  assert.equal(r.apiDofollow, true);
  assert.equal(r.apiDr, 43.7);
  assert.equal(r.apiHttpCode, 200);
  assert.equal(r.apiLinkType, "Text");
  assert.equal(r.apiSnippet, "Ремонт и в Москве и области, звоните");
  assert.equal(r.apiFirstSeen, "2026-03-15");
  assert.equal(r.apiLastSeen, "2026-08-01");
});

test("mapApiRow: nulls survive as null, not as hard zeros", () => {
  const r = mapApiRow({ ...RAW_ROW, domain_rating_source: null, http_code: null, is_lost: true, lost_reason: "removed" })!;
  assert.equal(r.apiDr, null);
  assert.equal(r.apiHttpCode, null);
  assert.equal(r.apiLost, true);
  assert.equal(r.apiLostReason, "removed");
});

test("mapApiRow drops rows without url_from and truncates the snippet to 500", () => {
  assert.equal(mapApiRow({ url_to: "https://example.com" }), null);
  assert.equal(mapApiRow(null), null);
  const long = mapApiRow({ ...RAW_ROW, snippet_left: "x".repeat(600), snippet_right: "" })!;
  assert.equal(long.apiSnippet.length, 500);
});

test("a sponsored link does not read as dofollow even if is_dofollow is inconsistent", () => {
  const r = mapApiRow({ ...RAW_ROW, is_dofollow: true, is_sponsored: true })!;
  assert.equal(r.apiDofollow, false);
  assert.equal(r.apiSponsored, true);
});

// ─── Events ────────────────────────────────────────────────────────────────────

const BASE = mapApiRow(RAW_ROW)!;

test("a row unknown to the DB plans exactly one appeared event", () => {
  const ev = planEvents(null, BASE);
  assert.deepEqual(ev.map(e => e.kind), ["appeared"]);
});

const existing = (over: Partial<Parameters<typeof planEvents>[0]> = {}) => ({
  apiLost: false, apiAnchor: "купить окна",
  apiDofollow: true, apiNofollow: false, apiSponsored: false, apiUgc: false,
  ...over,
}) as Parameters<typeof planEvents>[0];

test("unchanged row plans no events", () => {
  assert.deepEqual(planEvents(existing(), BASE), []);
});

test("is_lost transition drives lost and returned", () => {
  const lost = planEvents(existing(), { ...BASE, apiLost: true, apiLostReason: "removed" });
  assert.deepEqual(lost.map(e => e.kind), ["lost"]);
  assert.equal(JSON.parse(lost[0].detail).reason, "removed");

  const back = planEvents(existing({ apiLost: true }), BASE);
  assert.deepEqual(back.map(e => e.kind), ["returned"]);
});

test("anchor change is an event; filling in a missing anchor is not", () => {
  const changed = planEvents(existing({ apiAnchor: "старые окна" }), BASE);
  assert.deepEqual(changed.map(e => e.kind), ["anchor_changed"]);
  assert.deepEqual(JSON.parse(changed[0].detail), { from: "старые окна", to: "купить окна" });

  const enriched = planEvents(existing({ apiAnchor: "" }), BASE);
  assert.deepEqual(enriched.map(e => e.kind), []);
});

test("rel downgrade and upgrade are detected from the flag set, not just is_dofollow", () => {
  const downgraded = mapApiRow({ ...RAW_ROW, is_dofollow: false, is_nofollow: true })!;
  const ev = planEvents(existing(), downgraded);
  assert.deepEqual(ev.map(e => e.kind), ["rel_downgraded"]);
  assert.deepEqual(JSON.parse(ev[0].detail), { from: "dofollow", to: "nofollow" });

  const restored = planEvents(existing({ apiDofollow: false, apiNofollow: true }), BASE);
  assert.deepEqual(restored.map(e => e.kind), ["rel_upgraded"]);

  // sponsored beats plain nofollow in the label — it is the more specific answer.
  const sponsored = mapApiRow({ ...RAW_ROW, is_dofollow: false, is_sponsored: true })!;
  assert.equal(JSON.parse(planEvents(existing(), sponsored)[0].detail).to, "sponsored");
});

// ─── Probe verdict ─────────────────────────────────────────────────────────────

test("probe: disjoint non-empty second page means offset works", () => {
  assert.equal(decidePaginationMode(["a", "b"], ["c", "d"]), "offset");
});

test("probe: repeated, overlapping or rejected second page means keyset", () => {
  assert.equal(decidePaginationMode(["a", "b"], ["a", "b"]), "keyset");       // same head twice
  assert.equal(decidePaginationMode(["a", "b", "c"], ["c", "d", "e"]), "keyset"); // partial overlap
  assert.equal(decidePaginationMode(["a", "b"], null), "keyset");             // 400: unknown param
});

test("probe: empty second page means the profile fits one page — offset assumed", () => {
  assert.equal(decidePaginationMode(["a", "b"], []), "offset");
});
