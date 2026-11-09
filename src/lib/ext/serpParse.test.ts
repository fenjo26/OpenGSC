import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Plain JS by design (see audit.test.ts for the why). The DOM half of parse() is verified by
// hand against the fixtures; everything pure lives here.
import SerpParse from "../../../extension/lib/serpParse.js";
import { CAPTURE_FEATURES } from "./types";

const { locale, resultUrl, citeUrl, isOrganicHost, dedupe, FEATURES } = SerpParse as {
  locale: (pageUrl: string, htmlLang: string) => { engineHost: string; country: string; lang: string; page: number; startPos: number; query: string; device: string };
  resultUrl: (rawHref: string, pageOrigin: string) => string | null;
  citeUrl: (citeText: string) => string | null;
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

// ─── citeUrl (the /goto-session fallback) ─────────────────────────────────────────

test("citeUrl: reconstructs a breadcrumb into an https URL", () => {
  assert.equal(citeUrl("https://bizzocasino.com  › casino › recommended"), "https://bizzocasino.com/casino/recommended");
  assert.equal(citeUrl("https://www.transfer247.gr › metafora-apo-pros-aerodr…"), "https://transfer247.gr");
  assert.equal(citeUrl("example.gr"), "https://example.gr");
});

test("citeUrl: truncated or junk breadcrumbs are null, never a guess", () => {
  assert.equal(citeUrl("… › something"), null);
  assert.equal(citeUrl("not a host at all"), null);
  assert.equal(citeUrl(""), null);
  assert.equal(citeUrl("google.com › search"), "https://google.com/search"); // host itself is fine here;
  // the google-host exclusion is parse()'s job (isOrganicHost), not the reconstruction's
});

// ─── FEATURES must equal CAPTURE_FEATURES of types.ts ─────────────────────────────

test("the parser's FEATURES equal CAPTURE_FEATURES in src/lib/ext/types.ts", () => {
  assert.deepEqual([...FEATURES].slice().sort(), [...CAPTURE_FEATURES].slice().sort());
});

// ─── the saved REAL fixtures (incognito-shape captures, session ids scrubbed) ────────

const fixtureDir = join(process.cwd(), "src/lib/ext/__fixtures__/serp");

/** The href of every anchor that carries an h3 inside (the parser's organic rule), any
 *  attribute order — plus every <cite> breadcrumb of the page, mirroring the fallback. */
function fixtureAnchors(name: string): { hrefs: string[]; cites: string[] } {
  const html = readFileSync(join(fixtureDir, name), "utf8");
  const hrefs: string[] = [];
  const anchorRe = /<a\b[^>]*>(?:(?!<\/a>[\s\S])*?)<h3/g;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html))) {
    const href = m[0].match(/href="([^"]*)"/);
    if (href) hrefs.push(href[1]);
  }
  const cites = [...html.matchAll(/<cite[^>]*>([\s\S]*?)<\/cite>/g)]
    .map(c => c[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").trim());
  return { hrefs, cites };
}

function resolveAll(hrefs: string[], cites: string[]): string[] {
  const out: string[] = [];
  for (const href of hrefs) {
    const url = resultUrl(href, "https://www.google.com/");
    if (url) out.push(url);
  }
  if (!out.length) {
    // the /goto?url=<encrypted> session shape: the breadcrumbs are the real targets
    for (const cite of cites) {
      const url = citeUrl(cite);
      if (url && isOrganicHost(new URL(url).host)) out.push(url);
    }
  }
  return out;
}

test("fixture bizzo-casino-italia (real google.it capture): organic targets resolve", () => {
  const { hrefs, cites } = fixtureAnchors("bizzo-casino-italia-google-it.html");
  assert.ok(hrefs.length >= 5, `expected ≥ 5 h3 anchors, got ${hrefs.length}`);
  const urls = resolveAll(hrefs, cites);
  assert.ok(urls.length >= 5, "every organic result produced a URL (direct or cite fallback)");
  for (const u of urls) assert.ok(/^https:\/\//.test(u), u);
});

test("fixture commercial-google-gr (real capture): hosts are organic, region reads gr/el", () => {
  const { hrefs, cites } = fixtureAnchors("commercial-google-gr.html");
  const urls = resolveAll(hrefs, cites);
  assert.ok(urls.length >= 5);
  for (const u of urls) {
    const host = new URL(u).host;
    assert.ok(isOrganicHost(host), `${host} must be organic`);
  }
  const m = locale("https://www.google.gr/search?q=%CE%BC%CE%B5%CF%84%CE%B1%CF%86%CE%BF%CF%81%CE%AD%CF%82+%CE%B1%CE%B5%CF%81%CE%BF%CE%B4%CF%81%CF%8C%CE%BC%CE%B9%CE%BF+%CE%B1%CE%B8%CE%AE%CE%BD%CE%B1", "el");
  assert.equal(m.country, "gr");
  assert.equal(m.lang, "el");
});

test("fixture ai-overview-paa and page2 (real google.com captures)", () => {
  const ai = fixtureAnchors("ai-overview-paa-google-com.html");
  assert.ok(resolveAll(ai.hrefs, ai.cites).length >= 3, "AI-overview page still has organic results");
  const p2 = fixtureAnchors("page2-google-com.html");
  // ≥ 10: the page also carries PAA/video h3-anchors; ten organic blue links are the floor
  assert.ok(p2.hrefs.length >= 10, `expected ≥ 10 h3 anchors, got ${p2.hrefs.length}`);
  assert.ok(resolveAll(p2.hrefs, p2.cites).length >= 10);
  const m = locale("https://www.google.com/search?q=seo+guide&hl=en&gl=us&start=10", "en");
  assert.equal(m.page, 2);
  assert.equal(m.startPos, 11);
});

test("fixture keywords-everywhere: the injected block's links are not organic anchors", () => {
  // The KE-like block carries links WITHOUT a heading inside the anchor — the h3 rule excludes
  // them, which is what keeps other extensions' rows out of our organic set.
  const { hrefs } = fixtureAnchors("keywords-everywhere-google-com.html");
  assert.ok(hrefs.every(h => h.indexOf("ke.example") === -1), "extension-injected links excluded");
});

test("fixtures carry no account marks and no session ids (the public-repo gate)", () => {
  const names = [
    "bizzo-casino-italia-google-it.html", "commercial-google-gr.html",
    "ai-overview-paa-google-com.html", "page2-google-com.html", "keywords-everywhere-google-com.html",
  ];
  for (const name of names) {
    const html = readFileSync(join(fixtureDir, name), "utf8").toLowerCase();
    assert.ok(!html.includes("@gmail"), name);
    assert.ok(!html.includes("signoutoptions?"), name);
    assert.ok(!/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.test(html), name);
  }
});
