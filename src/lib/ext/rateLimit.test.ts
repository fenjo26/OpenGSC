import assert from "node:assert/strict";
import test from "node:test";
import { EXT_RATE_LIMIT_PER_MIN, SlidingWindowRateLimiter } from "./rateLimit";

// N11 — the /api/ext rate limit: 60 requests per minute per token
// (docs/tasks/wave-nov/N11-browser-extension.md). Sliding window, clock injected.

const MIN = 60_000;

test("the limit the routes use is the brief's 60 per minute", () => {
  assert.equal(EXT_RATE_LIMIT_PER_MIN, 60);
});

test("allows 60 hits, denies the 61st, allows again once the window slides", () => {
  const limiter = new SlidingWindowRateLimiter(60, MIN);
  const t0 = 1_000_000;
  for (let i = 0; i < 60; i++) {
    assert.equal(limiter.hit("token-a", t0 + i).allowed, true, `hit ${i + 1}`);
  }
  const denied = limiter.hit("token-a", t0 + 60);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs > 0, true); // tells the 429's Retry-After

  // The first hit leaves the window one millisecond after t0 + MIN.
  const back = limiter.hit("token-a", t0 + MIN + 1);
  assert.equal(back.allowed, true);
});

test("denied hits still count — a tight retry loop cannot outpace the window", () => {
  const limiter = new SlidingWindowRateLimiter(3, MIN);
  const t0 = 5_000_000;
  for (let i = 0; i < 3; i++) assert.equal(limiter.hit("k", t0).allowed, true);
  assert.equal(limiter.hit("k", t0 + 1).allowed, false);
  assert.equal(limiter.hit("k", t0 + 2).allowed, false);
  // still 3 in-window hits; the denials added nothing and the window must still expire
  assert.equal(limiter.hit("k", t0 + MIN + 10).allowed, true);
});

test("tokens are independent keys", () => {
  const limiter = new SlidingWindowRateLimiter(2, MIN);
  const t0 = 9_000_000;
  assert.equal(limiter.hit("a", t0).allowed, true);
  assert.equal(limiter.hit("a", t0).allowed, true);
  assert.equal(limiter.hit("a", t0).allowed, false);
  assert.equal(limiter.hit("b", t0).allowed, true); // the other token's budget is its own
});

test("prune drops keys whose window emptied, so revoked tokens don't accumulate", () => {
  const limiter = new SlidingWindowRateLimiter(2, MIN);
  const t0 = 2_000_000;
  limiter.hit("gone", t0);
  limiter.prune(t0 + MIN * 2); // past the window → prune sweeps
  assert.equal(limiter.load("gone", t0 + MIN * 2), 0);
});
