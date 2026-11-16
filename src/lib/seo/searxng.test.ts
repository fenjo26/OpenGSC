import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSearxngParams,
  clearSearxngCache,
  normalizeSearxngResponse,
  searxngSearch,
  searxngStatus,
} from "./searxng";

const BASE = "http://searx.test:8080";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

function payload(results: unknown[], unresponsive: unknown[] = []): Record<string, unknown> {
  return { results, unresponsive_engines: unresponsive };
}

function resetEnv(): void {
  process.env.SEARXNG_BASE_URL = BASE;
  process.env.SEARXNG_ENGINES = "bing,google cse";
  process.env.SEARXNG_FALLBACK_ENGINES = "duckduckgo";
  process.env.SEARXNG_CACHE_TTL_MS = "300000";
  clearSearxngCache();
}

test("buildSearxngParams maps the parameters SearXNG actually supports", () => {
  resetEnv();
  const params = buildSearxngParams(
    "أفضل مستشفى في الرياض",
    { gl: "sa", hl: "ar", num: 10, safesearch: 2, timeRange: "month", categories: "general" },
    ["bing", "google cse"],
  );
  assert.equal(params.q, "أفضل مستشفى في الرياض");
  assert.equal(params.format, "json");
  assert.equal(params.language, "ar");
  assert.equal(params.safesearch, "2");
  assert.equal(params.time_range, "month");
  assert.equal(params.categories, "general");
  assert.equal(params.engines, "bing,google cse");
  assert.equal(params.pageno, "1");
  // Not offered: country and result count. They must not be invented as no-op params.
  assert.equal("gl" in params, false);
  assert.equal("num" in params, false);
});

test("buildSearxngParams falls back to the country's language when hl is absent", () => {
  resetEnv();
  const params = buildSearxngParams("τι είναι seo", { gl: "gr" }, []);
  assert.equal(params.language, "el");
});

test("normalizeSearxngResponse dedupes, drops non-http rows and keeps engine provenance", () => {
  const { results, unresponsive } = normalizeSearxngResponse(
    payload(
      [
        { url: "https://a.example/x", title: " A <b>title</b> ", content: "Snip &amp; text", engines: ["bing", "brave"], score: 3.5 },
        { url: "https://a.example/x/", title: "duplicate", content: "", engines: ["bing"] },
        { url: "ftp://bad.example/file", title: "nope", content: "" },
        { url: "https://b.example/y", title: "B", content: "  ", engine: "google cse" },
      ],
      [["duckduckgo", "CAPTCHA"]],
    ),
    10,
  );
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((row) => [row.position, row.domain, row.engine]),
    [
      [1, "a.example", "bing"],
      [2, "b.example", "google cse"],
    ],
  );
  assert.deepEqual(results[0].engines, ["bing", "brave"]);
  assert.equal(results[0].score, 3.5);
  assert.equal(results[0].title, "A title");
  assert.equal(results[0].snippet, "Snip & text");
  assert.deepEqual(unresponsive, [{ engine: "duckduckgo", error: "CAPTCHA" }]);
});

test("searxngSearch returns normalized results, slices to num and caches the answer", async () => {
  resetEnv();
  let calls = 0;
  const rows = Array.from({ length: 8 }, (_, index) => ({
    url: `https://site${index}.example/page`,
    title: `Title ${index}`,
    content: `Snippet ${index}`,
    engines: ["bing"],
    score: 10 - index,
  }));
  const fetchImpl = fakeFetch(() => {
    calls += 1;
    return jsonResponse(payload(rows));
  });

  const first = await searxngSearch("", "best seo tools", { gl: "us", hl: "en", num: 5 }, { fetchImpl });
  assert.equal(first.error, undefined);
  assert.equal(first.provider, "searxng");
  assert.equal(first.results.length, 5);
  assert.equal(first.results[0].position, 1);
  assert.equal(first.results[4].position, 5);
  assert.deepEqual(first.engines, ["bing", "google cse"]);
  assert.equal(first.cached, false);

  const second = await searxngSearch("", "best seo tools", { gl: "us", hl: "en", num: 5 }, { fetchImpl });
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test("searxngSearch reports a disabled JSON API as a specific error", async () => {
  resetEnv();
  const fetchImpl = fakeFetch(() => jsonResponse("Forbidden", 403));
  const result = await searxngSearch("", "query", { num: 10 }, { fetchImpl });
  assert.equal(result.error, "searxng_forbidden");
  assert.match(result.errorDetail ?? "", /HTTP 403/);
  assert.deepEqual(result.results, []);
});

test("searxngSearch rejects a non-JSON answer instead of inventing results", async () => {
  resetEnv();
  const fetchImpl = fakeFetch(() => new Response("<html>not json</html>", { status: 200 }));
  const result = await searxngSearch("", "query", { num: 10 }, { fetchImpl });
  assert.equal(result.error, "searxng_invalid_json");
  assert.deepEqual(result.results, []);
});

test("searxngSearch names the engines when all of them are unavailable", async () => {
  resetEnv();
  const fetchImpl = fakeFetch(() => jsonResponse(payload([], [["bing", "access denied"], ["google cse", "timeout"]])));
  const result = await searxngSearch("", "query", { num: 10, engine: "bing" }, { fetchImpl });
  assert.equal(result.error, "searxng_engines_unavailable");
  assert.match(result.errorDetail ?? "", /bing: access denied/);
  assert.match(result.errorDetail ?? "", /google cse: timeout/);
  assert.deepEqual(result.results, []);
});

test("searxngSearch retries sparse answers on the fallback engines only", async () => {
  resetEnv();
  const bodies: string[] = [];
  const fetchImpl = fakeFetch((_url, init) => {
    const body = String((init?.body as URLSearchParams).toString());
    bodies.push(body);
    if (body.includes("engines=duckduckgo")) {
      return jsonResponse(payload([{ url: "https://fallback.example/", title: "Fallback", content: "hit", engines: ["duckduckgo"] }]));
    }
    return jsonResponse(payload([]));
  });
  const result = await searxngSearch("", "obscure query", { num: 10 }, { fetchImpl });
  assert.equal(result.error, undefined);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].domain, "fallback.example");
  assert.equal(result.engines?.includes("duckduckgo"), true);
  assert.equal(bodies.length, 2);
});

test("searxngSearch classifies timeouts without returning results", async () => {
  resetEnv();
  const fetchImpl = fakeFetch(() => {
    throw new DOMException("The operation timed out", "TimeoutError");
  });
  const result = await searxngSearch("", "query", { num: 10, engine: "bing" }, { fetchImpl });
  assert.equal(result.error, "searxng_timeout");
  assert.deepEqual(result.results, []);
});

test("searxngStatus requires a real search that returns results", async () => {
  resetEnv();
  const good = fakeFetch(() =>
    jsonResponse(payload([{ url: "https://example.com/", title: "Example", content: "ok", engines: ["bing"] }])),
  );
  const healthy = await searxngStatus({ fetchImpl: good, bypassCache: true });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.resultCount, 1);
  assert.equal(healthy.baseUrl, "searx.test:8080");
  assert.equal(healthy.cached, undefined);

  clearSearxngCache();
  const bad = fakeFetch(() => jsonResponse(payload([])));
  const unhealthy = await searxngStatus({ fetchImpl: bad, bypassCache: true });
  assert.equal(unhealthy.ok, false);
  assert.equal(unhealthy.error, "searxng_no_results");
});
