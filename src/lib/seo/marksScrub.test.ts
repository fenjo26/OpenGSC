import { test } from "node:test";
import assert from "node:assert/strict";
import { scanMarks, scrubMarks } from "./marksScrub";

test("strips zero-width characters that glue words together invisibly", () => {
  const r = scrubMarks("more\u200Bover and truth\u2060fully op\u2061en");
  assert.equal(r.text, "moreover and truthfully open");
  assert.equal(r.byClass.zeroWidth, 3);
});

test("removes soft hyphens, bidi controls and BOM", () => {
  const r = scrubMarks("per\u00ADform\u202E txt\uFEFFclean");
  assert.equal(r.text, "perform txtclean");
  assert.equal(r.byClass.softHyphen, 1);
  assert.equal(r.byClass.bidi, 1);
  assert.equal(r.byClass.zeroWidth, 1);
});

test("replaces exotic spaces with plain ones", () => {
  const r = scrubMarks("10\u00A0USD\u2003and\u202Fnarrow\u3000wide");
  assert.equal(r.text, "10 USD and narrow wide");
  assert.equal(r.byClass.exoticSpace, 4);
});

test("drops control, noncharacter and private-use characters, keeps tab and newline", () => {
  const r = scrubMarks("a\u0000b\u0007c\ufffed\uE000e");
  assert.equal(r.text, "abcde");
  assert.equal(r.byClass.control, 2);
  assert.equal(r.byClass.noncharacter, 1);
  assert.equal(r.byClass.privateUse, 1);
  const kept = scrubMarks("line1\nline2\tend");
  assert.equal(kept.text, "line1\nline2\tend");
  assert.equal(kept.total, 0);
});

test("keeps ZWJ and variation selector inside emoji sequences", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  assert.equal(scrubMarks("love " + family).total, 0);
  assert.equal(scrubMarks("\u2764\uFE0F").total, 0, "VS16 colors the heart — it stays");
});

test("keeps ZWNJ where a joining script requires it, drops it elsewhere", () => {
  // Persian "می‌شود" — the ZWNJ is spelling, removing it corrupts the word.
  const persian = "\u0645\u06CC\u200C\u0634\u0648\u062F";
  assert.equal(scrubMarks(persian).total, 0);
  const r = scrubMarks("co\u200Coperate");
  assert.equal(r.text, "cooperate");
  assert.equal(r.byClass.zeroWidth, 1);
});

test("keeps the Scotland flag tag sequence, strips orphaned tag characters", () => {
  const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
  assert.equal(scrubMarks("flag " + scotland).total, 0);
  const r = scrubMarks("x\u{E0067}y");
  assert.equal(r.text, "xy");
  assert.equal(r.byClass.tag, 1);
});

test("straightens curly quotes in Latin-style text", () => {
  const r = scrubMarks("don\u2019t say \u201Cnever\u201D");
  assert.equal(r.text, `don't say "never"`);
  assert.equal(r.byClass.quote, 3);
});

test("leaves quotes alone when the text uses guillemets or low quotes", () => {
  const fr = "l\u2019article \u00AB\u00A0choisi\u00A0\u00BB";
  const r = scrubMarks(fr);
  assert.equal(r.byClass.quote, undefined, "French apostrophe + guillemets are locale typography");
  assert.equal(r.byClass.exoticSpace, 2, "NBSP inside guillemets still normalizes");
  assert.equal(r.text, "l\u2019article « choisi »", "quotes do not move");
});

test("cleans up doubled whitespace left behind by removals", () => {
  const r = scrubMarks("a\u200B \u200Bb  \u00AD c");
  assert.equal(r.text, "a b c");
});

test("clean text passes through byte-identical", () => {
  const clean = "# Title\n\nPlain text with 1234 and €30. Буквы, αλληλογραφία, カタカナ.";
  const r = scrubMarks(clean);
  assert.equal(r.text, clean);
  assert.equal(r.total, 0);
});

test("scanMarks reports without changing anything", () => {
  const scan = scanMarks("a\u200Bb\u201Cc");
  assert.equal(scan.total, 2);
  assert.equal(scan.byClass.zeroWidth, 1);
  assert.equal(scan.byClass.quote, 1);
});
