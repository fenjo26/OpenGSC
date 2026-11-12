import assert from "node:assert/strict";
import test from "node:test";
import { buildChain, moveConflict, recovery, detectTrafficMoves, normalizeReason, type SiteMoveRow, type DayClicks } from "./chain";

const mv = (id: string, from: string, to: string, date = "2026-06-01"): SiteMoveRow =>
  ({ id, fromSiteId: from, toSiteId: to, date, reason: "block_regulator", redirect301: false, note: null });

const addDay = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const flat = (from: string, days: number, clicks: number): DayClicks[] =>
  Array.from({ length: days }, (_, i) => ({ day: addDay(from, i), clicks }));

test("chain is found from any member, in order", () => {
  const moves = [mv("2", "B", "C"), mv("1", "A", "B")];
  for (const s of ["A", "B", "C"]) {
    const c = buildChain(moves, s);
    assert.deepEqual(c.sites, ["A", "B", "C"]);
    assert.deepEqual(c.moves.map(m => m.id), ["1", "2"]);
  }
  assert.deepEqual(buildChain(moves, "Z").sites, ["Z"]);
});

test("chain walk survives a corrupted loop", () => {
  const c = buildChain([mv("1", "A", "B"), mv("2", "B", "A")], "A");
  assert.ok(c.sites.length <= 2);
});

test("conflicts: same site, branching and cycles are refused", () => {
  const moves = [mv("1", "A", "B"), mv("2", "B", "C")];
  assert.equal(moveConflict(moves, "X", "X"), "same_site");
  assert.equal(moveConflict(moves, "A", "D"), "has_outgoing");
  assert.equal(moveConflict(moves, "D", "B"), "has_incoming");
  assert.equal(moveConflict(moves, "C", "A"), "cycle");
  assert.equal(moveConflict(moves, "C", "D"), null);
});

test("reason falls back to other", () => {
  assert.equal(normalizeReason("block_isp"), "block_isp");
  assert.equal(normalizeReason("nonsense"), "other");
});

test("recovery: days to 50% and 80% use the 7-day median, so a spike day does not count", () => {
  const move = "2026-06-01";
  const old = flat(addDay(move, -28), 28, 100); // baseline 100/day
  // new: 0 for a week, a one-day spike, then 60/day from day 10, 90/day from day 20
  const nw: DayClicks[] = [
    ...flat(move, 7, 0),
    { day: addDay(move, 7), clicks: 700 },
    ...flat(addDay(move, 8), 2, 0),
    ...flat(addDay(move, 10), 10, 60),
    ...flat(addDay(move, 20), 20, 90),
  ];
  const r = recovery(old, nw, move, addDay(move, 39));
  assert.equal(r.baseline, 100);
  // the 700 spike on day 7 must not count; 60/day from day 10 is the majority of the window by day 12 (three 60s plus the spike outrank the zeros),
  // 90/day from day 20 by day 23
  assert.equal(r.daysTo50, 12);
  assert.equal(r.daysTo80, 23);
  assert.equal(r.nowPct, 90);
  assert.equal(r.daysObserved, 40);
});

test("recovery: no baseline → no percentages", () => {
  const r = recovery([], flat("2026-06-01", 10, 5), "2026-06-01", "2026-06-10");
  assert.equal(r.baseline, 0);
  assert.equal(r.daysTo50, null);
  assert.equal(r.nowPct, null);
});

test("recovery: under 7 days observed gives no nowPct yet", () => {
  const r = recovery(flat("2026-05-04", 28, 50), flat("2026-06-01", 3, 50), "2026-06-01", "2026-06-03");
  assert.equal(r.nowPct, null);
  assert.equal(r.daysObserved, 3);
});

test("detector: old site collapses, new one starts in the same fortnight", () => {
  const today = "2026-11-01";
  const drop = addDay(today, -60);
  const A = [...flat(addDay(drop, -90), 90, 200), ...flat(drop, 60, 10)];
  const B = flat(addDay(drop, 3), 57, 120);
  const C = flat(addDay(today, -200), 200, 50); // steady, unrelated
  const got = detectTrafficMoves(new Map([["A", A], ["B", B], ["C", C]]), today);
  assert.equal(got.length, 1);
  assert.equal(got[0].fromSiteId, "A");
  assert.equal(got[0].toSiteId, "B");
});

test("detector: a drop with no newcomer suggests nothing", () => {
  const today = "2026-11-01";
  const drop = addDay(today, -60);
  const A = [...flat(addDay(drop, -90), 90, 200), ...flat(drop, 60, 10)];
  const C = flat(addDay(today, -200), 200, 50);
  assert.deepEqual(detectTrafficMoves(new Map([["A", A], ["C", C]]), today), []);
});

test("site host and root from both property forms", async () => {
  const { siteHost, siteRootUrl } = await import("./chain");
  assert.equal(siteHost("sc-domain:Example.com"), "example.com");
  assert.equal(siteHost("https://www.example.com/"), "example.com");
  assert.equal(siteRootUrl("sc-domain:example.com"), "https://example.com/");
  assert.equal(siteRootUrl("https://example.com/blog/"), "https://example.com/blog/");
});

test("redirect target: another of the user's sites, never itself", async () => {
  const { redirectTarget } = await import("./chain");
  const sites = [{ id: "A", url: "sc-domain:old.com" }, { id: "B", url: "https://new.com/" }, { id: "S", url: "https://gr.old.com/" }];
  assert.equal(redirectTarget("sc-domain:old.com", "https://new.com/", sites), "B");
  assert.equal(redirectTarget("sc-domain:old.com", "https://www.new.com/path", sites), "B");
  assert.equal(redirectTarget("sc-domain:old.com", "https://www.old.com/", sites), null);
  assert.equal(redirectTarget("sc-domain:old.com", "https://gr.old.com/", sites), "S");
  assert.equal(redirectTarget("sc-domain:old.com", "https://elsewhere.com/", sites), null);
});
