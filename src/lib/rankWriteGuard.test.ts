// A failed or empty SERP must not replace a known rank with "not found".
// The writes go through the test hook so this never touches the database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { __setWriterForTests } from "./providerLog/log";
import { __setRankWriterForTests, checkTrackedKeyword } from "./rank";
import { runSerp } from "./seo/serp";

type Row = Record<string, unknown>;

const checks: Row[] = [];
const updates: Row[] = [];

before(() => {
  __setWriterForTests();
  __setRankWriterForTests({
    createCheck: async (data) => { checks.push(data); return data; },
    updateKeyword: async (_id, data) => { updates.push(data); return data; },
  });
});

after(() => {
  __setRankWriterForTests();
});

function useFetch(handler: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const made = handler(body);
    return new Response(JSON.stringify(made.json), {
      status: made.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

const kw = (lastPosition: number | null) => ({
  id: "k1",
  keyword: "taxi thessaloniki",
  country: "us",
  lang: "en",
  lastPosition,
  bestPosition: lastPosition,
  siteUrl: "https://tracked.example/",
});

function organic(n: number, page: number) {
  return Array.from({ length: n }, (_, i) => ({
    title: `Result ${page}-${i}`,
    link: `https://other-${page}-${i}.test/p`,
    snippet: "a real result",
  }));
}

function lastUpdate(): Row {
  const u = updates.at(-1);
  if (!u) throw new Error("no keyword update");
  return u;
}

test("serper quota exhaustion keeps the previous rank", async () => {
  checks.length = 0; updates.length = 0;
  const restore = useFetch(() => ({ status: 400, json: { message: "Not enough credits", statusCode: 400 } }));
  try {
    const r = await checkTrackedKeyword(kw(7), { provider: "serper", apiKey: "k" });
    assert.match(String(r.error), /not enough credits/i);
    assert.equal(checks.at(-1)?.error && String(checks.at(-1)?.error), r.error);
    assert.equal("lastPosition" in lastUpdate(), false);
    assert.equal("lastSuccessfulCheckAt" in lastUpdate(), false);
    assert.ok(lastUpdate().lastCheckedAt instanceof Date);
  } finally { restore(); }
});

test("serper HTTP 200 credit body is an error, not an empty SERP", async () => {
  const restore = useFetch(() => ({ status: 200, json: { message: "Not enough credits", organic: [] } }));
  try {
    const r = await runSerp("serper", "k", "taxi", { num: 10 });
    assert.match(String(r.error), /not enough credits/i);
    assert.equal(r.results.length, 0);
  } finally { restore(); }
});

test("serper empty organic results keep the previous rank", async () => {
  checks.length = 0; updates.length = 0;
  const restore = useFetch(() => ({ status: 200, json: { organic: [], peopleAlsoAsk: [], relatedSearches: [] } }));
  try {
    const r = await checkTrackedKeyword(kw(6), { provider: "serper", apiKey: "k" });
    assert.equal(r.error, "serper: empty_serp");
    assert.equal("lastPosition" in lastUpdate(), false);
    assert.equal("lastSuccessfulCheckAt" in lastUpdate(), false);
  } finally { restore(); }
});

test("scrapingrobot captcha HTML keeps the previous rank", async () => {
  checks.length = 0; updates.length = 0;
  const restore = useFetch((body) => {
    if (body.module === "GoogleScraper") return { status: 503, json: { status: "ERROR", error: "503" } };
    return { status: 200, json: { status: "SUCCESS", result: "<html><body><form>consent</form></body></html>" } };
  });
  try {
    const r = await checkTrackedKeyword(kw(8), { provider: "scrapingrobot", apiKey: "k" });
    assert.equal(r.error, "scrapingrobot: empty_serp");
    assert.equal("lastPosition" in lastUpdate(), false);
    assert.equal("lastSuccessfulCheckAt" in lastUpdate(), false);
  } finally { restore(); }
});

test("scrapingrobot HTML with only a few links is not a successful empty SERP", async () => {
  const restore = useFetch((body) => {
    if (body.module === "GoogleScraper") return { status: 503, json: { status: "ERROR", error: "503" } };
    const links = [1, 2, 3].map(i => `<a href="https://thin-${i}.test/p"><h3>Thin ${i}</h3></a>`).join("");
    return { status: 200, json: { status: "SUCCESS", result: `<html><body>${links}</body></html>` } };
  });
  try {
    const r = await runSerp("scrapingrobot", "k", "taxi", { num: 10 });
    assert.equal(r.error, "scrapingrobot: empty_serp");
    assert.equal(r.results.length, 0);
  } finally { restore(); }
});

test("a full-depth scan that really misses the domain sets position null", async () => {
  checks.length = 0; updates.length = 0;
  const restore = useFetch((body) => {
    const page = Number(body.page ?? 1);
    return { status: 200, json: { organic: organic(10, page) } };
  });
  try {
    const r = await checkTrackedKeyword(kw(4), { provider: "serper", apiKey: "k" });
    assert.equal(r.error, undefined);
    assert.equal(r.position, null);
    assert.equal(lastUpdate().lastPosition, null);
    assert.ok(lastUpdate().lastSuccessfulCheckAt instanceof Date);
    assert.equal(checks.at(-1)?.error, null);
  } finally { restore(); }
});

test("a thin SERP does not clear a known rank", async () => {
  checks.length = 0; updates.length = 0;
  const restore = useFetch(() => ({ status: 200, json: { organic: organic(3, 1) } }));
  try {
    const r = await checkTrackedKeyword(kw(40), { provider: "serper", apiKey: "k" });
    assert.equal(r.error, "untrusted_not_found");
    assert.equal("lastPosition" in lastUpdate(), false);
    assert.equal(checks.at(-1)?.position, null);
    assert.match(String(checks.at(-1)?.error), /untrusted_not_found/);
  } finally { restore(); }
});
