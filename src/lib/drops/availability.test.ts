import assert from "node:assert/strict";
import test from "node:test";
import { sanitiseForUrl } from "./availability";

// The domain is concatenated into an RDAP endpoint, so this is the last line between a row in a
// user-supplied CSV and an outbound request to an address that row chose.
test("only LDH characters and dots survive into a URL", () => {
  assert.equal(sanitiseForUrl("Example.COM"), "example.com");
  assert.equal(sanitiseForUrl("  example.com  "), "example.com");
  assert.equal(sanitiseForUrl("example.com/../../admin"), "example.com....admin");
  assert.equal(sanitiseForUrl("example.com?x=1"), "example.comx1");
  assert.equal(sanitiseForUrl("evil.com@internal.host"), "evil.cominternal.host");
  assert.equal(sanitiseForUrl("a b.com"), "ab.com");
  assert.equal(sanitiseForUrl("http://example.com"), "httpexample.com");
});

test("a sanitised value never contains a path, query, fragment or authority separator", () => {
  for (const nasty of ["a/b.com", "a?b.com", "a#b.com", "a@b.com", "a:b.com", "a\\b.com", "a%2f.com"]) {
    const clean = sanitiseForUrl(nasty);
    for (const ch of ["/", "?", "#", "@", ":", "\\", "%"]) {
      assert.ok(!clean.includes(ch), `${nasty} -> ${clean} still contains ${ch}`);
    }
  }
});
