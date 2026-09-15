// SERP Monitor's SE::Google mapping, against synthetic fixtures in ./__fixtures__/ (no live
// instance — the probe script is what talks to one). What is worth testing is where a mapping
// mistake is silent and expensive: positions must never carry holes (the diff engine compares
// them against last week's list), and an emptiness that is really a burnt proxy must arrive as
// the problem code it is, never as "the SERP is empty".
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  APARSER_SERP_OPTION_IDS, APARSER_SERP_PARSERS, aparserSerpOptions, mapAparserSerp,
} from "../seo/aparserSerp";
import { runSerp } from "../seo/serp";

const fix = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));

// ── mapAparserSerp: the happy path ──────────────────────────────────────────────

test("a full top-100 maps to positions 1..100, with totalCount and features", () => {
  const m = mapAparserSerp(fix("aparser-serp-top100-synthetic.json"), 100);
  assert.equal(m.problem, null);
  assert.equal(m.results.length, 100);
  assert.deepEqual(m.results.map((r) => r.position), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(m.results[0].url, "https://result001.example.com/page/1");
  assert.equal(m.results[0].title, "Result 001 — synthetic");
  assert.equal(m.results[99].domain, "result100.example.com");
  assert.equal(m.totalCount, "8720000");
  assert.ok(m.features.includes("related"), "the documented $related block is a feature");
  assert.ok(m.features.includes("paa"), "the people-also-ask block is a feature");
});

test("want=20 cuts a 100-row SERP to 20", () => {
  const m = mapAparserSerp(fix("aparser-serp-top100-synthetic.json"), 20);
  assert.equal(m.results.length, 20);
  assert.equal(m.results[19].position, 20);
});

test("a duplicate URL across pages appears once, and positions have no holes", () => {
  // The fixture's 22 entries carry 20 distinct URLs (entries 21 and 22 repeat 4 and 1).
  const m = mapAparserSerp(fix("aparser-serp-dup-pages-synthetic.json"), 100);
  assert.equal(m.results.length, 20);
  assert.deepEqual(m.results.map((r) => r.position), Array.from({ length: 20 }, (_, i) => i + 1));
  const urls = m.results.map((r) => r.url);
  assert.equal(new Set(urls).size, urls.length, "dedupe by exact url");
  assert.equal(urls[0], "https://result001.example.com/page/1", "first occurrence keeps the first position");
});

test("rows without an http(s) link are dropped: no link, javascript:, empty", () => {
  const m = mapAparserSerp(fix("aparser-serp-junk-rows-synthetic.json"), 100);
  assert.equal(m.results.length, 2);
  assert.deepEqual(m.results.map((r) => r.position), [1, 2]);
  assert.equal(m.results[0].url, "https://good-one.example.com/a");
  assert.equal(m.results[1].domain, "good-two.example.net", "www. stripped, as domainOf does");
});

// ── mapAparserSerp: the emptiness rule ─────────────────────────────────────────

test("serp:[] with totalcount 0 is a legitimate empty SERP, not a failure", () => {
  const m = mapAparserSerp(fix("aparser-serp-empty-zero-synthetic.json"), 100);
  assert.equal(m.problem, null);
  assert.deepEqual(m.results, []);
  assert.equal(m.totalCount, "0");
});

test("serp:[] without totalcount is a burnt proxy — aparser_blocked_or_empty", () => {
  const m = mapAparserSerp(fix("aparser-serp-empty-blocked-synthetic.json"), 100);
  assert.equal(m.problem, "aparser_blocked_or_empty");
  assert.deepEqual(m.results, []);
});

test("success:0 is a failed parse, and a non-object row is no result at all", () => {
  assert.equal(mapAparserSerp(fix("aparser-serp-failed-synthetic.json"), 100).problem, "aparser_parser_failed");
  assert.equal(mapAparserSerp(null, 100).problem, "aparser_no_result");
});

// ── aparserSerpOptions: depth is bought in pages ────────────────────────────────

test("depth becomes pages: 100 → 10, 20 → 2, 15 → 2", () => {
  const pages = (depth: number): unknown =>
    aparserSerpOptions({ depth, gl: "ar", hl: "es" }).find((o) => o.id === APARSER_SERP_OPTION_IDS.pagecount)?.value;
  assert.equal(pages(100), 10);
  assert.equal(pages(20), 2);
  assert.equal(pages(15), 2);
  assert.equal(pages(5), 1);
});

test("gl and hl go out as explicit overrides next to the page count", () => {
  assert.deepEqual(aparserSerpOptions({ depth: 100, gl: "AR", hl: "es" }), [
    { type: "override", id: APARSER_SERP_OPTION_IDS.pagecount, value: 10 },
    { type: "override", id: APARSER_SERP_OPTION_IDS.country, value: "ar" },
    { type: "override", id: APARSER_SERP_OPTION_IDS.language, value: "es" },
  ]);
});

// ── runSerp: the guards, which cost no network ────────────────────────────────

test("no password → no_serp_key, even with a baseUrl", async () => {
  const r = await runSerp("aparser", "", "casino online", { baseUrl: "127.0.0.1:9091" });
  assert.equal(r.error, "no_serp_key");
});

test("no baseUrl → no_serp_base_url, not no_serp_key", async () => {
  const r = await runSerp("aparser", "pw", "casino online", {});
  assert.equal(r.error, "no_serp_base_url");
});

test("engine bing is refused with the supported list, before any request", async () => {
  const r = await runSerp("aparser", "pw", "casino online", { baseUrl: "127.0.0.1:9091", engine: "bing" });
  assert.match(r.error ?? "", /supported: google/);
  assert.match(r.error ?? "", /bing/);
});

// ── runSerp: the full path, transport stubbed like geoAparser.test.ts does ─────

/** The parts of the oneRequest body the assertions look at. */
interface CapturedBody {
  action: string;
  data: {
    parser: string;
    rawResults: number;
    options: { type: string; id: string; value: unknown }[];
  } & Record<string, unknown>;
}

/** Stubs fetch with one A-Parser API response; returns the captured request bodies. */
function stub(responses: unknown[]): { bodies: () => CapturedBody[]; done: () => void } {
  const g = globalThis as unknown as { fetch: typeof fetch };
  const real = g.fetch;
  const seen: CapturedBody[] = [];
  let i = 0;
  g.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
    seen.push(JSON.parse(String(init.body ?? "{}")));
    return { ok: true, status: 200, text: async () => "", json: async () => responses[Math.min(i++, responses.length - 1)] };
  }) as unknown as typeof fetch;
  return { bodies: () => seen, done: () => { g.fetch = real; } };
}

test("runSerp('aparser') names the parser, forces rawResults and pages through SE::Google", async () => {
  const s = stub([{ success: 1, data: { results: [fix("aparser-serp-top100-synthetic.json")] } }]);
  try {
    const r = await runSerp("aparser", "pw", "casino online", { baseUrl: "127.0.0.1:9091", num: 100, gl: "ar", hl: "es" });
    assert.equal(r.error, undefined);
    assert.equal(r.provider, "aparser");
    assert.equal(r.engine, "google");
    assert.equal(r.results.length, 100);
    assert.equal(r.results[0].position, 1);
    assert.equal(r.totalCount, "8720000");
    const body = s.bodies()[0];
    assert.equal(body.action, "oneRequest");
    assert.equal(body.data.parser, "SE::Google");
    assert.equal(body.data.rawResults, 1);
    assert.equal(body.data.options[0].id, APARSER_SERP_OPTION_IDS.pagecount);
    assert.equal(body.data.options[0].value, 10);
  } finally { s.done(); }
});

test("an empty result set through runSerp surfaces the problem code EXACTLY", async () => {
  // classifySnapshot (T3) compares SerpResponse.error verbatim against its problem list —
  // a prefix here would turn every burnt proxy into a generic provider_error.
  const s = stub([{ success: 1, data: { results: [fix("aparser-serp-empty-blocked-synthetic.json")] } }]);
  try {
    const r = await runSerp("aparser", "pw", "casino online", { baseUrl: "127.0.0.1:9091", num: 20 });
    assert.equal(r.error, "aparser_blocked_or_empty");
    assert.deepEqual(r.results, []);
  } finally { s.done(); }
});

test("an instance that rejects an override is retried with the depth override alone", async () => {
  const s = stub([
    { success: 0, data: "unknown option id" },
    { success: 1, data: { results: [fix("aparser-serp-top100-synthetic.json")] } },
  ]);
  try {
    const r = await runSerp("aparser", "pw", "casino online", { baseUrl: "127.0.0.1:9091", num: 50 });
    assert.equal(r.error, undefined);
    assert.equal(s.bodies().length, 2);
    const retried = s.bodies()[1].data.options;
    assert.deepEqual(retried, [{ type: "override", id: APARSER_SERP_OPTION_IDS.pagecount, value: 5 }]);
  } finally { s.done(); }
});

test("the parser constant the transport is called with is SE::Google", () => {
  assert.equal(APARSER_SERP_PARSERS.google, "SE::Google");
});
