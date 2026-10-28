import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifySyncError,
  errorText,
  sanitizeSyncError,
  summarizeSyncFailure,
  scheduledRunFailed,
  nextSyncHealth,
  lastSuccessState,
  formatLastSuccessStamp,
  formatSyncFailureAlert,
  formatSyncRecoveryAlert,
  GSC_SYNC_STALE_MS,
} from "./gscSyncHealth";

test("invalid_grant on the message is a reauth failure", () => {
  assert.equal(classifySyncError("invalid_grant"), "reauth");
  assert.equal(
    classifySyncError("Token has been expired or revoked."),
    "reauth",
  );
});

test("a 400 whose body is invalid_grant is still reauth", () => {
  const text = errorText({
    message: "Request failed with status code 400",
    response: { data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } },
  });
  assert.match(text, /invalid_grant/);
  assert.equal(classifySyncError(text), "reauth");
  assert.equal(sanitizeSyncError(text), "Google authorization expired or was revoked.");
});

test("quota and network are named, and a stack is not shown", () => {
  assert.equal(classifySyncError("Quota exceeded for quota metric"), "quota");
  assert.equal(classifySyncError("connect ETIMEDOUT 142.250.1.1"), "network");
  const messy = "something broke\n    at sync (/app/src/lib/gscSync.ts:204:15)\n    at processTicksAndRejections";
  const clean = sanitizeSyncError(messy);
  assert.equal(clean, "something broke");
  assert.doesNotMatch(clean, /gscSync\.ts/);
});

test("summarize prefers reauth over a quota error on another site", () => {
  const s = summarizeSyncFailure({
    accountErrors: [{ error: "invalid_grant", needsReauth: true, kind: "reauth" }],
    siteErrors: [{ site: "wakeloom.com", error: "quota", kind: "quota" }],
  });
  assert.equal(s.needsReauth, true);
  assert.equal(s.failureKind, "reauth");
  assert.deepEqual(s.sites, ["wakeloom.com"]);
});

test("an empty run is not a scheduled failure", () => {
  assert.equal(scheduledRunFailed({}), false);
  assert.equal(scheduledRunFailed(null), false);
  assert.equal(scheduledRunFailed({ accountErrors: [{ error: "x" }] }), true);
  assert.equal(scheduledRunFailed({ siteErrors: [{ site: "a.com" }] }), true);
});

test("telegram fires once on the second consecutive failure, then on recovery", () => {
  const fresh = { consecutiveFailures: 0, alerted: false };
  const first = nextSyncHealth(fresh, true);
  assert.equal(first.sendAlert, false);
  assert.equal(first.health.consecutiveFailures, 1);

  const second = nextSyncHealth(first.health, true);
  assert.equal(second.sendAlert, true);
  assert.equal(second.health.alerted, false, "delivery, not the plan, marks the streak as alerted");

  const delivered = { ...second.health, alerted: true };
  const third = nextSyncHealth(delivered, true);
  assert.equal(third.sendAlert, false);
  assert.equal(third.health.consecutiveFailures, 3);

  const recovered = nextSyncHealth(delivered, false);
  assert.equal(recovered.sendRecovery, true);
  assert.equal(recovered.sendAlert, false);
  assert.deepEqual(recovered.health, { consecutiveFailures: 0, alerted: false });

  const quiet = nextSyncHealth(first.health, false);
  assert.equal(quiet.sendRecovery, false);
});

test("staleness uses the success timestamp, and 48h is the line", () => {
  const now = Date.parse("2026-10-28T01:14:00.000Z");
  assert.equal(lastSuccessState(null, now), "never");
  assert.equal(lastSuccessState("", now), "never");
  assert.equal(lastSuccessState("not-a-date", now), "never");
  assert.equal(lastSuccessState(new Date(now - GSC_SYNC_STALE_MS), now), "fresh");
  assert.equal(lastSuccessState(new Date(now - GSC_SYNC_STALE_MS - 1), now), "stale");
  // A metric date three days behind must not be passed in. The helper only sees the instant
  // the caller gives it — the sync column, not DailyMetric.date.
  assert.equal(lastSuccessState(new Date(now - 3 * 24 * 60 * 60 * 1000), now), "stale");
});

test("the badge clock is UTC+8, not the metric date", () => {
  // 2026-10-21 01:14 UTC is 09:14 in Asia/Shanghai — the cron hour in the report.
  assert.equal(formatLastSuccessStamp(new Date("2026-10-21T01:14:00.000Z")), "10-21 09:14");
});

test("the failure alert names the site, the cause, and the reauth step, in Chinese and English", () => {
  const zh = formatSyncFailureAlert("zh", {
    sites: ["wakeloom.com", "example.com"],
    kind: "reauth",
    consecutive: 2,
  });
  assert.match(zh, /连续失败 2 次/);
  assert.match(zh, /wakeloom\.com/);
  assert.match(zh, /example\.com/);
  assert.match(zh, /授权已失效/);
  assert.match(zh, /重新授权/);
  assert.doesNotMatch(zh, /at\s+\//);

  const en = formatSyncFailureAlert("en", { sites: [], kind: "reauth", consecutive: 2 });
  assert.match(en, /invalid_grant/);
  assert.match(en, /none could be listed/);
  assert.match(en, /Re-authorize/);

  const back = formatSyncRecoveryAlert("zh");
  assert.match(back, /已恢复/);
});
