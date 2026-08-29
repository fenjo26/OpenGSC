import { test } from "node:test";
import assert from "node:assert/strict";
import { mapGeoAparserRow, runGeoAparser } from "./geoAparser";

// What is worth testing here is the boundary between a parser row and the GEO report, because
// every failure mode on this side is silent: a report with no citations still renders, complete
// with metrics, and reads as "this niche cites nobody" instead of "the mapping missed".

const SOURCES = [
  { link: "https://welcomepickups.com/thessaloniki/", anchor: "Welcome Pickups", snippet: "Private transfers", type: "citation" },
  { link: "https://www.getyourguide.com/x", anchor: "GetYourGuide", snippet: "Tours", type: "citation" },
  { link: "https://www.reddit.com/r/greece/x", anchor: "reddit thread", snippet: "discussion", type: "other" },
];

test("cited and merely-scanned sources stay distinguishable", () => {
  const r = mapGeoAparserRow({ answer: "Answer body", model: "gpt-4o", sources: SOURCES });
  assert.ok(r);
  assert.equal(r!.answer, "Answer body");
  assert.equal(r!.model, "gpt-4o");
  assert.equal(r!.sources.filter(s => s.type === "citation").length, 2);
  assert.equal(r!.sources.filter(s => s.type === "other").length, 1);
  assert.equal(r!.textOnly, false);
});

test("an untyped source is never promoted to a citation, and a non-URL is dropped", () => {
  // Over-counting citations inflates top-3 concentration, the source-type mix and every trust
  // score; an uncited-but-scanned source only costs precision. So "unknown" means "other".
  const r = mapGeoAparserRow({ answer: "A", sources: [
    { link: "not a url", anchor: "x", type: "citation" },
    { link: "https://example.com/b", anchor: "b" },
    { link: "https://example.com/b", anchor: "duplicate" },
  ] });
  assert.ok(r);
  assert.equal(r!.sources.length, 1);
  assert.equal(r!.sources[0].type, "other");
});

test("an answer with no sources maps, and says so", () => {
  const r = mapGeoAparserRow({ answer: "Just prose with https://example.com/a in it." });
  assert.ok(r);
  assert.equal(r!.textOnly, true);
  assert.equal(r!.sources.length, 0);
});

test("an empty answer is not a result", () => {
  assert.equal(mapGeoAparserRow({ answer: "   ", sources: SOURCES }), null);
  assert.equal(mapGeoAparserRow(null), null);
});

/** Stubs fetch with one A-Parser API response; returns the captured request bodies. */
function stub(responses: any[]): { bodies: () => any[]; done: () => void } {
  const g = globalThis as unknown as { fetch: typeof fetch };
  const real = g.fetch;
  const seen: any[] = [];
  let i = 0;
  g.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
    seen.push(JSON.parse(String(init.body ?? "{}")));
    const body = responses[Math.min(i++, responses.length - 1)];
    return { ok: true, status: 200, text: async () => "", json: async () => body };
  }) as unknown as typeof fetch;
  return { bodies: () => seen, done: () => { g.fetch = real; } };
}

const OK = { success: 1, data: { results: [{ answer: "A", model: "gpt-4o", sources: SOURCES }] } };

test("the request names the parser and forces web search on", async () => {
  // "Search the web" is OFF by default in FreeAI::ChatGPT, and with it off the answer comes out
  // of the model's weights — the one thing the GEO module exists to say is not evidence.
  const s = stub([OK]);
  try {
    const r = await runGeoAparser({ baseUrl: "127.0.0.1:9091", password: "pw", query: "q", timeoutMs: 5000 });
    assert.ok(!("error" in r));
    const body = s.bodies()[0];
    assert.equal(body.action, "oneRequest");
    assert.equal(body.data.parser, "FreeAI::ChatGPT");
    assert.equal(body.data.rawResults, 1);
    assert.deepEqual(body.data.options, [{ type: "override", id: "search", value: 1 }]);
  } finally { s.done(); }
});

test("an instance that rejects the override is retried without it, not failed", async () => {
  const s = stub([{ success: 0, data: "unknown option id: search" }, OK]);
  try {
    const r = await runGeoAparser({ baseUrl: "127.0.0.1:9091", password: "pw", query: "q", timeoutMs: 5000 });
    assert.ok(!("error" in r), "a preset that already has web search on is a valid setup");
    assert.equal(s.bodies().length, 2);
    assert.equal(s.bodies()[1].data.options, undefined);
  } finally { s.done(); }
});

test("an empty result set is an error, never an audit of zeros", async () => {
  // A burnt session or a captcha answers success:1 with nothing. Read as success, that becomes a
  // finished-looking report claiming the niche cites no one.
  const s = stub([{ success: 1, data: { results: [{ answer: "", sources: [] }] } }]);
  try {
    const r = await runGeoAparser({ baseUrl: "127.0.0.1:9091", password: "pw", query: "q", timeoutMs: 5000 });
    assert.ok("error" in r);
  } finally { s.done(); }
});

test("no password anywhere is refused before a request is made", async () => {
  const s = stub([OK]);
  try {
    const r = await runGeoAparser({ baseUrl: "127.0.0.1:9091", password: "", query: "q", timeoutMs: 5000 });
    assert.deepEqual(r, { error: "aparser_no_password" });
    assert.equal(s.bodies().length, 0);
  } finally { s.done(); }
});
