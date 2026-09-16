import { test } from "node:test";
import assert from "node:assert/strict";
import { isRetryable, pickRetryWave, RETRY_DELAY_MS, RETRY_MAX_ATTEMPTS, type RetryCandidate } from "./retry";

const at = (msAgo: number, now: number) => new Date(now - msAgo);

test("only transient problems are retried, and only up to the attempt cap", () => {
  assert.equal(isRetryable("aparser_blocked_or_empty", 1), true);
  assert.equal(isRetryable("aparser_parser_failed", 2), true);
  assert.equal(isRetryable("timeout", 1), true);
  assert.equal(isRetryable("aparser_blocked_or_empty", RETRY_MAX_ATTEMPTS), false);
  for (const p of ["suspicious_links", "no_creds", "provider_error", "short_result", null]) {
    assert.equal(isRetryable(p, 1), false, String(p));
  }
});

test("pickRetryWave waits out the proxy ban, oldest first, capped", () => {
  const now = 10_000_000;
  const c = (id: string, msAgo: number, problem: string | null = "aparser_blocked_or_empty", attempts = 1): RetryCandidate =>
    ({ snapshotId: id, keywordId: `k${id}`, problem, attempts, takenAt: at(msAgo, now) });
  const list = [
    c("fresh", 10_000),
    c("old", RETRY_DELAY_MS + 50_000),
    c("older", RETRY_DELAY_MS + 90_000),
    c("capped", RETRY_DELAY_MS + 99_000, "timeout", RETRY_MAX_ATTEMPTS),
    c("rejected", RETRY_DELAY_MS + 99_000, "suspicious_links"),
  ];
  const r = pickRetryWave(list, now, 16);
  assert.deepEqual(r.due.map((x) => x.snapshotId), ["older", "old"]);
  assert.equal(r.waiting, 1);
  assert.deepEqual(pickRetryWave(list, now, 1).due.map((x) => x.snapshotId), ["older"]);
  assert.deepEqual(pickRetryWave([], now, 16), { due: [], waiting: 0 });
});
