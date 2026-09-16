import { test } from "node:test";
import assert from "node:assert/strict";
import { aparserOneRequest, isMissingConfigPreset } from "../seo/aparser";
import { describeAparserRow } from "../seo/aparserSerp";

test("isMissingConfigPreset recognises A-Parser's message, with or without the transport prefix", () => {
  assert.equal(isMissingConfigPreset(`aparser: {"msg":"configPreset 'my' not exists","success":0}`), true);
  assert.equal(isMissingConfigPreset("configPreset 'x' not exist"), true);
  assert.equal(isMissingConfigPreset(`aparser: {"msg":"Auth failed","success":0}`), false);
  assert.equal(isMissingConfigPreset(undefined), false);
});

test("a missing thread config is retried once with default", async () => {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push(body.data.configPreset);
    const payload = body.data.configPreset === "default"
      ? { success: 1, data: { results: [{ success: 1, serp: [] }] } }
      : { success: 0, data: "configPreset 'my' not exists" };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await aparserOneRequest({ baseUrl: "http://127.0.0.1:9091", password: "p", configPreset: "my" }, "SE::Google", "q");
    assert.ok(r.data);
    assert.deepEqual(sent, ["my", "default"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("other failures are not retried", async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ success: 0, data: "Auth failed" }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await aparserOneRequest({ baseUrl: "http://127.0.0.1:9091", password: "p", configPreset: "my" }, "SE::Google", "q");
    assert.equal(r.data, null);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("describeAparserRow shows shape and log tail, never content", () => {
  const d = describeAparserRow(
    { success: 1, query: "nv casino", serp: [], totalcount: "", info: { a: 1 } },
    [[1, "Proxy 1.2.3.4 captcha"], "retry 3/3 exhausted"],
  );
  assert.match(d, /keys: success=1, query, serp\[0\], totalcount=, info\{\}/);
  assert.match(d, /log: 1 Proxy 1\.2\.3\.4 captcha \| retry 3\/3 exhausted/);
  assert.equal(describeAparserRow(null, undefined), "results[0]: absent");
  assert.ok(describeAparserRow({ k: 1 }, Array(50).fill("x".repeat(100)), 100).length <= 101);
});
