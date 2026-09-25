import test from "node:test";
import assert from "node:assert/strict";
import {
  MAIN_QUERY_MIN_IMPRESSIONS,
  STOP_WORDS,
  normalizeAuditUrl,
  normalizeToken,
  pageMatchesQuery,
  pickMainQuery,
  significantQueryTokens,
  textHasQueryToken,
} from "./queryAlign";

test("prefix matching: casino matches casinos, rtp matches only rtp", () => {
  assert.equal(textHasQueryToken("Best Casinos 2026", "casino"), true);   // prefix ≥ 4 chars
  assert.equal(textHasQueryToken("casinos en ligne", "casino"), true);
  assert.equal(textHasQueryToken("casinography of the web", "casino"), true); // prefix by design
  assert.equal(textHasQueryToken("rtprog tool", "rtp"), false);           // short token: whole word only
  assert.equal(textHasQueryToken("RTP live dealers", "rtp"), true);       // case-insensitive exact
});

test("stop-words of every supported language are dropped from the query", () => {
  // en/fr/es/de/it/pt/ru/el/uk lists live in the module; a word that is a stop-word in ANY
  // of them carries no alignment signal.
  assert.deepEqual(significantQueryTokens("the best casino"), ["best", "casino"]);
  assert.deepEqual(significantQueryTokens("meilleur casino en ligne"), ["meilleur", "casino", "ligne"]);
  assert.deepEqual(significantQueryTokens("как выиграть в казино"), ["выиграть", "казино"]);
  assert.deepEqual(significantQueryTokens("beste online casino"), ["beste", "online", "casino"]);
  assert.ok(STOP_WORDS.has(normalizeToken("und")));
  assert.ok(STOP_WORDS.has(normalizeToken("para")));
  assert.ok(STOP_WORDS.has(normalizeToken("e")));
  // A query that is all stop-words has nothing measurable — treated as aligned, rule silent.
  assert.deepEqual(significantQueryTokens("the and of"), []);
});

test("diacritics are stripped on both sides: démo matches demo", () => {
  assert.equal(normalizeToken("démo"), "demo");
  assert.equal(textHasQueryToken("La démo officielle du jeu", "demo"), true);
  assert.equal(pageMatchesQuery("Démo casino en ligne", "", "demo casino en ligne"), true);
});

test("pageMatchesQuery: title OR h1 carrying any significant token is aligned", () => {
  assert.equal(pageMatchesQuery("Casinos en ligne: le guide", "Nos jeux", "meilleur casino en ligne"), true);
  assert.equal(pageMatchesQuery("Jeux de hasard", "Casino géant", "meilleur casino en ligne"), true); // h1 carries it
  assert.equal(pageMatchesQuery("Jeux de hasard", "Nos jeux", "meilleur casino en ligne"), false);
});

test("URL normalization: slash, www, case, hash — both sides through one function", () => {
  // GSC reports one host form, the audit crawls the other; a trailing slash must not split them.
  assert.equal(normalizeAuditUrl("https://www.Example.com/en/"), normalizeAuditUrl("https://example.com/en"));
  assert.equal(normalizeAuditUrl("https://example.com/#top"), "https://example.com/");
  assert.equal(normalizeAuditUrl("https://example.com/page?a=1"), "https://example.com/page?a=1");
  assert.equal(normalizeAuditUrl("https://example.com/en/"), "https://example.com/en");
  assert.equal(normalizeAuditUrl("not a url"), "");
});

test("pickMainQuery: max impressions with a 20-impression floor", () => {
  assert.equal(MAIN_QUERY_MIN_IMPRESSIONS, 20);
  // The top query clears the floor → chosen even though another has more clicks (clicks are not the input).
  assert.deepEqual(
    pickMainQuery([{ query: "a", impressions: 19 }, { query: "b", impressions: 21 }, { query: "c", impressions: 500 }]),
    { query: "c", impressions: 500 },
  );
  // A single query under the floor → null: the rule stays silent rather than guessing.
  assert.equal(pickMainQuery([{ query: "a", impressions: 19 }]), null);
  assert.equal(pickMainQuery([]), null);
});
