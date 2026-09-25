import assert from "node:assert/strict";
import test from "node:test";
import {
  matchPortfolioSite, normalizePageUrl, pathOnly, siteOwnsUrl, urlVariants,
  type PortfolioSite,
} from "./urlMatch";

// N11 (docs/tasks/wave-nov/N11-browser-extension.md): the URL→portfolio matching behind
// GET /api/ext/page. Pure, no Prisma — the wave-oct §5 rule.

const SITE_DOMAIN: PortfolioSite = { id: "s1", siteId: "sc-domain:example.com", url: "https://example.com" };
const SITE_PREFIX: PortfolioSite = { id: "s2", siteId: "https://news.example.com/blog/", url: "https://news.example.com/blog/" };
const SITE_WWW: PortfolioSite = { id: "s3", siteId: "https://www.shop.gr/", url: "https://www.shop.gr" };

// ─── normalization ─────────────────────────────────────────────────────────────────

test("normalizePageUrl keeps scheme+host+path+query, drops hash, trailing slash and case", () => {
  const n = normalizePageUrl("HTTPS://Example.COM/Blog/Post/?utm=1#section");
  assert.ok(n);
  assert.equal(n.href, "https://example.com/Blog/Post?utm=1");
  assert.equal(n.host, "example.com");
  assert.equal(n.path, "/Blog/Post?utm=1");
});

test("normalizePageUrl strips www only in `apex`, never in `host`", () => {
  const n = normalizePageUrl("https://www.example.com/x");
  assert.ok(n);
  assert.equal(n.host, "www.example.com");
  assert.equal(n.apex, "example.com");
});

test("normalizePageUrl rejects non-http(s) and unparseable input", () => {
  assert.equal(normalizePageUrl("chrome://extensions"), null);
  assert.equal(normalizePageUrl("about:blank"), null);
  assert.equal(normalizePageUrl(""), null);
  assert.equal(normalizePageUrl("not a url at all"), null);
});

test("urlVariants covers scheme, www and trailing-slash storage forms of one page", () => {
  const n = normalizePageUrl("https://www.example.com/page/");
  assert.ok(n);
  const v = urlVariants(n);
  assert.ok(v.includes("https://www.example.com/page"));
  assert.ok(v.includes("https://example.com/page"));
  assert.ok(v.includes("http://www.example.com/page"));
  assert.ok(v.includes("http://example.com/page"));
  assert.equal(new Set(v).size, v.length);
});

// ─── sc-domain properties ─────────────────────────────────────────────────────────

test("a domain property owns its host, www and deeper subdomains, any path", () => {
  for (const url of ["https://example.com/", "https://www.example.com/a", "https://deep.sub.example.com/x?y=1"]) {
    const n = normalizePageUrl(url);
    assert.ok(n, url);
    assert.equal(siteOwnsUrl(SITE_DOMAIN, n), true, url);
  }
});

test("a domain property does not own a lookalike host", () => {
  const n = normalizePageUrl("https://notexample.com/a");
  assert.ok(n);
  assert.equal(siteOwnsUrl(SITE_DOMAIN, n), false);
  const suffix = normalizePageUrl("https://example.com.evil.io/a");
  assert.ok(suffix);
  assert.equal(siteOwnsUrl(SITE_DOMAIN, suffix), false);
});

// ─── URL-prefix properties ────────────────────────────────────────────────────────

test("a URL-prefix property owns paths under its prefix on its exact host only", () => {
  const inside = normalizePageUrl("https://news.example.com/blog/post-1");
  assert.ok(inside);
  assert.equal(siteOwnsUrl(SITE_PREFIX, inside), true);

  const root = normalizePageUrl("https://news.example.com/blog");
  assert.ok(root);
  assert.equal(siteOwnsUrl(SITE_PREFIX, root), true); // the prefix page itself

  const sibling = normalizePageUrl("https://news.example.com/blogroll");
  assert.ok(sibling);
  assert.equal(siteOwnsUrl(SITE_PREFIX, sibling), false); // string-prefix is not path-prefix

  const offHost = normalizePageUrl("https://example.com/blog/post-1");
  assert.ok(offHost);
  assert.equal(siteOwnsUrl(SITE_PREFIX, offHost), false); // subdomains are a different property
});

test("a www URL-prefix property matches its own www host", () => {
  const n = normalizePageUrl("https://www.shop.gr/product/7");
  assert.ok(n);
  assert.equal(siteOwnsUrl(SITE_WWW, n), true);
  const bare = normalizePageUrl("https://shop.gr/product/7");
  assert.ok(bare);
  assert.equal(siteOwnsUrl(SITE_WWW, bare), false); // bare host is a different GSC property
});

// ─── portfolio matching ───────────────────────────────────────────────────────────

test("a foreign URL matches no site", () => {
  const n = normalizePageUrl("https://wikipedia.org/wiki/SEO");
  assert.ok(n);
  const site = matchPortfolioSite([SITE_DOMAIN, SITE_PREFIX, SITE_WWW], n);
  assert.equal(site, null);
});

test("when a domain property and a URL-prefix property both match, the prefix wins", () => {
  const sites: PortfolioSite[] = [
    { id: "wide", siteId: "sc-domain:example.com", url: "https://example.com" },
    { id: "narrow", siteId: "https://news.example.com/blog/", url: "https://news.example.com/blog/" },
  ];
  const n = normalizePageUrl("https://news.example.com/blog/post");
  assert.ok(n);
  const site = matchPortfolioSite(sites, n);
  assert.ok(site);
  assert.equal(site.id, "narrow");
});

test("a bare-domain Site.url fallback behaves like a domain property", () => {
  const site: PortfolioSite = { id: "s9", siteId: "example.com", url: "example.com" };
  const n = normalizePageUrl("https://www.example.com/any/path");
  assert.ok(n);
  assert.equal(siteOwnsUrl(site, n), true);
});

test("pathOnly returns the path of an absolute URL, / for roots", () => {
  assert.equal(pathOnly("https://example.com/a/b?x=1"), "/a/b?x=1");
  assert.equal(pathOnly("https://example.com/"), "/");
  assert.equal(pathOnly("example.com"), "/");
});
