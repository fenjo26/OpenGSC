import { test } from "node:test";
import assert from "node:assert/strict";
import { serpConfigReady, serpCredsReady, serpProviderNeedsKey } from "./serpReadiness";

test("SearXNG is the only keyless provider", () => {
  assert.equal(serpProviderNeedsKey("searxng"), false);
  assert.equal(serpProviderNeedsKey("serper"), true);
  assert.equal(serpProviderNeedsKey("dataforseo"), true);
  assert.equal(serpProviderNeedsKey("aparser"), true);
});

test("serpConfigReady accepts SearXNG without a key and still requires keys elsewhere", () => {
  assert.equal(serpConfigReady("searxng", ""), true);
  assert.equal(serpConfigReady("searxng", undefined), true);
  assert.equal(serpConfigReady("serper", ""), false);
  assert.equal(serpConfigReady("serper", "  "), false);
  assert.equal(serpConfigReady("serper", "sp-key"), true);
});

test("serpCredsReady mirrors the credential shape used by the browser", () => {
  assert.equal(serpCredsReady({ provider: "searxng", apiKey: "" }), true);
  assert.equal(serpCredsReady({ provider: "dataforseo" }), false);
  assert.equal(serpCredsReady({ provider: "dataforseo", apiKey: "login:pass" }), true);
});
