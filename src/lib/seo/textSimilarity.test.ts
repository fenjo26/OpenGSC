import assert from "node:assert/strict";
import test from "node:test";
import { exclusiveLines, normalizeForDiff, textSimilarity } from "./textSimilarity";

// The false positive that made a competing tool report six "bot-only" findings on a clean page:
// Cloudflare serves the real address to crawlers and "[email protected]" to browsers.
test("Cloudflare email obfuscation does not read as a content difference", () => {
  const bot = "Contact us at support@mafiacasino.ca for help with your account.";
  const user = "Contact us at [email protected] for help with your account.";
  assert.equal(textSimilarity(bot, user), 1);
});

test("per-request noise is normalised away", () => {
  const a = 'Welcome. <token> csrf="a91f0c4d7b2e8815" generated 2026-08-19T09:03:11 id 7f3a91c0-11de-4a2b-9c33-2b1d0e5a77bc';
  const b = 'Welcome. <token> csrf="00ffee1122334455" generated 2026-08-19T11:47:02 id 0b21ff90-88ac-4e10-bd55-9a7c31f0e422';
  assert.equal(textSimilarity(a, b), 1);
});

test("similarity is graded, not binary", () => {
  // Page-sized text, because that is what this metric is applied to.
  const base = Array.from({ length: 60 }, (_, i) => `paragraph ${i} describing the licensed casino lobby and payout terms`).join(" ");
  const oneWordOff = base.replace("payout terms", "payout rules");
  const swapped = Array.from({ length: 60 }, (_, i) => `line ${i} claim five thousand dollars bonus two hundred free spins now`).join(" ");

  const drift = textSimilarity(base, oneWordOff);
  const doorway = textSimilarity(base, swapped);

  // A single changed word must not look like a swapped page — the distinction a hash cannot make.
  assert.ok(drift > 0.95, `drift similarity too low: ${drift}`);
  assert.ok(doorway < 0.2, `doorway similarity too high: ${doorway}`);
});

// Documented on purpose rather than smoothed away: with 3-token shingles, one changed word costs
// ~3 shingles, so the SAME edit registers as a larger fraction of a short text than of a long one.
// That is why the verdict compares against the page's own measured drift (the noise floor in
// googlebot.ts) instead of a fixed similarity threshold — the floor is measured with this same
// metric on this same page, so the sensitivity cancels out.
test("short texts are inherently more sensitive — hence the measured noise floor", () => {
  const short = "the quick brown fox jumps over the lazy dog";
  const shortEdited = short.replace("lazy", "eager");
  const long = Array.from({ length: 50 }, () => "the quick brown fox jumps over the lazy dog").join(" ");
  const longEdited = long.replace("lazy", "eager");

  assert.ok(textSimilarity(short, shortEdited) < textSimilarity(long, longEdited));
});

test("identical and disjoint texts sit at the ends of the range", () => {
  assert.equal(textSimilarity("alpha beta gamma delta", "alpha beta gamma delta"), 1);
  assert.equal(textSimilarity("", ""), 1);
  assert.equal(textSimilarity("alpha beta gamma", ""), 0);
});

// An inserted element must shift only the shingles around it. Character-level or fixed-window
// chunking misaligns everything after the insertion and reports the whole document as changed.
test("one inserted sentence does not misalign the rest of the document", () => {
  const body = Array.from({ length: 40 }, (_, i) => `sentence number ${i} about online casino games in canada`).join(" ");
  const withInsert = `an extra promotional line appeared here ${body}`;
  assert.ok(textSimilarity(body, withInsert) > 0.9);
});

test("exclusive lines report each side's own content and skip fragments", () => {
  const bot = "Licensed casino operator in Canada\nup to\nHidden keyword stuffed paragraph for crawlers only";
  const user = "Licensed casino operator in Canada\nup to\nClaim your welcome bonus today";
  const { onlyA, onlyB } = exclusiveLines(bot, user);
  assert.deepEqual(onlyA, ["Hidden keyword stuffed paragraph for crawlers only"]);
  assert.deepEqual(onlyB, ["Claim your welcome bonus today"]);
});

test("normalisation collapses punctuation and case without losing words", () => {
  assert.equal(normalizeForDiff("  Mafia   CASINO — Canada's #1!  "), "mafia casino canada s 1");
});
