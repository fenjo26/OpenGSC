import assert from "node:assert/strict";
import test from "node:test";
import { nextSendAt, parseRecipients, validSendDay, SEND_HOUR_UTC, type ReportSchedule } from "./schedule";

// Fixed anchors instead of the real clock — every case names its input explicitly.
const at = (iso: string) => new Date(iso);

test("weekly: due later this week, at the fixed 09:00 UTC hour", () => {
  // 2026-09-25 is a Friday (ISO weekday 5); the next Monday (1) is 2026-09-28.
  const next = nextSendAt("weekly", 1, at("2026-09-25T12:00:00Z"));
  assert.ok(next);
  assert.equal(next.toISOString(), "2026-09-28T09:00:00.000Z");
});

test("weekly: today's slot has not passed yet → today", () => {
  // 2026-09-25 is a Friday, before 09:00 UTC.
  const next = nextSendAt("weekly", 5, at("2026-09-25T07:30:00Z"));
  assert.ok(next);
  assert.equal(next.toISOString(), "2026-09-25T09:00:00.000Z");
});

test("weekly: today's slot already passed → next week", () => {
  const next = nextSendAt("weekly", 5, at("2026-09-25T10:00:00Z"));
  assert.ok(next);
  assert.equal(next.toISOString(), "2026-10-02T09:00:00.000Z");
});

test("monthly: the 28th fires in February too — 29..31 are not representable", () => {
  const next = nextSendAt("monthly", 28, at("2026-02-10T00:00:00Z"));
  assert.ok(next);
  assert.equal(next.toISOString(), "2026-02-28T09:00:00.000Z");
  // A send day outside 1..28 is clamped by validSendDay, and nextSendAt for a day that
  // cannot exist simply never matches: with 31 the walk finds nothing within 70 days...
  // which cannot happen through validSendDay, but must not loop forever if it does.
  assert.equal(validSendDay("monthly", 29), 1);
  assert.equal(validSendDay("monthly", 31), 1);
  assert.equal(validSendDay("monthly", 0), 1);
  assert.equal(validSendDay("monthly", 12), 12);
});

test("monthly: rolls into the next month when the day has passed", () => {
  const next = nextSendAt("monthly", 5, at("2026-01-06T00:00:00Z"));
  assert.ok(next);
  assert.equal(next.toISOString(), "2026-02-05T09:00:00.000Z");
});

test("monthly: crosses the year boundary", () => {
  const next = nextSendAt("monthly", 15, at("2026-12-20T00:00:00Z"));
  assert.ok(next);
  assert.equal(next.toISOString(), "2027-01-15T09:00:00.000Z");
});

test("off never schedules; unknown days for weekly clamp to Monday", () => {
  assert.equal(nextSendAt("off" as ReportSchedule, 3, at("2026-09-25T00:00:00Z")), null);
  assert.equal(validSendDay("weekly", 0), 1);
  assert.equal(validSendDay("weekly", 8), 1);
  assert.equal(validSendDay("weekly", 7), 7);
  assert.equal(SEND_HOUR_UTC, 9);
});

test("parseRecipients: splits on commas/semicolons/newlines, lowercases, dedupes, flags junk", () => {
  const { to, invalid } = parseRecipients("Client@Example.com; boss@co.io\nclient@example.com, not-an-email @x");
  assert.deepEqual(to, ["client@example.com", "boss@co.io"]);
  // "not-an-email @x" is one junk chunk between separators — shown whole so the operator
  // recognises what they typed.
  assert.deepEqual(invalid, ["not-an-email @x"]);
  assert.deepEqual(parseRecipients("").to, []);
});

test("parseRecipients caps at 20 recipients", () => {
  const raw = Array.from({ length: 25 }, (_, i) => `u${i}@example.com`).join(", ");
  const { to } = parseRecipients(raw);
  assert.equal(to.length, 20);
});
