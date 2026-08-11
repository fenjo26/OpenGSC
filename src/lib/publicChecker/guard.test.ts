import test from "node:test";
import assert from "node:assert/strict";
import { anonymizedClientKey, publicCacheKey, takePublicCheckRate, withPublicCheckCache } from "./guard";

test("public checker keeps only anonymized, stable keys", () => {
  const key = anonymizedClientKey("203.0.113.8");
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key.includes("203.0.113.8"), false);
  assert.equal(publicCacheKey("Example.COM"), publicCacheKey("example.com"));
});

test("public checker rate limit resets after its bounded window", () => {
  const key = `test-${Date.now()}-${Math.random()}`;
  for (let i = 0; i < 5; i++) assert.equal(takePublicCheckRate(key, 1_000 + i).ok, true);
  assert.equal(takePublicCheckRate(key, 2_000).ok, false);
  assert.equal(takePublicCheckRate(key, 1_000 + 10 * 60_000).ok, true);
});

test("public checker coalesces and caches identical domain work", async () => {
  const key = `cache-${Date.now()}-${Math.random()}`;
  let calls = 0;
  const run = async () => { calls++; return { ok: true }; };
  const [a, b] = await Promise.all([withPublicCheckCache(key, run), withPublicCheckCache(key, run)]);
  assert.equal(calls, 1);
  assert.equal(a.value.ok, true);
  assert.equal(b.value.ok, true);
  assert.equal((await withPublicCheckCache(key, run)).cached, true);
});
