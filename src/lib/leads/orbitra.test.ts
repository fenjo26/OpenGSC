// The Orbitra bridge's pure half: URL normalisation and campaign alias generation. The
// network half (orbitraApi) talks to operator infrastructure and is covered by the
// connection test button, not by unit tests.
import test from "node:test";
import assert from "node:assert/strict";
import { campaignAliasFor, normalizeOrbitraUrl } from "./orbitra";

test("normalizeOrbitraUrl adds a scheme and drops the trailing slash", () => {
  assert.equal(normalizeOrbitraUrl("tracker.example.com"), "https://tracker.example.com/");
  assert.equal(normalizeOrbitraUrl("tracker.example.com/"), "https://tracker.example.com/");
  assert.equal(normalizeOrbitraUrl("https://tracker.example.com///"), "https://tracker.example.com/");
  assert.equal(normalizeOrbitraUrl(" http://10.0.0.5/orbitra "), "http://10.0.0.5/orbitra");
});

test("normalizeOrbitraUrl strips query and hash, keeps the path", () => {
  assert.equal(normalizeOrbitraUrl("https://trk.example.com/base?action=x#frag"), "https://trk.example.com/base");
});

test("normalizeOrbitraUrl rejects garbage", () => {
  assert.equal(normalizeOrbitraUrl(""), null);
  assert.equal(normalizeOrbitraUrl("   "), null);
  assert.equal(normalizeOrbitraUrl("not a url at all ///"), null);
  assert.equal(normalizeOrbitraUrl("ftp://tracker.example.com"), null);
});

test("campaignAliasFor is slugged, prefixed and minute-unique", () => {
  const when = new Date("2026-09-25T14:05:09Z");
  assert.equal(campaignAliasFor("Massagethess.gr", when), "ogsc-massagethess-gr-202609251405");
  // www and illegal characters collapse; an empty slug still yields a valid alias
  assert.equal(campaignAliasFor("www.x--y.io", when), "ogsc-x-y-io-202609251405");
  assert.match(campaignAliasFor("🙂.com", when), /^ogsc-(site|com)-202609251405$/);
  // two minutes apart → two aliases (a re-send never collides)
  assert.notEqual(campaignAliasFor("a.gr", when), campaignAliasFor("a.gr", new Date(when.getTime() + 60_000)));
});
