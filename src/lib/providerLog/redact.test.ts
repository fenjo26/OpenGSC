import { test } from "node:test";
import assert from "node:assert/strict";
import { BODY_MAX_CHARS, redact, safeEndpoint } from "./redact";

test("an Authorization header value never reaches the log", () => {
  // A log that captures the operator's own API keys is a worse problem than the one it was
  // switched on to solve.
  const out = redact({ headers: { Authorization: "Bearer sk-live-abcdef123456" } });
  assert.ok(!out.includes("sk-live-abcdef123456"));
  assert.match(out, /\[redacted\]/);
});

test("key-shaped fields are redacted wherever they sit in the body", () => {
  const out = redact({ nested: { apiKey: "abc123", api_key: "def456", password: "hunter2", token: "t0ken" } });
  for (const secret of ["abc123", "def456", "hunter2", "t0ken"]) assert.ok(!out.includes(secret), secret);
});

test("vendor key prefixes are caught even under an innocent field name", () => {
  const out = redact({ note: "use sk-proj-AAAABBBBCCCC when calling", other: "xai-1234567890abcdef" });
  assert.ok(!out.includes("sk-proj-AAAABBBBCCCC"));
  assert.ok(!out.includes("xai-1234567890abcdef"));
});

test("the content being debugged survives", () => {
  const out = redact({ messages: [{ role: "user", content: "write about blue widgets" }] });
  assert.match(out, /blue widgets/);
});

test("a body is truncated rather than allowed to write megabytes", () => {
  const out = redact({ big: "x".repeat(BODY_MAX_CHARS * 3) });
  assert.ok(out.length <= BODY_MAX_CHARS + 40, `got ${out.length}`);
  assert.match(out, /truncated/);
});

test("an endpoint keeps its origin and path and loses everything else", () => {
  // A query string is a routine place for a key to sit, and the path is all the log needs.
  assert.equal(safeEndpoint("https://api.example.com/v1/chat?key=SECRET#frag"), "https://api.example.com/v1/chat");
  assert.equal(safeEndpoint("https://user:pw@api.example.com/v1"), "https://api.example.com/v1");
  assert.equal(safeEndpoint("not a url"), "");
});

test("x-api-key is redacted, hyphenated header name and all", () => {
  // The literal header llm.ts sends for Anthropic and Anthropic-mode zai (llm.ts:401). The old
  // exact-word regex never matched a hyphenated compound like this.
  const out = redact({ headers: { "x-api-key": "z-api-9f3ac1d0b8e7f6a5c4d3e2b1a0918273" } });
  assert.ok(!out.includes("z-api-9f3ac1d0b8e7f6a5c4d3e2b1a0918273"));
  assert.match(out, /\[redacted\]/);
});

test("X-API-KEY, differently cased, is redacted the same way", () => {
  const out = redact({ headers: { "X-API-KEY": "z-api-9f3ac1d0b8e7f6a5c4d3e2b1a0918273" } });
  assert.ok(!out.includes("z-api-9f3ac1d0b8e7f6a5c4d3e2b1a0918273"));
  assert.match(out, /\[redacted\]/);
});

test("a bare z-api key under an innocent field name is redacted by its shape", () => {
  // Z.AI's own key format (see the z-api-... placeholder at src/app/settings/page.tsx:1142) was
  // missing from the vendor shape list entirely.
  const out = redact({ note: "use z-api-9f3ac1d0b8e7f6a5c4d3e2b1a0918273 when calling" });
  assert.ok(!out.includes("z-api-9f3ac1d0b8e7f6a5c4d3e2b1a0918273"));
});

test("a Google AIza key is redacted by its shape", () => {
  const out = redact({ note: "key is AIzaSyD4FakeGoogleApiKeyForTesting123" });
  assert.ok(!out.includes("AIzaSyD4FakeGoogleApiKeyForTesting123"));
});

test("cookies, plural, is redacted the same as cookie", () => {
  const out = redact({ cookies: "sessionid=abc123secret" });
  assert.ok(!out.includes("sessionid=abc123secret"));
  assert.match(out, /\[redacted\]/);
});

test("promptTokens and completionTokens survive — the guard against over-redacting", () => {
  // A careless "contains token" check would swallow the two numbers this feature exists to
  // record. They must come through untouched.
  const out = redact({ promptTokens: 1234, completionTokens: 5678 });
  assert.match(out, /"promptTokens":1234/);
  assert.match(out, /"completionTokens":5678/);
});
