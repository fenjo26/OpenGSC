import assert from "node:assert/strict";
import test from "node:test";
import { snippetFragments, snippetFound, htmlToText } from "./snippet";

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


// ─── shingle tolerance (real Google shape, 2026-11-09) ────────────────────────────

test("a fragment survives the words Google drops: the Wikipedia (SEO) case", () => {
  // Google's snippet: "Search engine optimization is the process of improving the quality and
  // quantity of website traffic" — the page's lead inserts "(SEO)" after the first word.
  const page = "Search engine optimization (SEO) is the process of improving the quality and quantity of website traffic to a website or a web page from search engines.";
  assert.equal(snippetFound("Search engine optimization is the process of improving the quality and quantity of website traffic", page), true);
});

test("shingle tolerance has a floor: mostly-absent fragments still read false", () => {
  const page = "Gardening tools and lawn mowers for the new season with free delivery everywhere";
  assert.equal(snippetFound("Best casino review page with detailed bonus rules for players", page), false);
});

test("the exact-match behavior of old still holds for clean fragments", () => {
  const page = "Welcome to the best casino review page with detailed bonus rules and wagering explained for players";
  assert.equal(snippetFound("Best casino review page with detailed bonus rules", page), true);
});

// ─── htmlToText (the bodyText-cap fallback) ───────────────────────────────────────

test("htmlToText: strips script/style/tags, decodes entities, keeps the words", () => {
  const html = '<html><head><style>.x{color:red}</style><script>var a = "Search engine optimization";</script></head>'
    + '<body><h1>Search engine optimization</h1><p>(SEO) is the process of improving&nbsp;traffic. &amp; more</p>'
    + '<!-- comment --></body></html>';
  const text = htmlToText(html);
  assert.ok(!text.includes("color:red"), "style stripped");
  assert.ok(!text.includes("var a"), "script stripped");
  assert.ok(text.includes("Search engine optimization"));
  assert.ok(text.includes("(SEO) is the process of improving traffic."), "nbsp decoded: " + text);
  assert.ok(text.includes("& more"), "entity decoded");
  assert.ok(!text.includes("comment"), "html comment stripped");
});

test("htmlToText: matching a snippet through the fallback works end to end", () => {
  // the shape the cloak route builds: bodyText truncated inside nav chrome + full raw html
  const bodyText = "Wikipedia Jump to content Main menu " + "x".repeat(40000);
  const htmlRaw = "<div>Search engine optimization (SEO) is the process of improving the quality and quantity of website traffic</div>";
  assert.equal(
    snippetFound("Search engine optimization is the process of improving the quality and quantity of website traffic", bodyText + "\n" + htmlToText(htmlRaw)),
    true,
  );
});
