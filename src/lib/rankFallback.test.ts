import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWithFallback, isTransientRankError, type RankAttempt } from "./rankFallback";

const ok = (provider: string, position: number | null = 5): RankAttempt => ({ position, url: position ? "https://a.gr/" : null, depth: 100, provider });
const err = (provider: string, error: string): RankAttempt => ({ position: null, url: null, depth: 100, provider, error });
const noSleep = { sleep: async () => {} };

function script(answers: RankAttempt[]) {
  const calls: string[] = [];
  const run = async (p: string) => { calls.push(p); const a = answers.shift(); if (!a) throw new Error("unexpected call"); return a; };
  return { run, calls };
}

test("transient classification", () => {
  for (const e of [
    "aparser: aparser_blocked_or_empty · captcha 4",
    "aparser: aparser_partial_serp (stopped before the requested depth)",
    "scrapingrobot: Could not complete the request successfully. Please try again later",
    "scrapingrobot: non-JSON response (503)",
    "сеть A-Parser (127.0.0.1:9091): timeout",
  ]) assert.equal(isTransientRankError(e), true, e);
  for (const e of ["aparser: {\"msg\":\"Auth failed\"}", "no_serp_key", "scrapingrobot: No data found", "", null]) {
    assert.equal(isTransientRankError(e), false, String(e));
  }
});

test("success first time: one call", async () => {
  const s = script([ok("aparser")]);
  const r = await checkWithFallback(s.run, "aparser", "scrapingrobot", noSleep);
  assert.deepEqual(s.calls, ["aparser"]);
  assert.equal(r.position, 5);
  assert.equal(r.attempts, 1);
});

test("a not-found answer is an answer — no fallback", async () => {
  const s = script([ok("aparser", null)]);
  const r = await checkWithFallback(s.run, "aparser", "scrapingrobot", noSleep);
  assert.deepEqual(s.calls, ["aparser"]);
  assert.equal(r.error, undefined);
  assert.equal(r.position, null);
});

test("transient error: retried once, then the fallback answers", async () => {
  const s = script([err("aparser", "aparser_blocked_or_empty"), err("aparser", "aparser_blocked_or_empty"), ok("scrapingrobot", 8)]);
  const r = await checkWithFallback(s.run, "aparser", "scrapingrobot", noSleep);
  assert.deepEqual(s.calls, ["aparser", "aparser", "scrapingrobot"]);
  assert.equal(r.provider, "scrapingrobot");
  assert.equal(r.position, 8);
  assert.equal(r.primaryError, "aparser_blocked_or_empty");
  assert.equal(r.attempts, 3);
});

test("transient error cured by the retry does not touch the fallback", async () => {
  const s = script([err("scrapingrobot", "Please try again later"), ok("scrapingrobot", 3)]);
  const r = await checkWithFallback(s.run, "scrapingrobot", "aparser", noSleep);
  assert.deepEqual(s.calls, ["scrapingrobot", "scrapingrobot"]);
  assert.equal(r.position, 3);
});

test("permanent error skips the retry and goes straight to the fallback", async () => {
  const s = script([err("aparser", "aparser: Auth failed"), ok("serper", 1)]);
  const r = await checkWithFallback(s.run, "aparser", "serper", noSleep);
  assert.deepEqual(s.calls, ["aparser", "serper"]);
  assert.equal(r.provider, "serper");
});

test("both fail: the stored error names both, the provider stays the primary", async () => {
  const s = script([err("aparser", "aparser: Auth failed"), err("scrapingrobot", "scrapingrobot: No data found")]);
  const r = await checkWithFallback(s.run, "aparser", "scrapingrobot", noSleep);
  assert.equal(r.provider, "aparser");
  assert.equal(r.error, "aparser: Auth failed → scrapingrobot: scrapingrobot: No data found");
});

test("no fallback configured: the primary error is stored as is", async () => {
  const s = script([err("aparser", "aparser_blocked_or_empty"), err("aparser", "aparser_blocked_or_empty")]);
  const r = await checkWithFallback(s.run, "aparser", null, noSleep);
  assert.equal(r.error, "aparser_blocked_or_empty");
  assert.equal(r.attempts, 2);
});
