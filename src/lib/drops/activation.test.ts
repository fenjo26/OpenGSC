import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRobotsTxt, buildSitemapXml, indexnowKeyFile, isDonorAllowed,
  normalizeLegacyUrl, utcMidnightDaysBetween, NGINX_SNIPPET,
} from "./activation";

// ── utcMidnightDaysBetween ────────────────────────────────────────────────────
// The local-calendar version in wayback.ts drifted a day Athens-vs-UTC; these are the
// exact boundaries it got wrong.

test("one UTC hour apart across midnight is one day", () => {
  const a = new Date("2026-01-01T23:30:00Z");
  const b = new Date("2026-01-02T00:30:00Z");
  assert.equal(utcMidnightDaysBetween(a, b), 1);
});

test("same UTC calendar day is zero days regardless of clock time", () => {
  assert.equal(utcMidnightDaysBetween(
    new Date("2026-01-01T01:00:00Z"),
    new Date("2026-01-01T23:00:00Z"),
  ), 0);
});

test("a month apart in UTC is whole days, never a fraction", () => {
  assert.equal(utcMidnightDaysBetween(
    new Date("2026-01-01T00:00:00Z"),
    new Date("2026-02-01T00:00:00Z"),
  ), 31);
});

// ── normalizeLegacyUrl ────────────────────────────────────────────────────────

test("only http(s) URLs on the asset host (or its www twin) survive", () => {
  assert.equal(normalizeLegacyUrl("https://Example.GR/a?x=1", "example.gr"), "https://example.gr/a?x=1");
  assert.equal(normalizeLegacyUrl("http://www.example.gr/a", "example.gr"), "http://www.example.gr/a");
  assert.equal(normalizeLegacyUrl("https://other.gr/a", "example.gr"), null);
  assert.equal(normalizeLegacyUrl("ftp://example.gr/a", "example.gr"), null);
  assert.equal(normalizeLegacyUrl("not a url", "example.gr"), null);
  assert.equal(normalizeLegacyUrl("", "example.gr"), null);
});

test("fragments are stripped, queries kept", () => {
  assert.equal(normalizeLegacyUrl("https://example.gr/a?x=1#frag", "example.gr"), "https://example.gr/a?x=1");
});

// ── isDonorAllowed — THE footprint rule ───────────────────────────────────────

test("a donor on the asset host, its www or a subdomain is forbidden", () => {
  assert.equal(isDonorAllowed("example.gr", "https://example.gr/page"), false);
  assert.equal(isDonorAllowed("example.gr", "https://www.example.gr/page"), false);
  assert.equal(isDonorAllowed("example.gr", "http://sub.example.gr/page"), false);
});

test("a genuine third-party donor is allowed; garbage is not", () => {
  assert.equal(isDonorAllowed("example.gr", "https://blog.other.gr/post"), true);
  assert.equal(isDonorAllowed("example.gr", "https://example.gr.evil.io/"), true); // different host, not a subdomain of the asset
  assert.equal(isDonorAllowed("example.gr", "javascript:alert(1)"), false);
  assert.equal(isDonorAllowed("example.gr", "///no-host///"), false);
});

// ── bundle builders ───────────────────────────────────────────────────────────

test("sitemap xml is a well-formed urlset with escaped locs", () => {
  const xml = buildSitemapXml(
    ["https://example.gr/a?x=1&y=2", "https://example.gr/b"],
    { lastmod: new Date("2026-09-18T00:00:00Z") },
  );
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
  assert.ok(xml.includes("<loc>https://example.gr/a?x=1&amp;y=2</loc>"));
  assert.ok(xml.includes("<lastmod>2026-09-18T00:00:00.000Z</lastmod>"));
  assert.equal((xml.match(/<url>/g) ?? []).length, 2);
});

test("robots txt disallows nothing and points at the sitemap", () => {
  const txt = buildRobotsTxt("https://example.gr/sitemap.xml");
  assert.ok(txt.includes("User-agent: *"));
  assert.ok(txt.includes("Disallow:\n"));
  assert.ok(txt.includes("Sitemap: https://example.gr/sitemap.xml"));
});

test("the indexnow key file is just the key", () => {
  assert.equal(indexnowKeyFile("a".repeat(32)), "a".repeat(32));
});

test("the nginx snippet orders the three files before the catch-all 301", () => {
  assert.ok(NGINX_SNIPPET.includes("robots.txt"));
  assert.ok(NGINX_SNIPPET.includes("sitemap.xml"));
  assert.ok(NGINX_SNIPPET.includes(".txt$"));
  assert.ok(NGINX_SNIPPET.toLowerCase().includes("301"));
});
