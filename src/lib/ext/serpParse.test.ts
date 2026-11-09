import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Plain JS by design (see audit.test.ts for the why). The DOM half of parse() is verified by
// hand against the fixtures; everything pure lives here.
import SerpParse from "../../../extension/lib/serpParse.js";
import { CAPTURE_FEATURES } from "./types";

const { locale, resultUrl, isOrganicHost, dedupe, FEATURES } = SerpParse as {
  locale: (pageUrl: string, htmlLang: string) => { engineHost: string; country: string; lang: string; page: number; startPos: number; query: string; device: string };
  resultUrl: (rawHref: string, pageOrigin: string) => string | null;
  isOrganicHost: (host: string) => boolean;
  dedupe: (rows: { position: number; url: string }[]) => { position: number; url: string }[];
  FEATURES: string[];
};

// ─── resultUrl ────────────────────────────────────────────────────────────────────

test("resultUrl: direct https links pass through unchanged", () => {
  assert.equal(resultUrl("https://example.com/page?x=1", "https://www.google.gr/"), "https://example.com/page?x=1");
});

test("resultUrl: /url?q= and /url?url= unwrap to the real URL", () => {
  assert.equal(
    resultUrl("/url?q=https://example.com/a&rct=j", "https://www.google.com/"),
    "https://example.com/a",
  );
  assert.equal(
    resultUrl("https://www.google.com/url?url=https://example.com/b&sa=U", "https://www.google.com/"),
    "https://example.com/b",
  );
});

test("resultUrl: google-internal and junk targets are null", () => {
  assert.equal(resultUrl("https://www.google.com/search?q=x", "https://www.google.com/"), null);
  assert.equal(resultUrl("https://webcache.googleusercontent.com/search?q=cache:x", "https://www.google.com/"), null);
  assert.equal(resultUrl("https://translate.google.com/translate?u=x", "https://www.google.com/"), null);
  assert.equal(resultUrl("javascript:void(0)", "https://www.google.com/"), null);
  assert.equal(resultUrl("mailto:a@b.com", "https://www.google.com/"), null);
  assert.equal(resultUrl("", "https://www.google.com/"), null);
  assert.equal(resultUrl("/url?q=not-a-url", "https://www.google.com/"), null);
});

// ─── locale ───────────────────────────────────────────────────────────────────────

test("locale: gl/hl params win, query is normalised", () => {
  const m = locale("https://www.google.gr/search?q=  Κασίνο   online &hl=en&gl=cy", "el");
  assert.equal(m.engineHost, "www.google.gr");
  assert.equal(m.country, "cy");
  assert.equal(m.lang, "en");
  assert.equal(m.query, "κασίνο online");
  assert.equal(m.page, 1);
  assert.equal(m.startPos, 1);
});

test("locale: without gl the ccTLD is the country; co.uk reads gb, com reads unknown", () => {
  assert.equal(locale("https://www.google.gr/search?q=x", "el").country, "gr");
  assert.equal(locale("https://www.google.co.uk/search?q=x", "en").country, "gb");
  assert.equal(locale("https://www.google.com.ua/search?q=x", "uk").country, "ua");
  assert.equal(locale("https://www.google.com/search?q=x", "en").country, "");
});

test("locale: without hl the html lang is used; start=10 is page 2 from position 11", () => {
  assert.equal(locale("https://www.google.it/search?q=x", "it").lang, "it");
  const m = locale("https://www.google.com/search?q=x&start=10", "en");
  assert.equal(m.page, 2);
  assert.equal(m.startPos, 11);
});

test("locale: no q is an empty query, never a guess", () => {
  assert.equal(locale("https://www.google.com/search", "en").query, "");
});

// ─── isOrganicHost ────────────────────────────────────────────────────────────────

test("isOrganicHost: google hosts are never organic, youtube is", () => {
  assert.equal(isOrganicHost("www.google.gr"), false);
  assert.equal(isOrganicHost("accounts.google.com"), false);
  assert.equal(isOrganicHost("webcache.googleusercontent.com"), false);
  assert.equal(isOrganicHost("support.google.com"), false);
  assert.equal(isOrganicHost("www.youtube.com"), true);
  assert.equal(isOrganicHost("en.wikipedia.org"), true);
  assert.equal(isOrganicHost(""), false);
});

// ─── dedupe ───────────────────────────────────────────────────────────────────────

test("dedupe: the same URL twice keeps the first position (sitelinks shape)", () => {
  const rows = [
    { position: 1, url: "https://a.com/" },
    { position: 2, url: "https://b.com/" },
    { position: 3, url: "https://a.com/sub" },
    { position: 4, url: "https://b.com/" },
  ];
  assert.deepEqual(dedupe(rows).map(r => r.position), [1, 2, 3]);
});

// ─── FEATURES must equal CAPTURE_FEATURES of types.ts ─────────────────────────────

test("the parser's FEATURES equal CAPTURE_FEATURES in src/lib/ext/types.ts", () => {
  assert.deepEqual([...FEATURES].slice().sort(), [...CAPTURE_FEATURES].slice().sort());
});

// ─── the pure layer over the saved fixtures ───────────────────────────────────────

const fixtureDir = join(process.cwd(), "src/lib/ext/__fixtures__/serp");

function fixtureOrganicHrefs(name: string): string[] {
  const html = readFileSync(join(fixtureDir, name), "utf8");
  // our fixture structure: <a href="…"[^>]*><br><h3 — anchors that carry a heading
  return [...html.matchAll(/<a href="([^"]+)"[^>]*><br><h3/g)].map(m => m[1]);
}

test("fixture bizzo-casino-italia: /url?q= wrappers and direct links resolve to real URLs", () => {
  const hrefs = fixtureOrganicHrefs("bizzo-casino-italia-google-it.html");
  assert.ok(hrefs.length >= 10, `expected ≥ 10 organic anchors, got ${hrefs.length}`);
  const urls = hrefs.map(h => resultUrl(h, "https://www.google.it/"));
  assert.ok(urls.every(u => u != null), "every organic anchor resolves");
  assert.ok(urls.some(u => u!.startsWith("https://www.casino-italia.net/")), "the /url?q= wrapper unwraps");
  assert.equal(new Set(urls).size, urls.length, "no duplicates among the ten");
});

test("fixture commercial-google-gr: the hosts parse as organic", () => {
  const urls = fixtureOrganicHrefs("commercial-google-gr.html").map(h => resultUrl(h, "https://www.google.gr/"));
  urls.forEach(u => {
    const host = new URL(u!).host;
    assert.ok(isOrganicHost(host), `${host} must be organic`);
  });
  const m = locale("https://www.google.gr/search?q=μεταφορές+αεροδρόμιο+αθήνα", "el");
  assert.equal(m.country, "gr");
  assert.equal(m.lang, "el");
});

test("fixture keywords-everywhere: the injected block's links are not organic anchors", () => {
  // The KE-like block carries links WITHOUT a heading inside the anchor — the fixture
  // regex (which mirrors the anchor-with-heading rule) must not pick them up.
  const hrefs = fixtureOrganicHrefs("keywords-everywhere-google-com.html");
  assert.ok(hrefs.every(h => h.indexOf("ke.example") === -1), "extension-injected links excluded");
  assert.equal(hrefs.length, 3);
});

test("fixtures carry no account marks (the public-repo check)", () => {
  const names = [
    "bizzo-casino-italia-google-it.html", "commercial-google-gr.html",
    "ai-overview-paa-google-com.html", "page2-google-com.html", "keywords-everywhere-google-com.html",
  ];
  for (const name of names) {
    const html = readFileSync(join(fixtureDir, name), "utf8").toLowerCase();
    assert.ok(!html.includes("@gmail"), name);
    assert.ok(!html.includes("accounts.google.com/signoutoptions"), name);
  }
});
