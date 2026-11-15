import assert from "node:assert/strict";
import test from "node:test";
import {
  blockFor, candidates, findRow, isPlainDomain, lookup, makeLimiter, normalizeQuery, parseHeader,
  parseIndex, transformLine, unreverseDomain,
} from "./lib.mjs";

const HEADER = "#harmonicc_pos\t#harmonicc_val\t#pr_pos\t#pr_val\t#host_rev\t#n_hosts";

test("ccrank: header is read by name, and an unknown header is refused", () => {
  assert.deepEqual(parseHeader(HEADER), { hcRank: 0, hcVal: 1, prRank: 2, prVal: 3, domain: 4, hosts: 5 });
  // The host-level file has no n_hosts column — still usable, hosts just stays empty.
  assert.equal(parseHeader("#harmonicc_pos\t#harmonicc_val\t#pr_pos\t#pr_val\t#host_rev").hosts, -1);
  assert.throws(() => parseHeader("#a\t#b"));
});

test("ccrank: rows are un-reversed, validated and reshaped", () => {
  const cols = parseHeader(HEADER);
  assert.equal(unreverseDomain("uk.co.example"), "example.co.uk");
  assert.equal(transformLine("12\t3.1E7\t40\t1.2E-6\tcom.example\t3", cols), "example.com\t12\t3.1E7\t40\t1.2E-6\t3");
  assert.equal(transformLine("#comment", cols), null);
  assert.equal(transformLine("x\t1\t1\t1\tcom.example\t1", cols), null);      // rank is not a number
  assert.equal(transformLine("5\t1\t1\t1\tcom.exa mple\t1", cols), null);     // not a host name
  assert.equal(transformLine("5\t1\t1\t1\tcom\t1", cols), null);              // a bare TLD
  assert.equal(isPlainDomain("xn--e1afmkfd.xn--p1ai"), true);
  assert.equal(isPlainDomain("exa_mple.com"), false);
});

test("ccrank: queries are normalised, and subdomains fall back toward the registered domain", () => {
  assert.equal(normalizeQuery("https://WWW.Example.com:443/path?q=1"), "example.com");
  assert.equal(normalizeQuery("пример.рф"), "xn--e1afmkfd.xn--p1ai");
  assert.equal(normalizeQuery("localhost"), null);
  assert.equal(normalizeQuery("a b.com"), null);
  assert.equal(normalizeQuery(""), null);
  assert.deepEqual(candidates("blog.shop.example.co.uk"), ["blog.shop.example.co.uk", "shop.example.co.uk", "example.co.uk", "co.uk"]);
  assert.deepEqual(candidates("example.com"), ["example.com"]);
});

// A small sorted dataset with a stride of 3, built the way build.mjs builds the real one.
function dataset(domains, stride = 3) {
  const sorted = [...domains].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let text = "", index = "";
  sorted.forEach((d, i) => {
    if (i % stride === 0) index += `${d}\t${Buffer.byteLength(text)}\n`;
    text += `${d}\t${i + 1}\t${1000 - i}\t${i + 5}\t0.001\t${(i % 4) + 1}\n`;
  });
  let reads = 0;
  return {
    ds: { release: "cc-main-test", total: sorted.length, index: parseIndex(index), size: Buffer.byteLength(text) },
    read: async (s, e) => { reads++; return Buffer.from(text).toString("latin1", s, e); },
    sorted, reads: () => reads,
  };
}

test("ccrank: every domain in the set is found, first/last/boundary rows included", async () => {
  const names = Array.from({ length: 200 }, (_, i) => `site${String(i).padStart(3, "0")}.com`).concat(["example.co.uk", "a-b.io", "zz.dev"]);
  const { ds, read, sorted } = dataset(names);
  for (const d of sorted) {
    const r = await lookup(ds, d, read);
    assert.equal(r.found, true, d);
    assert.equal(r.domain, d);
    assert.equal(r.hcRank, sorted.indexOf(d) + 1);
  }
});

test("ccrank: misses, neighbours and subdomain fallback", async () => {
  const { ds, read } = dataset(["example.co.uk", "example.com", "examples.com", "site.io"]);
  assert.equal((await lookup(ds, "exampl.com", read)).found, false);
  assert.equal((await lookup(ds, "example.comx", read)).found, false);
  assert.equal((await lookup(ds, "aaa.com", read)).found, false); // sorts before the first row
  assert.equal((await lookup(ds, "zzz.com", read)).found, false); // sorts after the last row
  const sub = await lookup(ds, "https://blog.shop.example.co.uk/x", read);
  assert.deepEqual({ q: sub.query, d: sub.domain, f: sub.found }, { q: "blog.shop.example.co.uk", d: "example.co.uk", f: true });
  assert.deepEqual(await lookup(ds, "not a domain", read), { query: "not a domain", found: false, error: "bad_domain" });
});

test("ccrank: block boundaries and row matching are exact", () => {
  const index = parseIndex("b.com\t0\nm.com\t100\nx.com\t250\n");
  assert.equal(blockFor(index, "a.com", 400), null);
  assert.deepEqual(blockFor(index, "b.com", 400), { start: 0, end: 100 });
  assert.deepEqual(blockFor(index, "m.zzz", 400), { start: 100, end: 250 });
  assert.deepEqual(blockFor(index, "z.com", 400), { start: 250, end: 400 });
  // "example.com" must not match the row of "example.com.br" or a row that merely contains it.
  const block = "example.com.br\t7\t1\t9\t0.1\t1\nmyexample.com\t8\t1\t9\t0.1\t1\n";
  assert.equal(findRow(block, "example.com"), null);
  assert.deepEqual(findRow(block, "myexample.com"), { domain: "myexample.com", hcRank: 8, hcVal: 1, prRank: 9, prVal: 0.1, hosts: 1 });
});

test("ccrank: rate limiter allows `limit` per window per key and recovers after it", () => {
  let t = 0;
  const allow = makeLimiter(3, 1000, () => t);
  assert.deepEqual([allow("a"), allow("a"), allow("a"), allow("a")], [true, true, true, false]);
  assert.equal(allow("b"), true);
  t = 1001;
  assert.equal(allow("a"), true);
});
