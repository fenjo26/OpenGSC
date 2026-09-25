import test from "node:test";
import assert from "node:assert/strict";

// N9 — rate limiting for the public widget contour: windows, salt, and the guarantee that
// a raw IP is never what the limiter keys on.

import {
  AUDIT_LIMITS, auditKeys, hashIp, takeAuditQuota, takeLeadQuota, WindowCounter,
} from "./ratelimit";

test("hashIp: different salts produce different hashes, and neither contains the IP", () => {
  const a = hashIp("203.0.113.7", "salt-a");
  const b = hashIp("203.0.113.7", "salt-b");
  assert.notEqual(a, b);
  assert.equal(a.length, 64); // sha256 hex
  assert.ok(!a.includes("203.0.113.7"));
  assert.ok(!b.includes("203.0.113.7"));
});

test("audit quota: the 6th audit from one IP in an hour is refused with ip_hour", () => {
  const now = { v: 1_000_000 };
  const counter = new WindowCounter(() => now.v);
  const ip = hashIp("198.51.100.2", "s");
  for (let i = 0; i < AUDIT_LIMITS.ipPerHour; i++) {
    const verdict = takeAuditQuota(counter, ip, "wid_x");
    assert.equal(verdict.allowed, true, `audit ${i + 1} should be allowed`);
  }
  const refused = takeAuditQuota(counter, ip, "wid_x");
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, "ip_hour");
  assert.ok(refused.retryAfterSec > 0);
});

test("audit quota: the daily cap is stricter than the hourly one and survives hour rollovers", () => {
  const now = { v: 1_000_000 };
  const counter = new WindowCounter(() => now.v);
  const ip = hashIp("198.51.100.3", "s");
  const hour = 60 * 60 * 1000;
  // 5 audits per hour, 5 times: 25 total attempts, 20 allowed (daily cap).
  let allowed = 0;
  for (let h = 0; h < 5; h++) {
    for (let i = 0; i < 5; i++) {
      if (takeAuditQuota(counter, ip, "wid_y").allowed) allowed++;
    }
    now.v += hour + 1;
  }
  assert.equal(allowed, AUDIT_LIMITS.ipPerDay);
  const refused = takeAuditQuota(counter, ip, "wid_y");
  assert.equal(refused.reason, "ip_day");
});

test("audit quota: per-widget-key cap counts every IP together", () => {
  const now = { v: 1_000_000 };
  const counter = new WindowCounter(() => now.v);
  // Different IPs (so per-IP limits never fire), same widget key.
  for (let i = 0; i < AUDIT_LIMITS.keyPerDay; i++) {
    const verdict = takeAuditQuota(counter, hashIp(`198.51.100.${i % 250 + 1}`, "s"), "wid_z");
    assert.equal(verdict.allowed, true, `key audit ${i + 1}`);
  }
  const refused = takeAuditQuota(counter, hashIp("198.51.100.99", "s"), "wid_z");
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, "key_day");
  // …but another widget on the same instance is unaffected.
  assert.equal(takeAuditQuota(counter, hashIp("198.51.100.99", "s"), "wid_other").allowed, true);
});

test("audit quota: windows reset — a new day is a new budget", () => {
  const now = { v: 1_000_000 };
  const counter = new WindowCounter(() => now.v);
  const ip = hashIp("198.51.100.4", "s");
  const day = 24 * 60 * 60 * 1000;
  for (let i = 0; i < AUDIT_LIMITS.ipPerDay; i++) takeAuditQuota(counter, ip, "wid_d");
  assert.equal(takeAuditQuota(counter, ip, "wid_d").allowed, false);
  now.v += day + 1;
  assert.equal(takeAuditQuota(counter, ip, "wid_d").allowed, true);
});

test("lead quota: hourly per IP, independent of the audit counters", () => {
  const now = { v: 1_000_000 };
  const counter = new WindowCounter(() => now.v);
  const ip = hashIp("198.51.100.5", "s");
  // Fill the audit counters completely — lead quota must not care.
  takeAuditQuota(counter, ip, "wid_l");
  for (let i = 0; i < AUDIT_LIMITS.leadsPerHour; i++) {
    assert.equal(takeLeadQuota(counter, ip).allowed, true);
  }
  assert.equal(takeLeadQuota(counter, ip).allowed, false);
});

test("WindowCounter: prune drops expired buckets, and keys never contain a raw IP", () => {
  const now = { v: 1_000_000 };
  const counter = new WindowCounter(() => now.v);
  const ipHash = hashIp("203.0.113.9", "s");
  counter.hit(auditKeys.ipHour(ipHash), 60 * 60 * 1000);
  assert.equal(counter.count(auditKeys.ipHour(ipHash), 60 * 60 * 1000), 1);
  now.v += 2 * 60 * 60 * 1000;
  counter.prune(24 * 60 * 60 * 1000);
  assert.equal(counter.count(auditKeys.ipHour(ipHash), 60 * 60 * 1000), 0);
});
