import assert from "node:assert/strict";
import test from "node:test";
import { normaliseDomain, parseDomainList, summariseSkips } from "./ingest";

function ok(input: string): string {
  const res = normaliseDomain(input);
  assert.ok("domain" in res, `expected ${input} to normalise, got ${JSON.stringify(res)}`);
  return res.domain;
}

function rejected(input: string): string {
  const res = normaliseDomain(input);
  assert.ok("reason" in res, `expected ${input} to be rejected, got ${JSON.stringify(res)}`);
  return res.reason;
}

test("every spelling of one name collapses to the same host", () => {
  for (const form of [
    "example.com",
    "  example.com  ",
    "EXAMPLE.COM",
    "http://example.com",
    "https://example.com/",
    "https://example.com/some/path?q=1#frag",
    "example.com.",
    "example.com:8080",
    "https://user:pass@example.com/x",
    '"example.com"',
    "<example.com>",
  ]) {
    assert.equal(ok(form), "example.com", form);
  }
});

test("www is not stripped — it is a different host and a different registration question", () => {
  // Left deliberately: a list of subdomains must not silently collapse into one row.
  assert.equal(ok("www.example.com"), "www.example.com");
});

// The row class that made it through the source post's whole pipeline and came out "free",
// because no registry holds a record for an IP.
test("IP addresses are rejected, not treated as unregistered domains", () => {
  assert.equal(rejected("192.0.2.1"), "ip_address");
  assert.equal(rejected("8.8.8.8"), "ip_address");
  assert.equal(rejected("http://203.0.113.7/index.html"), "ip_address");
  assert.equal(rejected("2001:db8::1"), "ip_address");
  // Four numeric labels that are not a valid IP are still not a domain anyone can register.
  assert.equal(rejected("999.999.999.999"), "not_registrable");
});

test("malformed rows are rejected with a reason rather than passed through", () => {
  assert.equal(rejected(""), "empty");
  assert.equal(rejected("   "), "empty");
  assert.equal(rejected("localhost"), "no_dot");
  assert.equal(rejected("-bad.com"), "bad_label");
  assert.equal(rejected("bad-.com"), "bad_label");
  assert.equal(rejected("a..com"), "bad_label");
  assert.equal(rejected("what is this"), "bad_characters");
  assert.equal(rejected("a".repeat(64) + ".com"), "bad_label");
});

// 191, not 253: `domain` is half of DropCandidate's composite unique key, and Prisma maps a
// String key to VARCHAR(191) on MySQL. Accepting a longer name here would produce a row that
// writes fine on SQLite and throws on MySQL — a bug that never reproduces where it was written.
test("the length cap is the storage limit, not the DNS one", () => {
  const label = "a".repeat(60);
  const long = [label, label, label, "com"].join(".");   // 63*3 + 4 = 187 chars, still fine
  assert.equal(ok(long), long);
  assert.equal(rejected([label, label, label, label, "com"].join(".")), "too_long");
});

test("a bare zone is not a registrable name", () => {
  assert.equal(rejected("com"), "no_dot");
  assert.equal(rejected("co.uk"), "not_registrable");
  assert.equal(ok("shop.co.uk"), "shop.co.uk");
});

test("IDN passes through unchanged in both spellings", () => {
  // Converting here would make two spellings of one name look like two candidates; the
  // checker canonicalises later, where it can do it once.
  assert.equal(ok("сайт.рф"), "сайт.рф");
  assert.equal(ok("xn--80aswg.xn--p1ai"), "xn--80aswg.xn--p1ai");
});

test("CSV: the domain is found whatever column it sits in", () => {
  const csv = [
    "id,domain,dr",
    "1,example.com,12",
    "2,foo.org,8",
    "dr,url",           // header row: no field normalises, so the row is skipped
    "34,https://bar.net/page",
  ].join("\n");
  const res = parseDomainList(csv);
  assert.deepEqual(res.domains, ["example.com", "foo.org", "bar.net"]);
});

test("duplicates are counted, not silently dropped", () => {
  const res = parseDomainList("example.com\nEXAMPLE.COM\nhttps://example.com/x\nother.com");
  assert.deepEqual(res.domains, ["example.com", "other.com"]);
  assert.equal(summariseSkips(res.skipped).duplicate, 2);
});

test("a mixed real-world blob reports what it dropped and why", () => {
  const res = parseDomainList([
    "good-one.com",
    "192.0.2.55",
    "",
    "localhost",
    "second.org",
    "not a domain at all",
  ].join("\n"));
  assert.deepEqual(res.domains, ["good-one.com", "second.org"]);
  const summary = summariseSkips(res.skipped);
  assert.equal(summary.ip_address, 1);
  assert.equal(summary.no_dot, 1);
  assert.equal(summary.bad_characters, 1);
  assert.equal(res.skipped.length, 3, "blank lines are not 'skipped rows'");
});
