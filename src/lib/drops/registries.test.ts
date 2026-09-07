import assert from "node:assert/strict";
import test from "node:test";
import { tldOf, resolveProfile, profileForDomain, allProfiles, RDAP_BOOTSTRAP } from "./registries";

test("the effective TLD survives the spellings a real list contains", () => {
  assert.equal(tldOf("example.com"), "com");
  assert.equal(tldOf("EXAMPLE.COM"), "com");
  assert.equal(tldOf("example.com."), "com");
  assert.equal(tldOf("sub.deep.example.co.uk"), "co.uk");
  assert.equal(tldOf("shop.com.gr"), "com.gr");
  assert.equal(tldOf("plain.gr"), "gr");
});

test("things that are not registrable names return null", () => {
  assert.equal(tldOf(""), null);
  assert.equal(tldOf("com"), null);
  assert.equal(tldOf("co.uk"), null, "a two-label suffix is a zone, not a name");
  assert.equal(tldOf("a..com"), null);
  assert.equal(tldOf("has space.com"), null);
  assert.equal(tldOf("http://example.com/x"), null, "tldOf takes a host, not a URL");
});

// An IPv4-shaped row that is not a valid address slips past the IP guard in ingest; if "999"
// counted as a zone it would be asked about at a registry and reported unregistered.
test("a numeric last label is not a zone", () => {
  assert.equal(tldOf("999.999.999.999"), null);
  assert.equal(tldOf("1.2.3.4"), null);
});

test("punycode zones are zones", () => {
  assert.equal(tldOf("xn--80aswg.xn--p1ai"), "xn--p1ai");
});

test("known zones resolve to their own profile", () => {
  const com = resolveProfile("com");
  assert.equal(com.verified, true);
  assert.ok(com.rdap?.includes("verisign"));
  assert.equal(resolveProfile(".COM").tld, "com", "leading dot and case are accepted");
});

// The point of the module: an unknown zone must be slow and distrusted, not fast and believed.
test("an unknown zone gets a cautious bootstrap profile", () => {
  const p = resolveProfile("madeupzone");
  assert.equal(p.rdap, RDAP_BOOTSTRAP);
  assert.equal(p.verified, false);
  assert.ok(p.minIntervalMs >= 3000);
});

// .gr deliberately ships without an RDAP endpoint. Guessing one would hand the checker a 404
// from a bootstrap redirector that cannot route the zone, which reads as "free".
test(".gr has no guessed RDAP endpoint and cannot be bought on the registry answer alone", () => {
  const gr = resolveProfile("gr");
  assert.equal(gr.rdap, undefined);
  assert.equal(gr.needsRegistrarConfirm, true);
  assert.equal(gr.verified, false);
  assert.ok(gr.minIntervalMs >= 10_000, "a rate-limited registry gets a wide gap by default");
});

test("unverified profiles carry a note saying what still needs checking", () => {
  for (const p of allProfiles()) {
    if (!p.verified) {
      assert.ok(p.notes && p.notes.length > 0, `unverified profile ${p.tld} has no note`);
    }
  }
});

test("no zone is defined twice", () => {
  const tlds = allProfiles().map(p => p.tld);
  assert.equal(new Set(tlds).size, tlds.length);
});

test("every RDAP base ends in a slash so the domain can be appended", () => {
  for (const p of allProfiles()) {
    if (p.rdap) assert.ok(p.rdap.endsWith("/"), `${p.tld}: ${p.rdap}`);
  }
});

test("profileForDomain refuses a row that is not a domain", () => {
  assert.equal(profileForDomain("192.0.2.1"), null);
  assert.equal(profileForDomain("example.com")?.tld, "com");
});
