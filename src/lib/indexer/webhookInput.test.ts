import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWebhookBody, WEBHOOK_LIMITS } from "./webhookInput";

test("accepts the doorway's normal body", () => {
  const r = parseWebhookBody({ apiKey: "ckey123", url: "/a", ip: "1.2.3.4", userAgent: "Googlebot", statusCode: "200", botType: "Google" });
  assert.ok(r.ok);
  assert.equal(r.value.statusCode, 200);
  assert.equal(r.value.botType, "google");
  assert.equal(r.value.isRedirect, false);
});

test("fills defaults for absent optional fields", () => {
  const r = parseWebhookBody({ apiKey: "k" });
  assert.ok(r.ok);
  assert.deepEqual([r.value.url, r.value.ip, r.value.userAgent, r.value.referer], ["/", "0.0.0.0", "Unknown", null]);
});

test("a key that is not a plain bounded string is rejected", () => {
  for (const apiKey of [undefined, null, "", "   ", 42, true, [], ["k"], { a: 1 }, "x".repeat(WEBHOOK_LIMITS.apiKey + 1)]) {
    assert.equal(parseWebhookBody({ apiKey }).ok, false, `apiKey=${JSON.stringify(apiKey)}`);
  }
});

test("log fields only ever come out as bounded strings", () => {
  const r = parseWebhookBody({ apiKey: "k", url: { a: 1 }, ip: ["x"], referer: 5, userAgent: "u".repeat(5000) });
  assert.ok(r.ok);
  assert.equal(r.value.url, "/");
  assert.equal(r.value.ip, "0.0.0.0");
  assert.equal(r.value.referer, null);
  assert.equal(r.value.userAgent.length, WEBHOOK_LIMITS.userAgent);
});

test("status code falls back to 200 unless it is a real HTTP status", () => {
  for (const statusCode of ["abc", 99, 600, 200.5, "20x", "2000", {}]) {
    const r = parseWebhookBody({ apiKey: "k", statusCode });
    assert.ok(r.ok && r.value.statusCode === 200, String(statusCode));
  }
  const r = parseWebhookBody({ apiKey: "k", statusCode: 304 });
  assert.ok(r.ok && r.value.statusCode === 304);
});

test("isRedirect accepts the forms PHP json_encode produces", () => {
  for (const v of [true, 1, "1", "true"]) { const r = parseWebhookBody({ apiKey: "k", isRedirect: v }); assert.ok(r.ok && r.value.isRedirect); }
  for (const v of [false, 0, "", "yes", {}, undefined]) { const r = parseWebhookBody({ apiKey: "k", isRedirect: v }); assert.ok(r.ok && !r.value.isRedirect); }
});

test("non-object bodies are rejected", () => {
  for (const b of [null, "str", 1, []]) assert.equal(parseWebhookBody(b).ok, false);
});
