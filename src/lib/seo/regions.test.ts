import assert from "node:assert/strict";
import test from "node:test";
import { COUNTRIES, LANGUAGES, defaultLanguageFor } from "./regions";

// The default-language map is hand-maintained next to the option lists, so two silent
// failure modes need guarding: a country added to the dropdown without a default would
// quietly preselect English again (the exact bug of issue #7), and a default whose code
// is missing from LANGUAGES would render as a blank entry in the language <select>.

test("every country has a default language that exists in LANGUAGES", () => {
  const langCodes = new Set(LANGUAGES.map(l => l.code));
  for (const c of COUNTRIES) {
    const def = defaultLanguageFor(c.code);
    assert.ok(langCodes.has(def), `default "${def}" for country ${c.code} is not a selectable language`);
  }
});

test("country and language codes are unique", () => {
  assert.equal(new Set(COUNTRIES.map(c => c.code)).size, COUNTRIES.length);
  assert.equal(new Set(LANGUAGES.map(l => l.code)).size, LANGUAGES.length);
});

test("lookup is case-insensitive and falls back to en", () => {
  assert.equal(defaultLanguageFor("US"), "en");
  assert.equal(defaultLanguageFor(" de "), "de");
  assert.equal(defaultLanguageFor("xx"), "en");
  assert.equal(defaultLanguageFor(""), "en");
});

test("market defaults match expectation", () => {
  assert.equal(defaultLanguageFor("ve"), "es"); // the issue #7 example
  assert.equal(defaultLanguageFor("ua"), "uk"); // Labs offers only uk/ru here — en hard-fails 40501
  assert.equal(defaultLanguageFor("de"), "de");
  assert.equal(defaultLanguageFor("jp"), "ja");
  assert.equal(defaultLanguageFor("by"), "ru"); // Russian-dominant web, not the official language
  assert.equal(defaultLanguageFor("za"), "en"); // same
  assert.equal(defaultLanguageFor("us"), "en");
});
