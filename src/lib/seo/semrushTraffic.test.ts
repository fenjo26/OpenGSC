import assert from "node:assert/strict";
import test from "node:test";
import { parseTaCsv, parseTaMonthly, parseTaSources, taPick } from "./semrushTraffic";

// The TA gateway answers CSV whose column names the module reads case-insensitively across
// spellings; these tests pin the three places a wrong read would surface as a wrong number:
// the monthly series' order, and the channel map's precedence (paid before organic, GenAI
// before anything that merely contains "ai").

test("parseTaCsv reads ; delimited reports with headers", () => {
  const rows = parseTaCsv("target;visits;users\r\nexample.com;374340912;185568503");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["target"], "example.com");
  assert.equal(rows[0]["visits"], "374340912");
  assert.deepEqual(parseTaCsv("only-a-header;x"), []);
});

test("taPick matches field names case-insensitively across spellings", () => {
  const row = { Bounce_Rate: "0.42", Visits: "100" };
  assert.equal(taPick(row, "bounce_rate"), "0.42");
  assert.equal(taPick(row, "visits"), "100");
  assert.equal(taPick(row, "rank"), null);
});

test("parseTaMonthly slices to YYYY-MM and sorts chronologically", () => {
  const months = parseTaMonthly([
    { display_date: "2026-03-01", visits: "300" },
    { display_date: "2026-01-01", visits: "100" },
    { display_date: "2026-02-01", visits: "200" },
    { display_date: "garbage", visits: "999" },
  ]);
  assert.deepEqual(months.map(m => m.month), ["2026-01", "2026-02", "2026-03"]);
  assert.deepEqual(months.map(m => m.visits), [100, 200, 300]);
});

test("parseTaSources maps specific channels before their generic parents", () => {
  const s = parseTaSources([
    { traffic_channel: "Paid Search", share: "0.1" },
    { traffic_channel: "Organic Search", share: "0.5" },
    { traffic_channel: "Generative AI", share: "0.04" },
    { traffic_channel: "Paid Social", share: "0.06" },
    { traffic_channel: "Social", share: "0.1" },
    { traffic_channel: "Direct", share: "0.2" },
  ], null);
  assert.equal(s.searchPaid, 0.1);
  assert.equal(s.search, 0.5);
  assert.equal(s.genAI, 0.04);
  assert.equal(s.socialPaid, 0.06);
  assert.equal(s.social, 0.1);
  assert.equal(s.direct, 0.2);
  // Unnamed channels stay null, never zero — the chip hides a zero share.
  assert.equal(s.referrals, null);
});

test("parseTaSources derives shares from visits against the summary total", () => {
  const s = parseTaSources([
    { channel: "Referral", visits: "250" },
    { channel: "Direct", visits: "750" },
  ], 1000);
  assert.equal(s.referrals, 0.25);
  assert.equal(s.direct, 0.75);
});

test("parseTaSources normalises percents above 1 to fractions", () => {
  const s = parseTaSources([{ traffic_channel: "Direct", share_percent: "42" }], null);
  assert.equal(s.direct, 0.42);
});
