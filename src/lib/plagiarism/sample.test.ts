import assert from "node:assert/strict";
import test from "node:test";
import { eligibleFragments, pickFragments, MAX_FRAGMENTS, MIN_FRAGMENT_WORDS } from "./sample";
import { splitSentences, normalizeTextForPlagiarism } from "./text";

const S = (n: number) => {
  // Deterministic, non-repetitive filler: every sentence is different so the picker has real
  // candidates to rank instead of N copies of the same string.
  const words = [
    "bankroll", "wagering", "blackjack", "dealer", "jackpot", "licensed", "regulator", "payout",
    "roulette", "novelty", "betting", "casino", "bonus", "spin", "table", "dealer",
  ];
  const out: string[] = [];
  let seed = 1;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % words.length;
  for (let i = 0; i < n; i++) {
    const s: string[] = [];
    for (let w = 0; w < 10; w++) s.push(words[next()]);
    s[0] = s[0][0].toUpperCase() + s[0].slice(1); // sentence split needs a capital after the dot
    out.push(`${s.join(" ")}.`);
  }
  return out.join(" ");
};

test("pickFragments respects the word-count window (8..25)", () => {
  const short = "Too short sentence here.";
  const ok = "Blackjack dealers must draw cards until the hand reaches seventeen points at most tables.";
  const long = ("Word " + "word ".repeat(29)).trim() + ".";
  const picked = pickFragments(splitSentences(`${short} ${ok} ${long}`));
  assert.equal(picked.length, 1);
  assert.equal(picked[0].text, ok);
});

test("pickFragments drops sentences with numbers, dates and prices", () => {
  const withNumber = "The wagering requirement of 40x applies to every single bonus claimed there.";
  const withDate = "Since January 2024 the regulator has required operators to display limits.";
  const withPrice = "The minimum deposit costs €10 while withdrawals remain free there always.";
  const clean = "Regulators require operators to display deposit limits clearly on every page.";
  const picked = pickFragments(splitSentences(`${withNumber} ${withDate} ${withPrice} ${clean}`));
  assert.equal(picked.length, 1);
  assert.equal(picked[0].text, clean);
});

test("pickFragments drops sentences quoting the keyword's distinctive tokens", () => {
  const branded = "Golden Acropolis members receive weekly cashback with transparent rules always.";
  const neutral = "Members receive weekly cashback with transparent and clearly written rules.";
  const picked = pickFragments(splitSentences(`${branded} ${neutral}`), { keyword: "Golden Acropolis bonus" });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].text, neutral);
});

test("pickFragments never exceeds the contract ceiling of 10", () => {
  const text = S(80);
  const picked = pickFragments(splitSentences(text));
  assert.equal(picked.length, MAX_FRAGMENTS);
});

test("pickFragments spreads over the text instead of clustering", () => {
  // 40 eligible sentences, 10 picked: the first and the last fifth of the text must both be
  // represented — a copied block at the end is as damning as one at the start.
  const text = S(40);
  const all = eligibleFragments(splitSentences(text));
  assert.ok(all.length >= 40);
  const picked = pickFragments(splitSentences(text));
  assert.equal(picked.length, 10);
  const positions = picked.map((p) => p.start);
  const firstHalf = positions.filter((p) => p < text.length / 2).length;
  const secondHalf = positions.length - firstHalf;
  assert.ok(firstHalf >= 3, `first half represented (${firstHalf}/10)`);
  assert.ok(secondHalf >= 3, `second half represented (${secondHalf}/10)`);
});

test("pickFragments prefers the rarest candidate inside each spread bucket", () => {
  const glue = "It is a fact that there are many of them in the world today.";
  const specific = "Wagering requirements follow unusually steep rollover ladders for recurring depositors.";
  const picked = pickFragments(splitSentences(normalizeTextForPlagiarism(`${glue} ${specific}`)), { max: 1 });
  assert.equal(picked.length, 1);
  assert.ok(picked[0].text.includes("rollover"));
});

test("eligibleFragments explains an empty sample (no sentence fits the window)", () => {
  const tiny = "Short. Sentences. Only. Here. Nothing. Fits. The. Window. At all.";
  assert.equal(eligibleFragments(splitSentences(tiny)).length, 0);
  assert.equal(pickFragments(splitSentences(tiny)).length, 0);
});

test("the window minimum is really eight words", () => {
  const seven = "Wagering rules apply to every bonus claimed.";
  const eight = "Wagering rules apply to every bonus claimed now.";
  assert.equal(seven.split(" ").length, MIN_FRAGMENT_WORDS - 1);
  const picked = pickFragments(splitSentences(`${seven} ${eight}`));
  assert.equal(picked.length, 1);
  assert.ok(picked[0].text.startsWith("Wagering rules apply to every bonus claimed now"));
});
