import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APARSER_POSITION_OPTION_IDS, aparserPositionOptions, aparserPositionQuery, captchaPresetCandidates,
  filterOptionsByPreset, mapAparserPosition, positionMatchPlan,
} from "./aparserPosition";

const site = { siteHost: "transfer-thessaloniki.gr", depth: 100 };
const stats = (captcha = 0) => ({ info: { stats: { reCaptchaShows: captcha, proxiesUsed: 1, retries: 0 } } });

test("match plan: a registrable name uses tld mode, a subdomain uses exact domain + www twin", () => {
  assert.deepEqual(positionMatchPlan("https://www.transfer-thessaloniki.gr/"), { domains: ["transfer-thessaloniki.gr"], matchType: "tld" });
  assert.deepEqual(positionMatchPlan("sc-domain:example.co.uk"), { domains: ["example.co.uk"], matchType: "tld" });
  assert.deepEqual(positionMatchPlan("blog.example.com"), { domains: ["blog.example.com", "www.blog.example.com"], matchType: "domain" });
  // eu.com is not in the suffix table: apexOf says "eu.com", so tld mode would match every *.eu.com.
  assert.equal(positionMatchPlan("turbowins.eu.com").matchType, "domain");
});

test("query puts the domain list first and normalises the keyword", () => {
  assert.equal(aparserPositionQuery({ domains: ["a.gr", "www.a.gr"], matchType: "domain" }, "  taxi   airport "), "a.gr,www.a.gr taxi airport");
});

test("options: ten pages for depth 100, market, match type, one-shot JS browser", () => {
  const o = aparserPositionOptions({ depth: 100, gl: "GR", hl: "el", matchType: "tld" });
  const byId = Object.fromEntries(o.map((x) => [x.id, x.value]));
  assert.deepEqual(byId, { pagecount: 10, gl: "gr", hl: "el", matchtype: "tld", redirectBrowserSingle: 0 });
  assert.equal(aparserPositionOptions({ depth: 30, gl: "", hl: "", matchType: "domain" }).find((x) => x.id === "pagecount")?.value, 3);
});

test("preset filter drops unknown ids but never pagecount; unreadable preset sends everything", () => {
  const all = aparserPositionOptions({ depth: 100, gl: "gr", hl: "el", matchType: "tld" });
  const r = filterOptionsByPreset(all, new Set(["gl", "hl", "matchtype"]));
  assert.deepEqual(r.options.map((o) => o.id), [APARSER_POSITION_OPTION_IDS.pagecount, "gl", "hl", "matchtype"]);
  assert.deepEqual(r.dropped, ["redirectBrowserSingle"]);
  assert.equal(filterOptionsByPreset(all, null).options.length, all.length);
});

test("found: position and link are taken, www and subdomains count as the site", () => {
  const r = mapAparserPosition({ success: 1, position: 4, link: "https://www.transfer-thessaloniki.gr/en/", ...stats() }, [], site);
  assert.deepEqual(r, { position: 4, url: "https://www.transfer-thessaloniki.gr/en/", problem: null });
  const s = mapAparserPosition({ success: 1, position: "12", link: "https://ru.transfer-thessaloniki.gr/" }, [], site);
  assert.equal(s.position, 12);
});

test("found on another host is a mismatch, never a position", () => {
  const r = mapAparserPosition({ success: 1, position: 2, link: "https://thessaloniki-transfer.gr/" }, [], site);
  assert.equal(r.problem, "aparser_position_mismatch");
  assert.equal(r.position, null);
});

test("zero = not found; none / empty / failed parse = error", () => {
  assert.deepEqual(mapAparserPosition({ success: 1, position: 0, totalcount: "About 2,000,000" }, [], site), { position: null, url: null, problem: null });
  assert.equal(mapAparserPosition({ success: 1, position: "none" }, [], site).problem, "aparser_blocked_or_empty");
  assert.equal(mapAparserPosition({ success: 1 }, [], site).problem, "aparser_blocked_or_empty");
  assert.equal(mapAparserPosition({ success: 0, ...stats(4) }, [["Google show recaptcha"]], site).problem, "aparser_blocked_or_empty");
  assert.equal(mapAparserPosition({ success: 0, ...stats(0) }, [], site).problem, "aparser_parser_failed");
  assert.equal(mapAparserPosition(null, [], site).problem, "aparser_no_result");
});

test("a zero after 'No more pages' is partial unless the engine says there are fewer results", () => {
  const logs = [["Probably more pages"], ["No more pages"]];
  const early = mapAparserPosition({ success: 1, position: 0, totalcount: "10" }, logs, site);
  assert.equal(early.problem, "aparser_partial_serp");
  assert.match(early.detail ?? "", /No more pages/);
  const unknown = mapAparserPosition({ success: 1, position: 0, totalcount: "none" }, logs, site);
  assert.equal(unknown.problem, "aparser_partial_serp");
  const small = mapAparserPosition({ success: 1, position: 0, totalcount: "37" }, logs, site);
  assert.equal(small.problem, null);
  assert.equal(small.position, null);
});

test("bulk answer: best positive position wins; one unreadable domain fails the check", () => {
  const sub = { siteHost: "blog.example.com", depth: 100 };
  const r = mapAparserPosition({
    success: 1,
    bulkcheck: [
      { domain: "blog.example.com", position: 0, link: "" },
      { domain: "www.blog.example.com", position: 7, link: "https://www.blog.example.com/post" },
    ],
  }, [], sub);
  assert.deepEqual(r, { position: 7, url: "https://www.blog.example.com/post", problem: null });
  const bad = mapAparserPosition({
    success: 1,
    bulkcheck: [{ domain: "blog.example.com", position: "none" }, { domain: "www.blog.example.com", position: 0 }],
  }, [], sub);
  assert.equal(bad.problem, "aparser_blocked_or_empty");
  const none = mapAparserPosition({ success: 1, bulkcheck: [{ position: 0 }, { position: "0" }] }, [], sub);
  assert.deepEqual(none, { position: null, url: null, problem: null });
});

test("flat-triplet bulkcheck — the shape 1.2.3643 really returns (live probe 2026-09-17)", () => {
  const site = { siteHost: "orbitra.link", depth: 100 };
  // Found: ["domain", position, link] per domain; best position wins, link host must match.
  const found = mapAparserPosition({
    success: 1,
    bulkcheck: ["orbitra.link", 0, "none", "www.orbitra.link", 1, "https://orbitra.link/?p=1"],
  }, [], site);
  assert.deepEqual(found, { position: 1, url: "https://orbitra.link/?p=1", problem: null });
  // All-zero after full depth = clean "not found", same as the objects shape.
  const absent = mapAparserPosition({
    success: 1, totalcount: "847",
    bulkcheck: ["orbitra.link", 0, "none"],
  }, [], site);
  assert.deepEqual(absent, { position: null, url: null, problem: null });
  // A "none" position cell in a triplet is unreadable → the check fails, nothing stored.
  const none = mapAparserPosition({
    success: 1,
    bulkcheck: ["orbitra.link", "none", "none"],
  }, [], site);
  assert.equal(none.problem, "aparser_blocked_or_empty");
  // Not a triplet array (wrong length / non-string domain) → falls back to the row itself,
  // whose "none" top-level position fails the check rather than inventing an answer.
  const junk = mapAparserPosition({ success: 1, position: "none", bulkcheck: ["orbitra.link", 0] }, [], site);
  assert.equal(junk.problem, "aparser_blocked_or_empty");
});

test("captcha presets are inherited from SE::Google's own recipe — non-default only, existence checked by the caller", () => {
  // The live shape: SE::Google "my" points ReCaptcha2 at the solver preset "captcha",
  // AntiGate at the bare default → only ReCaptcha2 becomes a candidate.
  const se = { Util_ReCaptcha2_preset: "captcha", Util_AntiGate_preset: "default" };
  assert.deepEqual(captchaPresetCandidates(se), [
    { id: "Util_ReCaptcha2_preset", parser: "Util::ReCaptcha2", preset: "captcha" },
  ]);
  assert.deepEqual(captchaPresetCandidates({}), []);
  assert.deepEqual(captchaPresetCandidates({ Util_ReCaptcha2_preset: "  " }), []);
  // Both solvers named → both candidates, in the stable id order.
  assert.deepEqual(
    captchaPresetCandidates({ Util_ReCaptcha2_preset: "svc", Util_AntiGate_preset: "ag" }).map(c => c.preset),
    ["svc", "ag"],
  );
});
