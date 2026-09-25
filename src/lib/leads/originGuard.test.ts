import test from "node:test";
import assert from "node:assert/strict";

// N9 — Origin/Referer allow-list for the public widget routes.

import { checkOrigin, normalizeOriginHost, refererHost } from "./originGuard";

test("empty allow-list allows everything (the operator's explicit choice)", () => {
  assert.equal(checkOrigin("https://spam.example", null, []), true);
  assert.equal(checkOrigin(null, null, []), true);
});

test("an allowed host matches itself and its subdomains, case-insensitively", () => {
  assert.equal(checkOrigin("https://agency.com", null, ["agency.com"]), true);
  assert.equal(checkOrigin("https://WWW.Agency.com", null, ["agency.com"]), true);
  assert.equal(checkOrigin("https://clients.agency.com", null, ["agency.com"]), true);
  assert.equal(checkOrigin(null, "https://agency.com/pricing", ["https://agency.com"]), true);
});

test("a host that is not allowed is refused", () => {
  assert.equal(checkOrigin("https://notagency.com", null, ["agency.com"]), false);
  // notagency.com merely ends with the string — the subdomain rule requires a dot boundary.
  assert.equal(checkOrigin("https://notagency.com", null, ["agency.com"]), false);
  assert.equal(checkOrigin("https://agency.com.evil.io", null, ["agency.com"]), false);
});

test("Referer is used when Origin is absent; both absent with an allow-list means refusal", () => {
  assert.equal(checkOrigin(null, "https://agency.com/some/page", ["agency.com"]), true);
  assert.equal(checkOrigin(null, "https://evil.io/x", ["agency.com"]), false);
  assert.equal(checkOrigin(null, null, ["agency.com"]), false);
  assert.equal(checkOrigin("", "garbage", ["agency.com"]), false);
});

test("subdomain strings do not match the parent of a different domain", () => {
  assert.equal(checkOrigin("https://sub.agency.com", null, ["other.com"]), false);
});

test("normalizeOriginHost/refererHost tolerate junk", () => {
  assert.equal(normalizeOriginHost(""), "");
  assert.equal(normalizeOriginHost("not a url"), "");
  assert.equal(normalizeOriginHost("https://Blog.Example.com/"), "blog.example.com");
  assert.equal(refererHost(null), "");
  assert.equal(refererHost("not-a-url"), "");
  assert.equal(refererHost("https://agency.com/page?x=1"), "agency.com");
});
