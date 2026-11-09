import assert from "node:assert/strict";
import test from "node:test";
import { snippetFragments, snippetFound } from "./snippet";

// ─── snippetFragments ─────────────────────────────────────────────────────────────

test("a leading date is stripped in en/ru/el/it shapes", () => {
  const cases = [
    "Mar 12, 2025 — Casino bonus for new players with wagering rules explained here",
    "12 мар. 2025 г. — Бонус казино для новых игроков с правилами отыгрыша здесь",
    "12 Μαρτίου 2025 — Μπόνους καζίνο για νέους παίκτες με κανόνες στοιχηματισμού",
    "12 mar 2025 — Bonus casino per nuovi giocatori con regole di puntata",
  ];
  for (const c of cases) {
    const frags = snippetFragments(c);
    assert.ok(frags.length >= 1, c);
    assert.ok(!frags[0].startsWith("mar"), c);
    assert.ok(!frags[0].includes("2025"), c);
  }
});

test("ellipses split the snippet into separate fragments", () => {
  const frags = snippetFragments("Casino bonus two hundred percent welcome package … wagering x35 applies to all slots");
  assert.equal(frags.length, 2);
  assert.equal(frags[0], "casino bonus two hundred percent welcome package");
});

test("short fragments (under 4 words) are dropped; punctuation collapses to spaces", () => {
  const frags = snippetFragments("Best casino… bonus! rules, wagering, limits — explained for players");
  assert.ok(frags.every(f => f.split(" ").filter(Boolean).length >= 4));
  assert.ok(!frags.join(" ").includes(","));
});

test("an empty snippet yields no fragments", () => {
  assert.deepEqual(snippetFragments(""), []);
  assert.deepEqual(snippetFragments("…"), []);
});

// ─── snippetFound ─────────────────────────────────────────────────────────────────

test("null cases: empty snippet or empty page text mean not-checked, not false", () => {
  assert.equal(snippetFound("", "page text"), null);
  assert.equal(snippetFound("some snippet words here", ""), null);
  assert.equal(snippetFound("   ", "   "), null);
});

test("a snippet present on the page reads true", () => {
  const page = "Welcome to the best casino review page with detailed bonus rules and wagering explained for players";
  assert.equal(snippetFound("Best casino review page with detailed bonus rules", page), true);
});

test("a snippet absent from the page reads false", () => {
  const page = "Completely different content about gardening tools and lawn mowers for the season";
  assert.equal(snippetFound("Best casino review page with bonus rules", page), false);
});

test("at least half of the fragments (rounded up) must hit", () => {
  const page = "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu";
  // 2 fragments: one hits, one misses → 1 >= ceil(2/2)=1 … wait: ceil(1.0)=1 → true
  assert.equal(snippetFound("Alpha beta gamma delta epsilon … This fragment is nowhere in the page at all", page), true);
  // 3 fragments: one hits, two miss → 1 < ceil(3/2)=2 → false
  assert.equal(
    snippetFound("Alpha beta gamma delta epsilon … Nowhere text one here … Nowhere text two here", page),
    false,
  );
});
