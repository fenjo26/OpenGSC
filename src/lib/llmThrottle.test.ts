import { test } from "node:test";
import assert from "node:assert/strict";
import { isRateLimited, isQuotaExhausted, noteRateLimited, getLLMThrottleState, setLLMKeyConcurrency } from "./llm";

test("Z.AI 1302 is a rate limit, 1113/1308 are quota", () => {
  assert.equal(isRateLimited("zai 429: [1302][Rate limit reached for requests]"), true);
  assert.equal(isQuotaExhausted("zai 429: [1302][Rate limit reached for requests]"), false);
  assert.equal(isQuotaExhausted("zai 429: [1113] Insufficient balance or no resource package"), true);
  assert.equal(isRateLimited("zai 429: [1308] Usage limit reached for 5 hour"), false);
  assert.equal(isRateLimited("zai 500: boom"), false);
});

test("a 429 halves the key's concurrency and starts a cooldown", () => {
  setLLMKeyConcurrency(8);
  noteRateLimited("testprov", "k1", 5_000);
  const st = getLLMThrottleState().find(x => x.provider === "testprov");
  assert.ok(st);
  assert.ok(st!.cap >= 1 && st!.cap <= 4, `cap ${st!.cap}`);
  assert.ok(st!.cooldownSec > 0);
});
