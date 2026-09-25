import assert from "node:assert/strict";
import test from "node:test";
import { e164Digits, normalizeToE164, phonesMatch } from "./phone";

test("the brief's three spellings normalise to one E.164 number", () => {
  assert.equal(normalizeToE164("+30 2310 123456", "gr"), "+302310123456");
  assert.equal(normalizeToE164("2310-123456", "gr"), "+302310123456");
  assert.equal(normalizeToE164("00302310123456", "gr"), "+302310123456");
  assert.equal(normalizeToE164("0030 2310 123456", "gr"), "+302310123456");
});

test("separators, tel: scheme and parentheses do not change the result", () => {
  assert.equal(normalizeToE164("tel:+302310123456", "gr"), "+302310123456");
  assert.equal(normalizeToE164("(2310) 12 34 56", "gr"), "+302310123456");
  assert.equal(normalizeToE164("+30 2310 123456", ""), "+302310123456"); // already international
});

test("a national number with a trunk 0 loses the trunk when the country code is added", () => {
  // UK 020 7946 0958 → +442079460958
  assert.equal(normalizeToE164("020 7946 0958", "gb"), "+442079460958");
});

test("a national number that already starts with the country code is not double-prefixed", () => {
  assert.equal(normalizeToE164("30 2310 123456", "gr"), "+302310123456");
});

test("garbage and too-short numbers return null", () => {
  assert.equal(normalizeToE164("", "gr"), null);
  assert.equal(normalizeToE164("abc", "gr"), null);
  assert.equal(normalizeToE164("12345", "gr"), null); // below the 6-digit plausibility floor
  assert.equal(normalizeToE164(null as unknown as string, "gr"), null);
});

test("unknown country without + stays a bare plausible number", () => {
  // No country code table entry and no + prefix: nothing to anchor to, kept as-is.
  assert.equal(normalizeToE164("697 123 4567", "zz"), "+6971234567");
});

test("e164Digits strips everything but digits", () => {
  assert.equal(e164Digits("+30 (2310) 12-34 56"), "302310123456");
  assert.equal(e164Digits(""), "");
});

test("phonesMatch compares digits, not formatting", () => {
  assert.ok(phonesMatch("+30 2310 123456", "+302310123456"));
  assert.ok(!phonesMatch("+302310123456", "+302310123457"));
  assert.ok(!phonesMatch("", "+302310123456"));
});
