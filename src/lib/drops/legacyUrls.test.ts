import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_URL_CAP, capLegacyUrls, gscPageUrls, normalizeUrlSet, parseCdxOriginals,
} from "./legacyUrls";

// ── parseCdxOriginals: CDX JSON rows → candidate URLs ────────────────────────────

test("a CDX reply turns into its original-URL column, header excluded", () => {
  const rows = [
    ["original"],
    ["https://example.gr/"],
    ["http://example.gr/a?x=1"],
    ["https://example.gr/b"],
  ];
  assert.deepEqual(parseCdxOriginals(rows), [
    "https://example.gr/",
    "http://example.gr/a?x=1",
    "https://example.gr/b",
  ]);
});

test("a malformed CDX reply yields zero candidates, never a guess", () => {
  assert.deepEqual(parseCdxOriginals([]), []);
  assert.deepEqual(parseCdxOriginals([["original"]]), []); // header only — nothing archived
  assert.deepEqual(parseCdxOriginals("junk"), []);
  assert.deepEqual(parseCdxOriginals(null), []);
  // Non-array cells are skipped, not stringified into fake URLs.
  assert.deepEqual(parseCdxOriginals([["original"], ["ok"], [null], [""], "flat"]), ["ok"]);
});

// ── normalizeUrlSet: the fixture rows the acceptance names ───────────────────────

test("foreign hosts drop, fragments strip, uppercase hosts fold — and the survivor list dedupes", () => {
  const cdxRows = [
    ["original"],
    ["https://Example.GR/a?x=1#frag"],   // uppercase host + fragment
    ["https://example.gr/a?x=1"],        // the same URL after both normalizations
    ["http://www.example.gr/b"],         // the www twin is the asset host
    ["https://other.gr/a"],              // foreign host — dropped
    ["https://blog.example.gr/c"],       // subdomain is NOT the host twin — dropped
    ["ftp://example.gr/d"],              // not http(s) — dropped
    ["not a url"],
    [""],
  ];
  assert.deepEqual(normalizeUrlSet(parseCdxOriginals(cdxRows), "example.gr"), [
    "https://example.gr/a?x=1",
    "http://www.example.gr/b",
  ]);
});

test("an empty or all-foreign candidate list stays empty", () => {
  assert.deepEqual(normalizeUrlSet([], "example.gr"), []);
  assert.deepEqual(normalizeUrlSet(["https://a.gr/", "https://b.gr/"], "example.gr"), []);
});

// ── gscPageUrls: queryGsc rows → page dimension ─────────────────────────────────

test("gsc page rows yield keys[0]; keyless rows and non-arrays yield nothing", () => {
  const rows = [
    { keys: ["https://example.gr/"], clicks: 4 },
    { keys: ["https://example.gr/a"], clicks: 0 },
    { keys: [] },
    { keys: null },
    { clicks: 3 },
  ];
  assert.deepEqual(gscPageUrls(rows), ["https://example.gr/", "https://example.gr/a"]);
  assert.deepEqual(gscPageUrls(null), []);
  assert.deepEqual(gscPageUrls("nope"), []);
});

// ── capLegacyUrls: the 50 000 per-asset ceiling ──────────────────────────────────

test("a fresh asset stores at most 50 000 URLs, cut from the front", () => {
  const incoming = Array.from({ length: 60_000 }, (_, i) => `https://example.gr/p${i}`);
  const full = capLegacyUrls(0, incoming);
  assert.equal(LEGACY_URL_CAP, 50_000);
  assert.equal(full.urls.length, 50_000);
  assert.equal(full.urls[49_999], "https://example.gr/p49999");
  assert.equal(full.capped, true);
});

test("the cap is per asset: stored rows eat into the next harvest's room", () => {
  const incoming = Array.from({ length: 10 }, (_, i) => `https://example.gr/p${i}`);
  const room = capLegacyUrls(49_995, incoming);
  assert.deepEqual(room.urls, incoming.slice(0, 5));
  assert.equal(room.capped, true);

  const overflow = capLegacyUrls(50_000, incoming);
  assert.deepEqual(overflow.urls, []);
  assert.equal(overflow.capped, true);
});

test("a list that fits is stored whole and not flagged capped", () => {
  const fits = capLegacyUrls(10, ["https://example.gr/a"]);
  assert.deepEqual(fits.urls, ["https://example.gr/a"]);
  assert.equal(fits.capped, false);

  // Nothing incoming, no room either — nothing was cut, so not capped.
  const empty = capLegacyUrls(50_000, []);
  assert.deepEqual(empty.urls, []);
  assert.equal(empty.capped, false);
});
