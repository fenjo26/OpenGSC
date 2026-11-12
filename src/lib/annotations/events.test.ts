import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeEventType, isPrefixMove, normalizePrefix, likePrefix, checkPrefixInProperty, inferMoveType,
} from "./events";

test("event type: unknown values fall back to note", () => {
  assert.equal(normalizeEventType("folder_move"), "folder_move");
  assert.equal(normalizeEventType("FOLDER_MOVE"), "note");
  assert.equal(normalizeEventType(undefined), "note");
  assert.equal(normalizeEventType("purchase"), "note");
});

test("only folder and subdomain moves are scored by prefix", () => {
  assert.equal(isPrefixMove("folder_move"), true);
  assert.equal(isPrefixMove("subdomain_move"), true);
  assert.equal(isPrefixMove("domain_move"), false);
  assert.equal(isPrefixMove("note"), false);
});

test("prefix: trailing slash added so /old never matches /older", () => {
  assert.equal(normalizePrefix("https://x.com/old"), "https://x.com/old/");
  assert.equal(normalizePrefix("x.com/old/"), "https://x.com/old/");
  assert.equal(normalizePrefix("https://X.com"), "https://x.com/");
  assert.equal(normalizePrefix("https://x.com/old/?a=1#f"), "https://x.com/old/");
  assert.equal(normalizePrefix("https://new.x.com"), "https://new.x.com/");
});

test("prefix: rejects things that are not URLs", () => {
  assert.equal(normalizePrefix(""), null);
  assert.equal(normalizePrefix("old folder"), null);
  assert.equal(normalizePrefix("ftp://x.com/"), null);
  assert.equal(normalizePrefix("localhost/a"), null);
});

test("LIKE pattern escapes wildcards with !", () => {
  assert.equal(likePrefix("https://x.com/a_b/"), "https://x.com/a!_b/%");
  assert.equal(likePrefix("https://x.com/100%/"), "https://x.com/100!%/%");
  assert.equal(likePrefix("https://x.com/hey!/"), "https://x.com/hey!!/%");
});

test("domain property covers every subdomain, nothing else", () => {
  assert.equal(checkPrefixInProperty("https://x.com/a/", "sc-domain:x.com"), "ok");
  assert.equal(checkPrefixInProperty("https://new.x.com/", "sc-domain:x.com"), "ok");
  assert.equal(checkPrefixInProperty("https://notx.com/", "sc-domain:x.com"), "outside");
  assert.equal(checkPrefixInProperty("https://x.com.evil.io/", "sc-domain:x.com"), "outside");
});

test("URL-prefix property covers only its prefix", () => {
  assert.equal(checkPrefixInProperty("https://x.com/a/", "https://x.com/"), "ok");
  assert.equal(checkPrefixInProperty("http://x.com/a/", "https://x.com/"), "ok");
  assert.equal(checkPrefixInProperty("https://new.x.com/", "https://x.com/"), "outside");
  assert.equal(checkPrefixInProperty("https://x.com/a/", "https://x.com/blog/"), "outside");
});

test("move type inferred from hosts", () => {
  assert.equal(inferMoveType("https://x.com/old/", "https://x.com/new/"), "folder_move");
  assert.equal(inferMoveType("https://www.x.com/", "https://x.com/new/"), "folder_move");
  assert.equal(inferMoveType("https://x.com/", "https://new.x.com/"), "subdomain_move");
});
