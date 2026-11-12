import assert from "node:assert/strict";
import test from "node:test";
import { parseXmlRiverVerdict } from "./checkProvider";

// The XR answer shapes seen across their API and our three integrations (validate route,
// xr-donors, the legacy panel button). The parser is the single place they are agreed on.

test("parseXmlRiverVerdict: top-level indexed", () => {
  assert.equal(parseXmlRiverVerdict({ indexed: true }).status, "indexed");
  assert.equal(parseXmlRiverVerdict({ indexed: false }).status, "not_indexed");
});

test("parseXmlRiverVerdict: nested content.indexed / content.index === 'yes'", () => {
  assert.equal(parseXmlRiverVerdict({ content: { indexed: true } }).status, "indexed");
  assert.equal(parseXmlRiverVerdict({ content: { index: "yes" } }).status, "indexed");
  assert.equal(parseXmlRiverVerdict({ content: { index: "no" } }).status, "not_indexed");
});

test("parseXmlRiverVerdict: an error answer is error — never a verdict (§0.6)", () => {
  const r = parseXmlRiverVerdict({ error: "captcha", indexed: true });
  assert.equal(r.status, "error");
  assert.equal(r.detail, "captcha");
  // An error beats an indexed claim in the same payload.
  assert.equal(parseXmlRiverVerdict({ error: 7 }).status, "error");
});

test("parseXmlRiverVerdict: junk is our error, not a quiet not_indexed", () => {
  assert.equal(parseXmlRiverVerdict(null).status, "error");
  assert.equal(parseXmlRiverVerdict("ok").status, "error");
  assert.equal(parseXmlRiverVerdict([1, 2]).status, "error");
});
