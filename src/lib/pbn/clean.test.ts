import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanHtml, unwrapArchiveUrls, stripExternalLinks, residualFootprints } from "./clean";

test("archive-wrapped own asset becomes a local path", () => {
  const html = `<img src="https://web.archive.org/web/20040121214835im_/http://pets.com/images/pixel.gif">`;
  const r = unwrapArchiveUrls(html, "pets.com");
  assert.equal(r.count, 1);
  assert.ok(r.html.includes('src="/images/pixel.gif"'), r.html);
  assert.ok(!/web\.archive\.org/.test(r.html));
});

test("external links are unwrapped to text, internal kept", () => {
  const html = `<a href="http://www.petsmart.com/help/">help</a> <a href="/about.html">about</a>`;
  const r = stripExternalLinks(html, "pets.com");
  assert.equal(r.external, 1);
  assert.ok(r.html.includes("help</a>") === false);
  assert.ok(r.html.includes(">help") || r.html.includes("help "), r.html);
  assert.ok(r.html.includes('href="/about.html"'), "internal link kept");
});

test("javascript: links are stripped", () => {
  const html = `<a href="javascript:void window.open('http://www.petsmart.com/x')">buy</a>`;
  const r = stripExternalLinks(html, "pets.com");
  assert.equal(r.js, 1);
  assert.ok(!/javascript:/.test(r.html));
});

test("trackers removed, full clean leaves no footprints", () => {
  const html = `
    <html><head>
    <script src="https://www.googletagmanager.com/gtm.js?id=GTM-X"></script>
    <script>ga('send','pageview');</script>
    </head><body>
    <img src="https://web.archive.org/web/20040121214835im_/http://pets.com/logo.png">
    <a href="https://evil-other.com/x">ad</a>
    </body></html>`;
  const r = cleanHtml(html, { domain: "pets.com" });
  assert.ok(r.stats.trackersRemoved >= 2, `trackers ${r.stats.trackersRemoved}`);
  assert.equal(r.stats.externalLinksStripped, 1);
  assert.ok(r.stats.archiveRefsRewritten >= 1);
  assert.deepEqual(residualFootprints(r.html), [], r.html);
});

test("residualFootprints catches WayForge markers", () => {
  const dirty = `<html data-wf-reconstructed="1"><a data-wf-injected="true">x</a>`;
  const f = residualFootprints(dirty);
  assert.ok(f.includes("data-wf-reconstructed"));
  assert.ok(f.includes("data-wf-injected"));
});
