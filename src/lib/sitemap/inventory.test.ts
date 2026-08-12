import test from "node:test";
import assert from "node:assert/strict";
import { collectSitemapInventory, parseSitemapXml } from "./inventory";

test("parses metadata and image/video/news extensions", () => {
  const parsed = parseSitemapXml(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
    xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
    <url><loc>https://example.com/a?x=1&amp;y=2</loc><lastmod>2026-08-12</lastmod><image:image/><news:news/></url>
    <url><loc>javascript:alert(1)</loc></url>
  </urlset>`, "https://example.com/sitemap.xml");
  assert.equal(parsed.kind, "urlset");
  assert.equal(parsed.invalid, 1);
  assert.deepEqual(parsed.entries[0], {
    url: "https://example.com/a?x=1&y=2",
    sourceSitemap: "https://example.com/sitemap.xml",
    sitemapType: "mixed",
    lastmod: "2026-08-12",
    lastmodValid: true,
    imageCount: 1,
    videoCount: 0,
    newsCount: 1,
  });
});

test("a failed child makes the collection partial without losing successful children", async () => {
  const documents = new Map([
    ["https://example.com/sitemap.xml", `<sitemapindex><sitemap><loc>https://example.com/a.xml</loc></sitemap><sitemap><loc>https://example.com/b.xml</loc></sitemap></sitemapindex>`],
    ["https://example.com/a.xml", `<urlset><url><loc>https://example.com/a</loc><lastmod>not-a-date</lastmod></url></urlset>`],
  ]);
  const result = await collectSitemapInventory("https://example.com/sitemap.xml", async url => {
    const value = documents.get(url);
    if (!value) throw new Error("offline");
    return value;
  });
  assert.equal(result.partial, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].lastmodValid, false);
  assert.deepEqual(result.failures, [{ sitemap: "https://example.com/b.xml", error: "offline" }]);
});

test("a root failure is not downgraded to a partial success", async () => {
  await assert.rejects(
    collectSitemapInventory("https://example.com/sitemap.xml", async () => { throw new Error("root offline"); }),
    /root offline/,
  );
});

test("an invalid child sitemap location makes negative evidence partial", async () => {
  const result = await collectSitemapInventory("https://example.com/sitemap.xml", async () =>
    `<sitemapindex><sitemap><loc>not a URL</loc></sitemap></sitemapindex>`
  );
  assert.equal(result.invalid, 1);
  assert.equal(result.partial, true);
  assert.equal(result.failures[0].error, "invalid_child_sitemap");
});
