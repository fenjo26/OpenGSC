import test from "node:test";
import assert from "node:assert/strict";
// Lives in src/lib/publish/ (not beside the adapter) because that is the directory the
// registered test:unit glob covers — package.json is off-limits to this wave.
import { normalizeWpBase, wordpressAdapter, type WpHttp, type WpResponse } from "./adapters/wordpress";

// The adapter is exercised against a fake HTTP layer (the transport seam in adapters/
// wordpress.ts). Mocking global fetch alone cannot reach the production paths: verify rides
// safeFetch, which speaks node:http directly, and publish's assertSafeTarget hop does live
// DNS — both wrong things to trigger from a unit test. The fake records what the adapter
// sent (URL, headers, body) and answers with a canned response, so these tests assert the
// adapter's contract, not the network's.

interface Seen { url: string; headers: Record<string, string>; body?: string }

function fakeHttp(reply: (seen: Seen) => WpResponse | Promise<WpResponse>): { http: WpHttp; calls: Seen[] } {
  const calls: Seen[] = [];
  const http: WpHttp = {
    async get(url, headers) { const s = { url, headers }; calls.push(s); return reply(s); },
    async post(url, headers, body) { const s = { url, headers, body }; calls.push(s); return reply(s); },
  };
  return { http, calls };
}

const CREDS = { username: "editor", appPassword: "abcd efgh ijkl mnop" };
const OK_USER: WpResponse = { status: 200, ok: true, json: { id: 2, name: "editor" }, text: "{}" };

test("normalizeWpBase accepts what an operator pastes", () => {
  assert.equal(normalizeWpBase("example.com"), "https://example.com");
  assert.equal(normalizeWpBase("https://example.com/"), "https://example.com");
  assert.equal(normalizeWpBase("https://example.com///"), "https://example.com");
  assert.equal(normalizeWpBase("https://example.com/wp-json"), "https://example.com");
  assert.equal(normalizeWpBase("https://example.com/wp-json/wp/v2"), "https://example.com");
  // An explicit http:// is kept as-is: silently upgrading could point a dev box at its prod.
  assert.equal(normalizeWpBase("http://staging.example.com/"), "http://staging.example.com");
  assert.equal(normalizeWpBase("   "), "");
});

test("verify success hits /wp-json/wp/v2/users/me with Basic auth", async () => {
  const { http, calls } = fakeHttp(() => OK_USER);
  await wordpressAdapter(http).verify(CREDS, "example.com");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.com/wp-json/wp/v2/users/me?context=edit");
  const expected = Buffer.from(`${CREDS.username}:${CREDS.appPassword}`).toString("base64");
  assert.equal(calls[0].headers.authorization, `Basic ${expected}`);
});

test("verify turns 401 into an authentication error naming the credentials", async () => {
  const { http } = fakeHttp(() => ({
    status: 401, ok: false,
    json: { code: "rest_cannot_access", message: "Sorry, you are not allowed to manage these items." },
    text: "",
  }));
  await assert.rejects(
    () => wordpressAdapter(http).verify(CREDS, "https://example.com"),
    /authentication rejected[\s\S]*application password/,
  );
});

test("verify turns 404 into an honest REST-API-not-found error", async () => {
  const { http } = fakeHttp(() => ({ status: 404, ok: false, json: { code: "rest_no_route", message: "No route was found matching the URL" }, text: "" }));
  await assert.rejects(
    () => wordpressAdapter(http).verify(CREDS, "example.com"),
    /REST API not found/,
  );
});

test("verify rejects a 200 that is not REST API data (front page HTML)", async () => {
  const { http } = fakeHttp(() => ({ status: 200, ok: true, text: "<!DOCTYPE html><html>…front page…" }));
  await assert.rejects(
    () => wordpressAdapter(http).verify(CREDS, "example.com"),
    /not with REST API user data/,
  );
});

test("verify rejects empty credentials before any request is made", async () => {
  const { http, calls } = fakeHttp(() => OK_USER);
  await assert.rejects(() => wordpressAdapter(http).verify({ username: "", appPassword: "" }, "example.com"), /username/);
  await assert.rejects(() => wordpressAdapter(http).verify({ username: "u", appPassword: "" }, "example.com"), /application password/);
  assert.equal(calls.length, 0, "no request should leave with unusable credentials");
});

test("publish success returns the remote id and link", async () => {
  const { http, calls } = fakeHttp(() => ({
    status: 201, ok: true,
    json: { id: 123, link: "https://example.com/?p=123" },
    text: "{}",
  }));
  const result = await wordpressAdapter(http).publish(CREDS, "example.com/", {
    title: "T", markdown: "# T", html: "<h1>T</h1>", tags: [],
  });
  assert.deepEqual(result, { remoteId: "123", remoteUrl: "https://example.com/?p=123" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.com/wp-json/wp/v2/posts");
  const body = JSON.parse(calls[0].body!);
  assert.deepEqual({ title: body.title, content: body.content, status: body.status }, {
    title: "T", content: "<h1>T</h1>", status: "publish",
  });
});

test("publish surfaces the WP error envelope verbatim", async () => {
  const { http } = fakeHttp(() => ({
    status: 400, ok: false,
    json: { code: "rest_invalid_param", message: "Invalid parameter(s): content" },
    text: "",
  }));
  await assert.rejects(
    () => wordpressAdapter(http).publish(CREDS, "example.com", { title: "T", markdown: "m", html: "<p>m</p>", tags: [] }),
    /rest_invalid_param: Invalid parameter\(s\): content/,
  );
});

test("publish fails honestly on a 200 without id/link", async () => {
  const { http } = fakeHttp(() => ({ status: 200, ok: true, json: { ok: true }, text: "{\"ok\":true}" }));
  await assert.rejects(
    () => wordpressAdapter(http).publish(CREDS, "example.com", { title: "T", markdown: "m", html: "<p>m</p>", tags: [] }),
    /without a post id\/link/,
  );
});
