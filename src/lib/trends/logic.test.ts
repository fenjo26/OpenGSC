// Trend radar (N5) — tests for the pure logic (docs/tasks/wave-nov/N5-trend-radar.md):
// growth and windows with the GSC data lag, gsc_new against the 60-day history, the suggest
// response shape, new-vs-previous-run scoring, and the threshold/request limits.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEEP_SUFFIXES,
  baselinePerWindow,
  gscGrowth,
  hideBefore,
  newRows,
  nextSuggestScore,
  notifyLines,
  parseSuggest,
  risingRows,
  risingScore,
  shiftDay,
  suggestPlan,
  trendWindows,
  HIDE_AFTER_DAYS,
  NOTIFY_MIN_SCORE,
  SUGGEST_MAX_REQUESTS,
} from "./logic";

// ─── windows ───────────────────────────────────────────────────────────────────

test("trendWindows anchors every window at the last data date, not today", () => {
  // GSC lags 2–3 days; the last date with data here is three days back.
  const w = trendWindows("2026-09-22");
  assert.equal(w.recentEnd, "2026-09-22");
  assert.equal(w.recentStart, "2026-09-16");       // 7 days incl. both ends
  assert.equal(w.prevEnd, "2026-09-15");           // the day before the recent window
  assert.equal(w.prevStart, "2026-08-19");         // 28 days incl. both ends
  assert.equal(w.historyEnd, "2026-09-15");
  assert.equal(w.historyStart, "2026-07-18");      // 60 days incl. both ends
});

test("trendWindows spans are exactly 7 / 28 / 60 days", () => {
  const days = (a: string, b: string) =>
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000 + 1;
  const w = trendWindows("2026-09-22");
  assert.equal(days(w.recentStart, w.recentEnd), 7);
  assert.equal(days(w.prevStart, w.prevEnd), 28);
  assert.equal(days(w.historyStart, w.historyEnd), 60);
});

test("shiftDay crosses month and year boundaries in UTC", () => {
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
});

// ─── gsc_rising ────────────────────────────────────────────────────────────────

test("baseline scales the 28-day total down to one 7-day window", () => {
  assert.equal(baselinePerWindow(400), 100); // 400 * 7/28
  assert.equal(baselinePerWindow(0), 0);
});

test("growth is recent vs baseline; a zero baseline is null, not infinity", () => {
  assert.equal(gscGrowth(200, 400), 2);      // baseline 100 → ×2
  assert.equal(gscGrowth(60, 120), 2);       // baseline 30 → exactly ×2
  assert.equal(gscGrowth(500, 0), null);     // no baseline → gsc_new's business
  assert.equal(gscGrowth(0, 100), 0);
});

test("risingScore = log2(growth) × log10(impressions)", () => {
  assert.ok(Math.abs(risingScore(4, 100) - 4) < 1e-9);    // 2 × 2
  assert.ok(Math.abs(risingScore(2, 1000) - 3) < 1e-9);   // 1 × 3
});

test("risingRows keeps ≥30 impressions and ≥×2 growth, sorted by score", () => {
  const recent = new Map([
    ["doubling", 60],      // baseline 30 → ×2.0, score = 1 × log10(60) ≈ 1.78
    ["quadrupling", 400],  // baseline 100 → ×4.0, score = 2 × log10(400) ≈ 5.2
    ["too small", 29],     // below the impression floor
    ["too flat", 110],     // baseline 100 → ×1.1
    ["breakout", 500],     // no baseline at all
  ]);
  const prev = new Map([["doubling", 120], ["quadrupling", 400], ["too small", 30], ["too flat", 400]]);
  const rows = risingRows(recent, prev);
  assert.deepEqual(rows.map(r => r.query), ["quadrupling", "doubling"]);
  assert.equal(rows[0].growth, 4);
  assert.equal(rows[0].prevImpressionsTotal, 400);
  // Exactly ×2 passes (the condition is ≥, a doubling is a doubling).
  assert.equal(rows[1].growth, 2);
  // ...and 60 against a slightly bigger baseline does not.
  assert.equal(risingRows(new Map([["edge", 60]]), new Map([["edge", 121]])).length, 0);
});

// ─── gsc_new ───────────────────────────────────────────────────────────────────

test("newRows: ≥10 recent impressions and absent from the whole 60-day history", () => {
  const recent = new Map([["fresh", 12], ["tiny", 9], ["seen before", 400], ["fresh big", 900]]);
  const history = new Map([["seen before", 5]]); // even one impression 29–60 days ago disqualifies
  const rows = newRows(recent, history);
  assert.deepEqual(rows.map(r => r.query), ["fresh big", "fresh"]);
  assert.equal(rows[0].score, Math.log10(900));
});

test("newRows score is log10 of impressions — same volume scale as rising", () => {
  const [row] = newRows(new Map([["q", 100]]), new Map());
  assert.equal(row.score, 2);
});

// ─── suggest parsing ───────────────────────────────────────────────────────────

test("parseSuggest reads the client=firefox shape: [seed, [suggestions]]", () => {
  assert.deepEqual(parseSuggest('["slot", ["slot online", "Slot Gratis", "slot online", " slot demo "]]'),
    ["slot online", "slot gratis", "slot demo"]);
});

test("parseSuggest returns null for a captcha page or a wrong shape — unavailable, not empty", () => {
  assert.equal(parseSuggest("<html><body>unusual traffic</body></html>"), null);
  assert.equal(parseSuggest('{"error": "captcha"}'), null);
  assert.equal(parseSuggest('["seed"]'), null);
  assert.equal(parseSuggest("not json at all"), null);
});

test("parseSuggest tolerates an empty suggestion list", () => {
  assert.deepEqual(parseSuggest('["seed", []]'), []);
});

test("nextSuggestScore: new = 1, repeat +0.5, capped at 3", () => {
  assert.equal(nextSuggestScore(false, null), 1);
  assert.equal(nextSuggestScore(true, null), 1.5); // defensive: seen but no stored score
  assert.equal(nextSuggestScore(true, 1), 1.5);
  assert.equal(nextSuggestScore(true, 2.5), 3);
  assert.equal(nextSuggestScore(true, 3), 3);
});

test("suggestPlan: plain mode is one request per seed", () => {
  assert.deepEqual(suggestPlan(["slot", "pragmatic play"], false), ["slot", "pragmatic play"]);
});

test("suggestPlan: deep mode expands seed + a–z + 0–9, one seed at a time", () => {
  const plan = suggestPlan(["slot"], true);
  assert.equal(plan[0], "slot");
  assert.equal(plan[1], "slot a");
  assert.equal(plan[plan.length - 1], `slot ${DEEP_SUFFIXES[DEEP_SUFFIXES.length - 1]}`);
  assert.equal(plan.length, 1 + DEEP_SUFFIXES.length); // 37 requests for one seed
});

test("suggestPlan never exceeds the 50-request budget", () => {
  const many = Array.from({ length: 20 }, (_, i) => `seed${i}`);
  assert.equal(suggestPlan(many, false).length, 20);
  const deep = suggestPlan(many, true);
  assert.equal(deep.length, SUGGEST_MAX_REQUESTS);
  // The budget is spent on completing the first seed's expansion, not on skipping ahead.
  assert.ok(deep.slice(0, 37).every(q => q === "seed0" || q.startsWith("seed0 ")));
  assert.equal(deep[37], "seed1");
  assert.equal(deep[49], "seed1 l");
});

// ─── hiding & notifications ────────────────────────────────────────────────────

test("hideBefore is 14 days back", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const before = hideBefore(now);
  assert.equal(Math.round((now.getTime() - before.getTime()) / 86_400_000), HIDE_AFTER_DAYS);
});

test("notifyLines: only rows above the threshold, hottest first, capped at 8", () => {
  const rows = [
    { query: "loud", source: "gsc_rising" as const, score: 4, growth: 4, impressions: 400 },
    { query: "quiet", source: "gsc_rising" as const, score: 1.5, growth: 2, impressions: 40 },
    { query: "fresh suggest", source: "suggest" as const, score: 1, growth: null, impressions: null },
    { query: "confirmed suggest", source: "suggest" as const, score: 2.5, growth: null, impressions: null },
    ...Array.from({ length: 7 }, (_, i) => ({
      query: `hot ${i}`, source: "gsc_new" as const, score: 3, growth: null, impressions: 1000,
    })),
  ];
  const lines = notifyLines(rows);
  // Above the threshold: loud(4) + 7×hot(3) + confirmed(2.5) = 9 → the cap keeps 8, and the
  // 9th by score (confirmed suggest) is the one cut.
  assert.equal(lines.length, 8);
  assert.ok(lines[0].startsWith("×4.0 loud — 400"));
  assert.equal(lines.filter(l => l.includes("hot")).length, 7);
  assert.ok(!lines.includes("… confirmed suggest"));
  assert.ok(!lines.some(l => l.includes("quiet")));
  assert.ok(!lines.some(l => l.includes("fresh suggest")));
});

test("the notification threshold is above the floor of a bare gsc_rising row", () => {
  // ×2 with 30 impressions is the minimum the radar stores; it must NOT notify.
  const bare = risingScore(2, 30);
  assert.ok(bare < NOTIFY_MIN_SCORE);
});
