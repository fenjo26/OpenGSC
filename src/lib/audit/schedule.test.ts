import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AUDIT_QUEUE_SETTINGS,
  parseAuditQueueSettings,
  parseSiteAuditSettings,
  siteIntervalDays,
  isSiteDue,
  effectiveAuditSchedule,
} from "./schedule";

const DAY = 86_400_000;
const now = Date.parse("2026-09-21T12:00:00.000Z");

test("queue settings: defaults for missing/garbage, clamping for out-of-range", () => {
  assert.deepEqual(parseAuditQueueSettings(null), DEFAULT_AUDIT_QUEUE_SETTINGS);
  assert.deepEqual(parseAuditQueueSettings("not json"), DEFAULT_AUDIT_QUEUE_SETTINGS);
  const s = parseAuditQueueSettings(JSON.stringify({ concurrency: 99, scheduleHourUtc: -3, retryAttempts: 0, paused: true }));
  assert.equal(s.concurrency, 16);   // clamped up, not rejected
  assert.equal(s.scheduleHourUtc, 0);
  assert.equal(s.retryAttempts, 0);
  assert.equal(s.paused, true);
});

test("site settings: off, custom (clamped), and the inherit fallback for garbage", () => {
  assert.deepEqual(parseSiteAuditSettings(JSON.stringify({ mode: "off" })), { mode: "off" });
  assert.deepEqual(parseSiteAuditSettings(JSON.stringify({ mode: "custom", intervalDays: 3 })), { mode: "custom", intervalDays: 3 });
  assert.deepEqual(parseSiteAuditSettings(JSON.stringify({ mode: "custom", intervalDays: 9999 })), { mode: "custom", intervalDays: 365 });
  assert.deepEqual(parseSiteAuditSettings("garbage"), { mode: "inherit" });
  assert.deepEqual(parseSiteAuditSettings(null), { mode: "inherit" });
});

test("effective interval: off wins, custom overrides, inherit takes the workspace default", () => {
  const q = { ...DEFAULT_AUDIT_QUEUE_SETTINGS, defaultIntervalDays: 7 };
  assert.equal(siteIntervalDays(JSON.stringify({ mode: "off" }), q), null);
  assert.equal(siteIntervalDays(JSON.stringify({ mode: "custom", intervalDays: 3 }), q), 3);
  assert.equal(siteIntervalDays(null, q), 7);
});

test("due: never-audited is due; in-flight is never due; finished gates the interval", () => {
  assert.equal(isSiteDue(null, 7, now), true);
  assert.equal(isSiteDue({ status: "running", finishedAt: null }, 7, now), false);
  assert.equal(isSiteDue({ status: "queued", finishedAt: null }, 7, now), false);
  // an error run still has finishedAt — it counts as an attempt, no per-tick retry storm
  assert.equal(isSiteDue({ status: "error", finishedAt: new Date(now - 8 * DAY) }, 7, now), true);
  assert.equal(isSiteDue({ status: "error", finishedAt: new Date(now - 2 * DAY) }, 7, now), false);
  assert.equal(isSiteDue({ status: "completed", finishedAt: new Date(now - 7 * DAY) }, 7, now), true);
  assert.equal(isSiteDue({ status: "completed", finishedAt: new Date(now - 7 * DAY + 60_000) }, 7, now), false);
  // string ISO dates (wire format) resolve the same as Dates
  assert.equal(isSiteDue({ status: "completed", finishedAt: new Date(now - 8 * DAY).toISOString() }, 7, now), true);
  // interval off → never due
  assert.equal(isSiteDue(null, 0, now), false);
});

test("effective schedule precedence: site cron > site interval > workspace cron > workspace interval", () => {
  const q = { ...DEFAULT_AUDIT_QUEUE_SETTINGS, defaultIntervalDays: 7, scheduleHourUtc: 3, defaultCron: "0 4 * * *" };
  // site cron wins over everything, including the workspace cron
  assert.deepEqual(
    effectiveAuditSchedule(JSON.stringify({ mode: "cron", cron: "30 2 * * *" }), q),
    { kind: "cron", expr: "30 2 * * *" });
  // site interval beats the workspace cron
  assert.deepEqual(
    effectiveAuditSchedule(JSON.stringify({ mode: "custom", intervalDays: 3 }), q),
    { kind: "interval", days: 3, hourUtc: 3 });
  // inherit follows the workspace cron when one is set
  assert.deepEqual(effectiveAuditSchedule(null, q), { kind: "cron", expr: "0 4 * * *" });
  // ...and the interval + hour when it isn't
  assert.deepEqual(
    effectiveAuditSchedule(null, { ...q, defaultCron: null }),
    { kind: "interval", days: 7, hourUtc: 3 });
  // off is off regardless of the workspace
  assert.deepEqual(effectiveAuditSchedule(JSON.stringify({ mode: "off" }), q), { kind: "off" });
  // an invalid stored cron is treated as absent — the site falls back to the workspace schedule
  assert.deepEqual(
    effectiveAuditSchedule(JSON.stringify({ mode: "cron", cron: "99 * * * *" }), q),
    { kind: "cron", expr: "0 4 * * *" });
});
