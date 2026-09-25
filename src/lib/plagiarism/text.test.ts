import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTextForPlagiarism, splitSentences, tokenizeWords } from "./text";

test("normalizeTextForPlagiarism strips markdown furniture but keeps prose", () => {
  const raw = [
    "---",
    "title: Best Casino Bonuses",
    "description: A guide",
    "---",
    "## The Welcome Bonus",
    "",
    "Every licensed **casino** offers a *welcome* package with `wagering` rules.",
    "![chart](https://img.example.com/x.png)",
    "[Read the terms](https://example.com/terms) before you claim anything at all.",
    "| casino | bonus |",
    "| --- | --- |",
    "| Acme | 100 |",
    "- Bullet one with ordinary words here now",
    "",
    "Further reading:",
    "- https://example.com/one",
    "- https://example.com/two",
  ].join("\n");

  const out = normalizeTextForPlagiarism(raw);
  assert.ok(out.includes("Every licensed casino offers a welcome package with wagering rules."), "bold/italic/code stripped, prose kept");
  assert.ok(out.includes("Bullet one with ordinary words here now"), "list bullet stripped, text kept");
  assert.ok(!out.includes("title: Best Casino Bonuses"), "meta block removed");
  assert.ok(!out.includes("The Welcome Bonus"), "heading removed");
  assert.ok(!out.includes("img.example.com"), "image removed");
  assert.ok(!out.includes("|"), "table removed");
  assert.ok(!out.includes("example.com/one"), "link-list line removed");
  assert.ok(out.includes("Read the terms before you claim anything at all."), "link text kept, href dropped");
});

test("normalizeTextForPlagiarism decodes HTML entities so quoted search matches the source", () => {
  const out = normalizeTextForPlagiarism("Terms &amp; conditions apply &quot;always&quot; &nbsp; here");
  assert.ok(out.includes('Terms & conditions apply "always" here'));
});

test("splitSentences cuts on terminator + capital and keeps offsets into the text", () => {
  const text = "Blackjack pays three to two in most casinos. The dealer must hit until sixteen! Insurance is a side bet; avoid it.";
  const sentences = splitSentences(text);
  assert.equal(sentences.length, 3);
  assert.equal(sentences[0].text, "Blackjack pays three to two in most casinos.");
  assert.equal(sentences[2].text.startsWith("Insurance"), true);
  for (const s of sentences) {
    assert.equal(text.slice(s.start, s.start + s.text.length), s.text, "offset points at the sentence");
  }
});

test("splitSentences keeps decimal numbers glued (a digit never starts a sentence)", () => {
  const text = "The company reported 3.5 million registered players across regulated markets.";
  const sentences = splitSentences(text);
  assert.equal(sentences.length, 1);
  assert.equal(sentences[0].text, text);
});

test("splitSentences does cut after an abbreviation followed by a capital (known tradeoff)", () => {
  // "St. James" splits: the boundary rule is terminator + whitespace + sentence-start, and an
  // abbreviation table is not worth the complexity. The cost is a shorter candidate that the
  // 8–25 word window filters — never a wrong match.
  const sentences = splitSentences("St. James Street hosts several bookmakers that open early.");
  assert.equal(sentences.length, 2);
  assert.equal(sentences[0].text, "St.");
  assert.equal(sentences[1].text, "James Street hosts several bookmakers that open early.");
});

test("tokenizeWords lowercases and drops punctuation, keeps apostrophes and digits", () => {
  assert.deepEqual(tokenizeWords("It's a 25x Wager — right?"), ["it's", "a", "25x", "wager", "right"]);
});
