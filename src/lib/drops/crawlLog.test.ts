import assert from "node:assert/strict";
import test from "node:test";
import { utcMidnightDaysBetween } from "./activation";
import { parseCrawlLog, parseCrawlLine, parseCrawlTimestamp } from "./crawlLog";

// 00:30 UTC on the 18th: the boundary pair below is exactly one UTC midnight apart
// per day, which is what the 7-day window must be computed against.
const NOW = new Date("2026-09-18T00:30:00Z");

/** One combined-format line, parametrised. */
const line = (ts: string, status = 200, ua = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)") =>
  `66.249.66.1 - - [${ts}] "GET /legacy/page HTTP/1.1" ${status} 512 "-" "${ua}"`;

const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";

// ── counting ──────────────────────────────────────────────────────────────────

test("a plain Googlebot 200 line counts, with lastHitAt from the log", () => {
  const r = parseCrawlLog(line("11/Sep/2026:23:30:00 +0000"), { now: NOW });
  assert.equal(r.hitsTotal, 1);
  assert.equal(r.hits7d, 1);
  assert.equal(r.lastHitAt?.toISOString(), "2026-09-11T23:30:00.000Z");
  assert.equal(r.skipped, 0);
});

test("a non-Googlebot user agent does not count — and is not garbage", () => {
  const r = parseCrawlLog(line("12/Sep/2026:10:00:00 +0000", 200, FIREFOX), { now: NOW });
  assert.equal(r.hitsTotal, 0);
  assert.equal(r.hits7d, 0);
  assert.equal(r.lastHitAt, null);
  assert.equal(r.skipped, 0);
});

test("a Googlebot 404 does not count — and is not garbage", () => {
  const r = parseCrawlLog(line("12/Sep/2026:10:00:00 +0000", 404), { now: NOW });
  assert.equal(r.hitsTotal, 0);
  assert.equal(r.skipped, 0);
});

test("a Googlebot 301 (status < 400) counts, a 400 does not", () => {
  const r = parseCrawlLog(
    line("12/Sep/2026:10:00:00 +0000", 301) + "\n" + line("12/Sep/2026:11:00:00 +0000", 400),
    { now: NOW },
  );
  assert.equal(r.hitsTotal, 1);
  assert.equal(r.skipped, 0);
});

// ── the 7-day boundary, in UTC midnights ─────────────────────────────────────

test("23:30 UTC seven midnights back counts; one more midnight back does not (7d only drops out of hits7d)", () => {
  // 23:30 on the 11th vs now 00:30 on the 18th: seven UTC midnights apart — inside.
  // 23:30 on the 10th: eight — outside the window but still a hit overall.
  const log = line("11/Sep/2026:23:30:00 +0000") + "\n" + line("10/Sep/2026:23:30:00 +0000");
  assert.equal(utcMidnightDaysBetween(NOW, new Date("2026-09-11T23:30:00Z")), -7);
  assert.equal(utcMidnightDaysBetween(NOW, new Date("2026-09-10T23:30:00Z")), -8);
  const r = parseCrawlLog(log, { now: NOW });
  assert.equal(r.hitsTotal, 2);
  assert.equal(r.hits7d, 1);
  assert.equal(r.lastHitAt?.toISOString(), "2026-09-11T23:30:00.000Z");
});

test("the log's own UTC offset decides the day, not the reader's clock", () => {
  // 02:30 +0300 on the 12th is 23:30 UTC on the 11th — same boundary as above.
  const r = parseCrawlLog(line("12/Sep/2026:02:30:00 +0300"), { now: NOW });
  assert.equal(r.hits7d, 1);
  assert.equal(r.lastHitAt?.toISOString(), "2026-09-11T23:30:00.000Z");
});

test("default now is the wall clock (smoke: a current line lands in the 7d window)", () => {
  const fresh = new Date(Date.now() - 86_400_000); // yesterday, whatever the clock says
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = fresh.toISOString().slice(0, 19).split(/[-:T]/); // yyyy, mm, dd, hh, mi, ss
  const stamp = `${p[2]}/${MON[fresh.getUTCMonth()]}/${p[0]}:${p[3]}:${p[4]}:${p[5]} +0000`;
  const r = parseCrawlLog(line(stamp));
  assert.equal(r.hitsTotal, 1);
  assert.equal(r.hits7d, 1);
});

// ── garbage and format tolerance ──────────────────────────────────────────────

test("a garbage line increments skipped and does not take the run down", () => {
  const r = parseCrawlLog(
    "this is not a log line at all\n" +
    "66.249.66.1 - - [12/Sep/2026:10:00:00 +0000] \"GET /a HTTP/1.1\" 2\n" +
    line("12/Sep/2026:12:00:00 +0000"),
    { now: NOW },
  );
  assert.equal(r.hitsTotal, 1);
  assert.equal(r.skipped, 2); // prose line + truncated line (timestamp, no status)
});

test("empty and whitespace-only logs are empty summaries, not errors", () => {
  const r = parseCrawlLog("\n \r\n\n", { now: NOW });
  assert.deepEqual({ ...r, lastHitAt: null }, { hitsTotal: 0, hits7d: 0, lastHitAt: null, skipped: 0 });
});

test("a common-format line parses but cannot be attributed to Googlebot without a user agent", () => {
  const common = `66.249.66.1 - - [12/Sep/2026:10:00:00 +0000] "GET / HTTP/1.1" 200 512`;
  const bare = `66.249.66.1 - - [12/Sep/2026:10:00:00 +0000] GET / HTTP/1.1 200 512`;
  const r = parseCrawlLog(common + "\n" + bare, { now: NOW });
  assert.equal(r.hitsTotal, 0);
  assert.equal(r.skipped, 0);
  // The line-level parse did work — both are log lines, just not identifiable hits.
  assert.equal(parseCrawlLine(common)?.status, 200);
  assert.equal(parseCrawlLine(bare)?.ua, null);
});

test("rotated logs count out of order: lastHitAt is the maximum, not the last line", () => {
  const r = parseCrawlLog(
    line("11/Sep/2026:23:30:00 +0000") + "\n" + line("15/Sep/2026:08:00:00 +0000"),
    { now: NOW },
  );
  assert.equal(r.hitsTotal, 2);
  assert.equal(r.lastHitAt?.toISOString(), "2026-09-15T08:00:00.000Z");
});

test("a request path containing the word Googlebot does not fake a hit", () => {
  const r = parseCrawlLog(
    `203.0.113.5 - - [12/Sep/2026:10:00:00 +0000] "GET /googlebot-test HTTP/1.1" 200 512 "-" "${FIREFOX}"`,
    { now: NOW },
  );
  assert.equal(r.hitsTotal, 0);
});

// ── parseCrawlTimestamp ───────────────────────────────────────────────────────

test("offsets convert to UTC, bad stamps are null", () => {
  assert.equal(parseCrawlTimestamp("18/Sep/2026:10:00:00 +0300")?.toISOString(), "2026-09-18T07:00:00.000Z");
  assert.equal(parseCrawlTimestamp("18/Sep/2026:10:00:00 -0500")?.toISOString(), "2026-09-18T15:00:00.000Z");
  assert.equal(parseCrawlTimestamp("18/Xyz/2026:10:00:00 +0000"), null);
  assert.equal(parseCrawlTimestamp("18/Sep/2026:25:00:00 +0000"), null);
  assert.equal(parseCrawlTimestamp("not a timestamp"), null);
  assert.equal(parseCrawlTimestamp(""), null);
});

test("parseCrawlLine rejects a line without a timestamp bracket", () => {
  assert.equal(parseCrawlLine(`"GET / HTTP/1.1" 200 512`), null);
});
