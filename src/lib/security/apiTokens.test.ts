import assert from "node:assert/strict";
import { test } from "node:test";
import { displayOf, isHashedForm, lookupForms, newToken, storedFormOf, tokenMatches } from "./apiTokens";

test("a new token has the prefix and 48 hex characters", () => {
  assert.match(newToken("ogsc_"), /^ogsc_[0-9a-f]{48}$/);
  assert.notEqual(newToken("ogsc_"), newToken("ogsc_"));
});

test("the stored form keeps only a short prefix and a hash", () => {
  const t = newToken("ogsc_");
  const s = storedFormOf(t);
  assert.ok(isHashedForm(s));
  assert.ok(!s.includes(t.slice(12)), "no secret part of the token in the stored form");
  assert.equal(s, storedFormOf(`  ${t} `), "whitespace from a paste does not change the key");
  assert.equal(displayOf(s), t.slice(0, 12) + "…");
});

test("lookup forms cover the hashed and the legacy plaintext row", () => {
  const t = newToken("ogsc_");
  assert.deepEqual(lookupForms(t), [storedFormOf(t), t]);
});

test("tokenMatches works for both storage shapes and nothing else", () => {
  const t = newToken("ogscext_");
  assert.equal(tokenMatches(t, storedFormOf(t)), true);
  assert.equal(tokenMatches(t, t), true, "legacy plaintext row");
  assert.equal(tokenMatches(newToken("ogscext_"), storedFormOf(t)), false);
  assert.equal(tokenMatches(t, null), false);
  assert.equal(tokenMatches("", storedFormOf(t)), false);
  // The stored form itself is not a credential.
  assert.equal(tokenMatches(storedFormOf(t), storedFormOf(t)), false);
});

test("displayOf for legacy rows and empty values", () => {
  assert.equal(displayOf("ogsc_0123456789abcdef"), "ogsc_0123456…");
  assert.equal(displayOf(null), null);
  assert.equal(displayOf(""), null);
});
