import assert from "node:assert/strict";
import test from "node:test";
import {
  corsDecision, corsHeaders, effectiveOrigin, extensionIdFromOrigin, normalizeAllowedIdsInput, parseAllowedIds,
} from "./origin";

// N11 — CORS decisions for /api/ext/** (docs/tasks/wave-nov/N11-browser-extension.md):
// Access-Control-Allow-Origin only for chrome-extension://<id> listed in User.extAllowedIds.

const ID_A = "abcdefghijklmnopabcdefghijklmnop";
const ID_B = "ponmlkjihgfedcbaponmlkjihgfedcba";

test("extensionIdFromOrigin reads the id out of a chrome-extension origin", () => {
  assert.equal(extensionIdFromOrigin(`chrome-extension://${ID_A}`), ID_A);
  assert.equal(extensionIdFromOrigin(`chrome-extension://${ID_A.toUpperCase()}`), ID_A);
});

test("extensionIdFromOrigin rejects everything that is not a 32-char a–p extension id", () => {
  assert.equal(extensionIdFromOrigin("https://evil.example"), null);
  assert.equal(extensionIdFromOrigin("chrome-extension://short"), null);
  assert.equal(extensionIdFromOrigin(`chrome-extension://${ID_A}x`), null);
  assert.equal(extensionIdFromOrigin(`chrome-extension://qrstuvwxyzqrstuvwxyzqrstuvwxyz`), null); // q–z are not in the id alphabet
  assert.equal(extensionIdFromOrigin(null), null);
  assert.equal(extensionIdFromOrigin(""), null);
});

test("parseAllowedIds splits newline-separated ids, tolerating spaces, commas and duplicates", () => {
  assert.deepEqual(parseAllowedIds(`${ID_A}\n${ID_B}`), [ID_A, ID_B]);
  assert.deepEqual(parseAllowedIds(`${ID_A}, ${ID_B}\n\n${ID_A}`), [ID_A, ID_B]);
  assert.deepEqual(parseAllowedIds(null), []);
  assert.deepEqual(parseAllowedIds(""), []);
});

test("corsDecision allows exactly the listed extension origin", () => {
  const decision = corsDecision(`chrome-extension://${ID_A}`, `${ID_B}\n${ID_A}`);
  assert.deepEqual(decision, { allow: true, id: ID_A, reason: null });
});

test("corsDecision denies a listed-format id that is not on the allowlist", () => {
  const decision = corsDecision(`chrome-extension://${ID_A}`, ID_B);
  assert.deepEqual(decision, { allow: false, id: ID_A, reason: "not_allowed" });
});

test("corsDecision denies empty allowlists, non-extension origins and missing origins", () => {
  assert.deepEqual(corsDecision(`chrome-extension://${ID_A}`, null), { allow: false, id: ID_A, reason: "not_allowed" });
  assert.deepEqual(corsDecision("https://evil.example", ID_A), { allow: false, id: null, reason: "not_extension" });
  assert.deepEqual(corsDecision(null, ID_A), { allow: false, id: null, reason: "no_origin" });
  assert.deepEqual(corsDecision("", ID_A), { allow: false, id: null, reason: "no_origin" });
});

test("corsHeaders names the one origin that was checked — never *", () => {
  const headers = corsHeaders(`chrome-extension://${ID_A}`);
  assert.equal(headers["Access-Control-Allow-Origin"], `chrome-extension://${ID_A}`);
  assert.equal(headers.Vary, "Origin");
  assert.ok(headers["Access-Control-Allow-Headers"].includes("Authorization"));
});

test("normalizeAllowedIdsInput keeps valid ids, drops and reports the rest", () => {
  const result = normalizeAllowedIdsInput(`${ID_A}\nnot-an-id\n${ID_B}`);
  assert.deepEqual(result.kept, [ID_A, ID_B]);
  assert.deepEqual(result.dropped, ["not-an-id"]);
  assert.equal(result.value, `${ID_A}\n${ID_B}`);
});

test("normalizeAllowedIdsInput collapses duplicates", () => {
  const result = normalizeAllowedIdsInput(`${ID_A} ${ID_A}`);
  assert.deepEqual(result.kept, [ID_A]);
  assert.equal(result.value, ID_A);
});

test("effectiveOrigin prefers the real Origin and falls back to the extension-id header", () => {
  // Chrome sends no Origin on a GET once the extension holds a host permission for the instance.
  assert.equal(effectiveOrigin(`chrome-extension://${ID_A}`, ID_B), `chrome-extension://${ID_A}`);
  assert.equal(effectiveOrigin(null, ID_A), `chrome-extension://${ID_A}`);
  assert.equal(effectiveOrigin("", ID_A.toUpperCase()), `chrome-extension://${ID_A}`);
  assert.equal(effectiveOrigin(null, "not-an-id"), null);
  assert.equal(effectiveOrigin(null, null), null);
  // the header never overrides a present Origin — a web page cannot borrow an extension id
  assert.equal(corsDecision(effectiveOrigin("https://evil.example", ID_A), ID_A).allow, false);
  assert.equal(corsDecision(effectiveOrigin(null, ID_A), ID_A).allow, true);
});
