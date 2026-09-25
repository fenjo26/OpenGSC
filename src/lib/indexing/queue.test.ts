import assert from "node:assert/strict";
import test from "node:test";
import {
  pacificDay, utcDayStart, msUntilPacificMidnight,
  isIndexedCoverage, statusIndexed, pickInspectBatch, nextCheckAt,
  type InspectRow,
} from "./queue";
import { DEFAULT_INDEX_INSPECT, type InspectOutcome, type IndexInspectSettings } from "./types";

// ─── pacificDay: the quota day boundary is midnight America/Los_Angeles ────────

test("pacificDay: PDT boundary at 07:00Z (UTC-7)", () => {
  assert.equal(pacificDay(new Date("2026-10-01T06:59:59Z")), "2026-09-30");
  assert.equal(pacificDay(new Date("2026-10-01T07:00:00Z")), "2026-10-01");
});

test("pacificDay: PST boundary at 08:00Z (UTC-8)", () => {
  // January is Pacific Standard Time.
  assert.equal(pacificDay(new Date("2027-01-15T07:59:59Z")), "2027-01-14");
  assert.equal(pacificDay(new Date("2027-01-15T08:00:00Z")), "2027-01-15");
});

test("pacificDay: DST fall-back day keeps one calendar day across the switch", () => {
  // US DST ends 2026-11-01 at 02:00 PT: 00:59 PDT and 01:00 PST are the same November 1st.
  assert.equal(pacificDay(new Date("2026-11-01T07:00:00Z")), "2026-11-01"); // 00:00 PDT
  assert.equal(pacificDay(new Date("2026-11-01T09:59:59Z")), "2026-11-01"); // 01:59:59 PST
  assert.equal(pacificDay(new Date("2026-11-01T10:00:00Z")), "2026-11-01"); // 02:00 PST
  // …and the previous day ends an hour late by UTC: midnight PT is 07:00Z in summer.
  assert.equal(pacificDay(new Date("2026-11-01T06:59:59Z")), "2026-10-31");
});

test("utcDayStart truncates to the UTC day", () => {
  assert.equal(utcDayStart(new Date("2026-10-01T23:59:59.999Z")).toISOString(), "2026-10-01T00:00:00.000Z");
});

test("msUntilPacificMidnight lands within the tick after the boundary", () => {
  // 30 minutes before a 07:00Z reset → ~30 min; DST-aware, not a fixed-offset guess.
  const ms = msUntilPacificMidnight(new Date("2026-10-01T06:30:00Z"));
  assert.ok(ms > 29 * 60_000 && ms <= 31 * 60_000, `expected ~30 min, got ${ms}`);
  // Right after the reset, the next one is a whole (24 h) day away.
  const full = msUntilPacificMidnight(new Date("2026-10-01T07:00:00Z"));
  assert.ok(full > 23.9 * 3_600_000 && full <= 24.1 * 3_600_000, `expected ~24 h, got ${full}`);
});

// ─── isIndexedCoverage: the API string table ───────────────────────────────────

test("isIndexedCoverage: verdict PASS means indexed", () => {
  assert.equal(isIndexedCoverage(null, "PASS"), true);
  assert.equal(isIndexedCoverage("Something new", "pass"), true); // case-insensitive
});

test("isIndexedCoverage: listed coverage strings", () => {
  assert.equal(isIndexedCoverage("Submitted and indexed", null), true);
  assert.equal(isIndexedCoverage("Indexed, not submitted in sitemap", null), true);
  const notIndexed = [
    "Crawled - currently not indexed",
    "Discovered - currently not indexed",
    "URL is unknown to Google",
    "Excluded by 'noindex' tag",
    "Duplicate, Google chose different canonical",
    "Duplicate without user-selected canonical",
    "Page with redirect",
    "Not found (404)",
    "Soft 404",
    "Blocked by robots.txt",
    "Alternate page with proper canonical tag",
  ];
  for (const s of notIndexed) assert.equal(isIndexedCoverage(s, null), false, s);
  // Case-insensitive on coverage strings too.
  assert.equal(isIndexedCoverage("SUBMITTED AND INDEXED", "NEUTRAL"), true);
});

test("isIndexedCoverage: unknown strings stay unknown, never a guess", () => {
  assert.equal(isIndexedCoverage("Alternate page (with proper canonical tag) but weird", null), null);
  assert.equal(isIndexedCoverage(null, "NEUTRAL"), null);
  assert.equal(isIndexedCoverage(null, null), null);
});

test("statusIndexed classifies the combined googleStatus column", () => {
  assert.equal(statusIndexed("PASS"), true); // stored verdict
  assert.equal(statusIndexed("Submitted and indexed"), true); // stored coverage
  assert.equal(statusIndexed("Soft 404"), false);
  assert.equal(statusIndexed(null), null);
  assert.equal(statusIndexed("Something unheard of"), null);
});

// ─── pickInspectBatch: priorities, skips, limits ──────────────────────────────

const NOW = new Date("2026-10-01T12:00:00Z");
const base = {
  googleChecked: new Date("2026-09-01T00:00:00Z"),
  googleNextCheck: null as Date | null,
  googleStatus: null as string | null,
  changeStatus: "unchanged",
  inventoryStatus: "active",
};

const row = (url: string, patch: Partial<InspectRow> = {}): InspectRow => ({
  url,
  firstSeenAt: new Date("2026-08-01T00:00:00Z"),
  ...base,
  ...patch,
});

test("pickInspectBatch: priority order new → changed → not_indexed → stale_indexed", () => {
  const rows = [
    row("/stale", { googleStatus: "Submitted and indexed", googleNextCheck: new Date("2026-09-30T00:00:00Z") }),
    row("/not-idx", { googleStatus: "Crawled - currently not indexed", googleNextCheck: new Date("2026-09-30T00:00:00Z") }),
    row("/changed", { changeStatus: "changed", lastSeenAt: new Date("2026-09-20T00:00:00Z") }),
    row("/new", { googleChecked: null }),
  ];
  const batch = pickInspectBatch(rows, NOW, 10);
  assert.deepEqual(batch.map(b => b.url), ["/new", "/changed", "/not-idx", "/stale"]);
  assert.deepEqual(batch.map(b => b.priority), ["new", "changed", "not_indexed", "stale_indexed"]);
});

test("pickInspectBatch: never-checked URLs go freshest-first", () => {
  const rows = [
    row("/old-page", { googleChecked: null, firstSeenAt: new Date("2026-01-01T00:00:00Z") }),
    row("/fresh-page", { googleChecked: null, firstSeenAt: new Date("2026-09-30T00:00:00Z") }),
    row("/mid-page", { googleChecked: null, firstSeenAt: new Date("2026-06-01T00:00:00Z") }),
  ];
  assert.deepEqual(pickInspectBatch(rows, NOW, 10).map(b => b.url), ["/fresh-page", "/mid-page", "/old-page"]);
});

test("pickInspectBatch: changed requires the inspection to predate the change", () => {
  const sameDay = row("/just-checked", {
    changeStatus: "changed",
    googleChecked: new Date("2026-09-25T00:00:00Z"),
    lastSeenAt: new Date("2026-09-20T00:00:00Z"), // checked AFTER the change
  });
  assert.deepEqual(pickInspectBatch([sameDay], NOW, 10), []);

  const stale = row("/stale-check", {
    changeStatus: "added",
    googleChecked: new Date("2026-09-01T00:00:00Z"),
    lastSeenAt: new Date("2026-09-20T00:00:00Z"),
  });
  assert.deepEqual(pickInspectBatch([stale], NOW, 10).map(b => b.priority), ["changed"]);
});

test("pickInspectBatch: non-active inventory is never picked", () => {
  const rows = [
    row("/missing", { inventoryStatus: "missing", googleChecked: null }),
    row("/pending", { inventoryStatus: "pending_missing", googleChecked: null }),
  ];
  assert.deepEqual(pickInspectBatch(rows, NOW, 10), []);
});

test("pickInspectBatch: rechecks respect googleNextCheck", () => {
  const future = row("/future", { googleStatus: "Soft 404", googleNextCheck: new Date("2026-10-02T00:00:00Z") });
  assert.deepEqual(pickInspectBatch([future], NOW, 10), []);
  const due = row("/due", { googleStatus: "Soft 404", googleNextCheck: NOW });
  assert.deepEqual(pickInspectBatch([due], NOW, 10).map(b => b.priority), ["not_indexed"]);
});

test("pickInspectBatch: limit cuts across priorities in order; stable within a bucket", () => {
  const rows = [
    row("/b-new", { googleChecked: null, firstSeenAt: new Date("2026-09-01T00:00:00Z") }),
    row("/a-new", { googleChecked: null, firstSeenAt: new Date("2026-09-01T00:00:00Z") }),
    row("/c-changed", { changeStatus: "changed", lastSeenAt: new Date("2026-09-20T00:00:00Z") }),
    row("/d-changed", { changeStatus: "restored", lastSeenAt: new Date("2026-09-20T00:00:00Z") }),
  ];
  const batch = pickInspectBatch(rows, NOW, 3);
  // new bucket: same firstSeenAt → URL order; then changed in URL order; limit drops the last.
  assert.deepEqual(batch.map(b => b.url), ["/a-new", "/b-new", "/c-changed"]);
});

// ─── nextCheckAt: the three branches + jitter ─────────────────────────────────

const SETTINGS: IndexInspectSettings = { ...DEFAULT_INDEX_INSPECT, recheckIndexedDays: 14, recheckNotIndexedDays: 3 };
const DAY = 86_400_000;
const outcome = (patch: Partial<InspectOutcome>): InspectOutcome => ({
  url: "https://example.com/a", ok: true, verdict: "PASS", coverageState: "Submitted and indexed",
  indexed: true, lastCrawl: null, googleCanonical: null, error: null, quotaExhausted: false,
  ...patch,
});

test("nextCheckAt: indexed → recheckIndexedDays, not indexed → recheckNotIndexedDays, error → 1 day", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const idx = nextCheckAt(outcome({ indexed: true }), SETTINGS, now).getTime() - now.getTime();
  const notIdx = nextCheckAt(outcome({ indexed: false, coverageState: "Soft 404" }), SETTINGS, now).getTime() - now.getTime();
  const err = nextCheckAt(outcome({ ok: false, indexed: null }), SETTINGS, now).getTime() - now.getTime();
  // ±10 % jitter bounds, generous on the edges so the exact hash doesn't pin the test.
  assert.ok(idx >= 0.9 * 14 * DAY && idx <= 1.1 * 14 * DAY, `indexed: ${idx}`);
  assert.ok(notIdx >= 0.9 * 3 * DAY && notIdx <= 1.1 * 3 * DAY, `not indexed: ${notIdx}`);
  assert.ok(err >= 0.9 * DAY && err <= 1.1 * DAY, `error: ${err}`);
});

test("nextCheckAt: an ok-but-unrecognized coverage counts as not indexed (recheck sooner)", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const unknown = nextCheckAt(outcome({ indexed: null, coverageState: "Brand new state", verdict: "NEUTRAL" }), SETTINGS, now);
  const delta = unknown.getTime() - now.getTime();
  assert.ok(delta >= 0.9 * 3 * DAY && delta <= 1.1 * 3 * DAY, `unknown coverage: ${delta}`);
});

test("nextCheckAt: jitter is deterministic per URL and stays within ±10 %", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const o = outcome({ indexed: true });
  const first = nextCheckAt(o, SETTINGS, now).getTime();
  assert.equal(nextCheckAt(o, SETTINGS, now).getTime(), first); // same URL → same deadline
  // Different URLs spread inside the band; with 30 samples the spread must be non-trivial.
  const offsets = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const at = nextCheckAt(outcome({ ...o, url: `https://example.com/p${i}` }), SETTINGS, now);
    const delta = at.getTime() - now.getTime();
    assert.ok(delta >= 0.9 * 14 * DAY && delta <= 1.1 * 14 * DAY, `p${i}: ${delta}`);
    offsets.add(String(delta));
  }
  assert.ok(offsets.size > 1, "jitter should vary across URLs");
});

test("nextCheckAt: day settings below 1 clamp to 1 day", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const delta = nextCheckAt(outcome({ indexed: true }), { ...SETTINGS, recheckIndexedDays: 0 }, now).getTime() - now.getTime();
  assert.ok(delta >= 0.9 * DAY && delta <= 1.1 * DAY, `clamped: ${delta}`);
});
