import test from "node:test";
import assert from "node:assert/strict";
import {
  checkHreflangSite,
  isValidHreflangCode,
  mergeHreflangEntries,
  normalizeHreflangUrl,
  parseHreflangHead,
  parseHreflangLinkHeader,
  parseHreflangSitemap,
  validateHreflangEntries,
  type HreflangPageInput,
  type HreflangTargetState,
} from "./hreflang";

test("valid and invalid hreflang codes per BCP 47 as used by Google", () => {
  for (const code of ["en", "en-GB", "en-gb", "fr", "zh-Hant", "zh-Hant-TW", "es-419", "x-default", "pt-BR", "ru"]) {
    assert.equal(isValidHreflangCode(code), true, code);
  }
  for (const code of ["en-UK", "fr_FR", "eng", "", "e", "e1", "xx", "en-", "x-default-fr", "fr-FR-Extra", "123", "en-ZZ"]) {
    assert.equal(isValidHreflangCode(code), false, code);
  }
});

test("relative and non-http hrefs are invalid, and a language twice with different URLs", () => {
  const { invalid, valid } = validateHreflangEntries([
    { lang: "en", href: "https://example.com/en/" },
    { lang: "fr", href: "/fr/" },                       // relative — invalid
    { lang: "de", href: "javascript:0" },               // not http(s) — invalid
    { lang: "en", href: "https://example.com/english/" }, // same language, different URL — invalid
    { lang: "es", href: "https://example.com/es/" },
    { lang: "es", href: "https://example.com/es/" },    // exact duplicate — fine
  ]);
  assert.equal(valid.length, 2); // en → /en/ (first), es (deduped)
  assert.equal(invalid.length, 3);
  assert.match(invalid.join(" "), /not an absolute http/);
  assert.match(invalid.join(" "), /listed twice/);
});

test("no return link: A declares B, B's set never mentions A", () => {
  const pages: HreflangPageInput[] = [
    { url: "https://example.com/", htmlLang: "fr", entries: [
      { lang: "fr", href: "https://example.com/" },
      { lang: "en", href: "https://example.com/en/" },
      { lang: "x-default", href: "https://example.com/" },
    ] },
    { url: "https://example.com/en/", htmlLang: "en", entries: [
      { lang: "en", href: "https://example.com/en/" },
      // no entry back to /
    ] },
  ];
  const findings = checkHreflangSite(pages, new Map());
  const english = findings.get("https://example.com/en/")!;
  assert.equal(english.noReturn.length, 1);
  assert.match(english.noReturn[0], /\/ → here \(en\), no link back/);
  assert.equal(findings.get("https://example.com/")!.noReturn.length, 0);
  // The rest of the French page's set is healthy.
  assert.equal(findings.get("https://example.com/")!.selfMissing, false);
});

test("a target outside the scan is never an error", () => {
  const pages: HreflangPageInput[] = [
    { url: "https://example.com/", htmlLang: "en", entries: [
      { lang: "en", href: "https://example.com/" },
      { lang: "fr", href: "https://other-domain.example.fr/" }, // never crawled
      { lang: "x-default", href: "https://example.com/" },
    ] },
  ];
  const findings = checkHreflangSite(pages, new Map());
  const home = findings.get("https://example.com/")!;
  assert.deepEqual(home.targetBad, []);
  assert.deepEqual(home.noReturn, []);
  assert.equal(home.selfMissing, false);
  // x-default present, so the two-language set has nothing to report either.
  assert.equal(home.xDefaultMissing, false);
});

test("redirect, noindex and non-canonical crawled targets are bad; 200 self-canonical is not", () => {
  const states = new Map<string, HreflangTargetState>([
    [normalizeHreflangUrl("https://example.com/en/"), { httpStatus: 301, noindex: false, canonical: null }],
    [normalizeHreflangUrl("https://example.com/de/"), { httpStatus: 200, noindex: true, canonical: null }],
    [normalizeHreflangUrl("https://example.com/es/"), { httpStatus: 200, noindex: false, canonical: "https://example.com/es-es/" }],
    [normalizeHreflangUrl("https://example.com/it/"), { httpStatus: 200, noindex: false, canonical: null }],
    [normalizeHreflangUrl("https://example.com/down/"), { httpStatus: 0, noindex: false, canonical: null }], // fetch failed
  ]);
  const pages: HreflangPageInput[] = [
    { url: "https://example.com/", htmlLang: "en", entries: [
      { lang: "en", href: "https://example.com/" },
      { lang: "x-default", href: "https://example.com/" },
      { lang: "en-GB", href: "https://example.com/en/" },
      { lang: "de", href: "https://example.com/de/" },
      { lang: "es", href: "https://example.com/es/" },
      { lang: "it", href: "https://example.com/it/" },
      { lang: "fr", href: "https://example.com/down/" },
    ] },
  ];
  const findings = checkHreflangSite(pages, states);
  const home = findings.get("https://example.com/")!;
  assert.equal(home.targetBad.length, 3); // en-GB redirect, de noindex, es non-canonical
  assert.match(home.targetBad.join(" "), /redirect 301/);
  assert.match(home.targetBad.join(" "), /noindex/);
  assert.match(home.targetBad.join(" "), /canonical/);
  // it/ (healthy) and down/ (fetch failed = unknown) say nothing.
});

test("x-default missing fires once per distinct set, self-missing and lang mismatch", () => {
  const page = (url: string, htmlLang: string, entries: HreflangPageInput["entries"]): HreflangPageInput => ({ url, htmlLang, entries });
  const fr = [
    { lang: "fr", href: "https://example.com/fr/" },
    { lang: "en", href: "https://example.com/en/" },
  ];
  const en = [
    { lang: "fr", href: "https://example.com/fr/" },
    { lang: "en", href: "https://example.com/en/" },
  ];
  const findings = checkHreflangSite(
    [page("https://example.com/fr/", "fr", fr), page("https://example.com/en/", "en", en)],
    new Map(),
  );
  // Both pages have a ≥ 2-language set without x-default — reported once (site scope).
  const flagged = [...findings.values()].filter(f => f.xDefaultMissing);
  assert.equal(flagged.length, 1);
  // Both sets include their own page.
  assert.equal(findings.get("https://example.com/fr/")!.selfMissing, false);

  const noSelf = checkHreflangSite(
    [page("https://example.com/fr/", "fr", [{ lang: "en", href: "https://example.com/en/" }])],
    new Map(),
  );
  assert.equal(noSelf.get("https://example.com/fr/")!.selfMissing, true);

  const mismatch = checkHreflangSite(
    [page("https://example.com/fr/", "en", [
      { lang: "fr", href: "https://example.com/fr/" },
      { lang: "x-default", href: "https://example.com/fr/" },
    ])],
    new Map(),
  );
  assert.match(mismatch.get("https://example.com/fr/")!.langMismatch, /lang="en" vs hreflang "fr"/);
});

test("three sources merge: head links, Link header, sitemap xhtml:link", () => {
  const html = `<head><link rel="alternate" hreflang="en" href="https://example.com/en/">
    <link rel="alternate" hreflang="fr" href="https://example.com/"></head>`;
  const header = `<https://example.com/de/>; rel="alternate"; hreflang="de", <https://example.com/en/>; rel="alternate"; hreflang="en"`;
  const sitemap = `<?xml version="1.0"?>
    <urlset xmlns:xhtml="http://www.w3.org/1999/xhtml">
      <url><loc>https://example.com/</loc>
        <xhtml:link rel="alternate" hreflang="es" href="https://example.com/es/"/>
        <xhtml:link rel="alternate" hreflang="fr" href="https://example.com/"/>
      </url>
      <url><loc>https://example.com/es/</loc>
        <xhtml:link rel="alternate" hreflang="es" href="https://example.com/es/"/>
      </url>
    </urlset>`;

  const headEntries = parseHreflangHead(html);
  assert.equal(headEntries.length, 2);
  const headerEntries = parseHreflangLinkHeader(header);
  assert.deepEqual(headerEntries, [
    { lang: "de", href: "https://example.com/de/" },
    { lang: "en", href: "https://example.com/en/" },
  ]);
  const sitemapMap = parseHreflangSitemap(sitemap);
  assert.equal(sitemapMap.get("https://example.com/")!.length, 2);
  assert.equal(sitemapMap.get("https://example.com/es/")!.length, 1);

  const merged = mergeHreflangEntries(headEntries, headerEntries, sitemapMap.get("https://example.com/") ?? []);
  // en appears in both head and header (same URL) — deduped; fr in head and sitemap (same URL) — deduped.
  assert.deepEqual(merged.map(e => e.lang).sort(), ["de", "en", "es", "fr"]);
});

test("URL normalization: host case, www, trailing slash, hash", () => {
  assert.equal(normalizeHreflangUrl("https://WWW.Example.com/en/"), normalizeHreflangUrl("https://example.com/en"));
  assert.equal(normalizeHreflangUrl("https://example.com/#top"), "https://example.com/");
  assert.equal(normalizeHreflangUrl("https://example.com/en/?a=1"), "https://example.com/en?a=1");
  assert.equal(normalizeHreflangUrl("/relative"), "");
});
