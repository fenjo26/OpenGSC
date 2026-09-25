import assert from "node:assert/strict";
import test from "node:test";
import { checkExtToken, EXT_TOKEN_PREFIX, isExtTokenFormat, tokenKey } from "./token";
import { randomBytes } from "crypto";

// N11 — token verification decisions (docs/tasks/wave-nov/N11-browser-extension.md):
// no token / wrong token / revoked token, plus format and rate-limit key derivation.

const mint = () => EXT_TOKEN_PREFIX + randomBytes(24).toString("hex");

test("tokens the route mints always pass the format check", () => {
  for (let i = 0; i < 50; i++) assert.equal(isExtTokenFormat(mint()), true);
});

test("format rejects MCP tokens, empties and near-misses", () => {
  assert.equal(isExtTokenFormat("ogsc_" + "a".repeat(48)), false); // the MCP token's prefix
  assert.equal(isExtTokenFormat(""), false);
  assert.equal(isExtTokenFormat("ogscext_zzz"), false);
  assert.equal(isExtTokenFormat(EXT_TOKEN_PREFIX + "a".repeat(47)), false);
});

test("checkExtToken: a matching token passes", () => {
  const token = mint();
  assert.deepEqual(checkExtToken(`Bearer ${token}`, token), { ok: false, reason: "format" }); // not a bare token
  assert.deepEqual(checkExtToken(token, token), { ok: true, reason: null });
});

test("checkExtToken: missing header → missing", () => {
  assert.deepEqual(checkExtToken(null, mint()), { ok: false, reason: "missing" });
  assert.deepEqual(checkExtToken("", mint()), { ok: false, reason: "missing" });
  assert.deepEqual(checkExtToken("   ", mint()), { ok: false, reason: "missing" });
});

test("checkExtToken: a token with the wrong prefix → format", () => {
  assert.deepEqual(checkExtToken("ogsc_" + "0".repeat(48), mint()), { ok: false, reason: "format" });
});

test("checkExtToken: revoked (nothing stored anymore) → revoked", () => {
  assert.deepEqual(checkExtToken(mint(), null), { ok: false, reason: "revoked" });
  assert.deepEqual(checkExtToken(mint(), ""), { ok: false, reason: "revoked" });
});

test("checkExtToken: someone else's token → mismatch", () => {
  assert.deepEqual(checkExtToken(mint(), mint()), { ok: false, reason: "mismatch" });
});

test("checkExtToken tolerates surrounding whitespace the clipboard added", () => {
  const token = mint();
  assert.deepEqual(checkExtToken(`  ${token}\n`, token), { ok: true, reason: null });
});

test("tokenKey is stable, salt-free and never the raw token", () => {
  const token = mint();
  assert.equal(tokenKey(token), tokenKey(token));
  assert.notEqual(tokenKey(token), token);
  assert.equal(tokenKey(token).length, 64); // sha256 hex
});
