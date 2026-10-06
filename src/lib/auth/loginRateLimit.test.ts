import assert from "node:assert/strict";
import test from "node:test";
import {
  LOGIN_ACCOUNT_FAILURES,
  LOGIN_IP_FAILURES,
  LOGIN_WINDOW_MS,
  LoginAttemptLimiter,
  clientIpFromHeaders,
  normalizeLoginEmail,
} from "./loginRateLimit";

const MINUTE = 60_000;

test("the credentials lockout is 5 failures per account and 20 per IP, over 15 minutes", () => {
  assert.equal(LOGIN_ACCOUNT_FAILURES, 5);
  assert.equal(LOGIN_IP_FAILURES, 20);
  assert.equal(LOGIN_WINDOW_MS, 15 * MINUTE);
});

test("client IP prefers CF-Connecting-IP over a client-supplied forwarded chain", () => {
  const headers = {
    "CF-Connecting-IP": "203.0.113.9",
    "X-Forwarded-For": "198.51.100.2, 10.0.0.1",
    "X-Real-IP": "192.0.2.5",
  };
  assert.equal(clientIpFromHeaders(headers), "203.0.113.9");
});

test("client IP uses the first forwarded hop only when Cloudflare did not set one", () => {
  assert.equal(clientIpFromHeaders({ "x-forwarded-for": "198.51.100.7, 10.1.1.1" }), "198.51.100.7");
  assert.equal(clientIpFromHeaders({ "x-real-ip": "192.0.2.8" }), "192.0.2.8");
  const web = new Headers();
  web.set("cf-connecting-ip", "2001:db8::1");
  assert.equal(clientIpFromHeaders(web), "2001:db8::1");
  assert.equal(clientIpFromHeaders({ "x-forwarded-for": ["203.0.113.4", "10.0.0.1"] }), "203.0.113.4");
  assert.equal(clientIpFromHeaders(undefined), "unknown");
  assert.equal(clientIpFromHeaders({ "cf-connecting-ip": "bad value" }), "unknown");
});

test("five wrong passwords lock the account from any later address", () => {
  const clock = { now: 1_000_000 };
  const limiter = new LoginAttemptLimiter({ now: () => clock.now });
  for (let i = 0; i < LOGIN_ACCOUNT_FAILURES; i++) {
    const attempt = limiter.begin("203.0.113.1", "Owner@Example.com");
    assert.equal(attempt.allowed, true, `attempt ${i + 1}`);
  }
  const locked = limiter.begin("198.51.100.50", "owner@example.com");
  assert.equal(locked.allowed, false);
  assert.equal(locked.scope, "account");
  assert.equal(locked.stamp, null);
  assert.ok(locked.retryAfterMs > 0);

  // A refusal must not push the window out. One millisecond after it expires, a guess is allowed.
  clock.now += LOGIN_WINDOW_MS + 1;
  assert.equal(limiter.begin("198.51.100.50", "owner@example.com").allowed, true);
});

test("twenty failures from one IP lock that address across accounts", () => {
  const limiter = new LoginAttemptLimiter({ now: () => 5_000_000 });
  for (let i = 0; i < LOGIN_IP_FAILURES; i++) {
    assert.equal(limiter.begin("203.0.113.9", `user${i}@example.com`).allowed, true);
  }
  const locked = limiter.begin("203.0.113.9", "fresh@example.com");
  assert.equal(locked.allowed, false);
  assert.equal(locked.scope, "ip");
  // A different address still has its own budget for that fresh account.
  assert.equal(limiter.begin("198.51.100.9", "fresh@example.com").allowed, true);
});

test("a correct password clears the account but not other failures from the same IP", () => {
  const limiter = new LoginAttemptLimiter({ accountFailures: 3, ipFailures: 10, now: () => 8_000_000 });
  assert.equal(limiter.begin("203.0.113.1", "a@example.com").allowed, true);
  assert.equal(limiter.begin("203.0.113.1", "a@example.com").allowed, true);
  const reserved = limiter.begin("203.0.113.1", "owner@example.com");
  assert.equal(reserved.allowed, true);
  limiter.succeed("203.0.113.1", "owner@example.com", reserved.stamp!);

  // The account starts over. The IP still remembers the two earlier failures plus nothing for
  // the success — nine of its ten slots remain, and the two account failures are gone.
  assert.equal(limiter.begin("203.0.113.1", "owner@example.com").allowed, true);
  assert.equal(limiter.begin("203.0.113.1", "owner@example.com").allowed, true);
  assert.equal(limiter.begin("203.0.113.1", "owner@example.com").allowed, true);
  assert.equal(limiter.begin("203.0.113.1", "owner@example.com").scope, "account");
});

test("reservations count before the password check, so parallel guesses share one budget", () => {
  const limiter = new LoginAttemptLimiter({ accountFailures: 2, now: () => 9_000_000 });
  const first = limiter.begin("203.0.113.1", "a@example.com");
  const second = limiter.begin("203.0.113.1", "a@example.com");
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(limiter.begin("203.0.113.2", "a@example.com").allowed, false);
});

test("callers without an address share one bucket", () => {
  const limiter = new LoginAttemptLimiter({ ipFailures: 2, accountFailures: 10, now: () => 3_000_000 });
  assert.equal(limiter.begin("unknown", "a@example.com").allowed, true);
  assert.equal(limiter.begin("unknown", "b@example.com").allowed, true);
  assert.equal(limiter.begin("unknown", "c@example.com").scope, "ip");
});

test("normalizeLoginEmail folds case and drops surrounding space", () => {
  assert.equal(normalizeLoginEmail("  Owner@Example.com "), "owner@example.com");
});
