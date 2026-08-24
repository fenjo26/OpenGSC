import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeDomain,
  matchOwnedDomain,
  parseRel,
  decodeBody,
  extractBaseHref,
  findPlacements,
} from "./linkPlacement";

const OWNED = ["mysite.com"];
const DONOR = "https://donor.example/post/about-us";

/** Buffer.from(...).buffer is Node's shared pool with unrelated bytes — cut an exact slice. */
function textBytes(text: string, encoding: BufferEncoding): ArrayBuffer {
  const buf = Buffer.from(text, encoding);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// ---------------------------------------------------------------------------
// canonicalizeDomain
// ---------------------------------------------------------------------------

test("canonicalizeDomain collapses every common way of writing a domain", () => {
  for (const input of [
    "mysite.com",
    "www.mysite.com",
    "https://mysite.com/path",
    "MySite.com.",
    "mysite.com:443",
    "HTTPS://MySite.COM/",
  ]) {
    assert.equal(canonicalizeDomain(input), "mysite.com", input);
  }
});

test("canonicalizeDomain strips userinfo and query debris from bare input", () => {
  assert.equal(canonicalizeDomain("user@mysite.com"), "mysite.com");
  assert.equal(canonicalizeDomain("https://user:pass@mysite.com/path?q=1"), "mysite.com");
  assert.equal(canonicalizeDomain("  mysite.com  "), "mysite.com");
  assert.equal(canonicalizeDomain("mysite.com/path"), "mysite.com");
});

test("canonicalizeDomain treats unicode IDN and punycode as the same key", () => {
  const unicode = canonicalizeDomain("сайт.рф");
  const punycode = canonicalizeDomain("xn--80aswg.xn--p1ai");
  assert.equal(unicode, "xn--80aswg.xn--p1ai");
  assert.equal(punycode, "xn--80aswg.xn--p1ai");
  assert.equal(canonicalizeDomain("www.сайт.рф"), "xn--80aswg.xn--p1ai");
});

test("canonicalizeDomain rejects unusable input with null", () => {
  for (const input of [
    "",          // empty
    "   ",       // whitespace only
    "a..com",    // empty label
    "-bad.com",  // leading hyphen
    "bad-.com",  // trailing hyphen
    "localhost", // dotless
    "nodot",     // dotless
    "192.168.1.1",   // bare IPv4
    "1.2.3.4.5",     // all-numeric labels
    "::1",           // bare IPv6
    "[2001:db8::1]:8080", // bracketed IPv6 with port
  ]) {
    assert.equal(canonicalizeDomain(input), null, input);
  }
});

test("canonicalizeDomain keeps a single stray port-like suffix (reference behavior)", () => {
  assert.equal(canonicalizeDomain("mysite.com:abc"), "mysite.com");
});

// ---------------------------------------------------------------------------
// matchOwnedDomain
// ---------------------------------------------------------------------------

test("matchOwnedDomain counts subdomains as owned", () => {
  assert.equal(matchOwnedDomain("blog.mysite.com", OWNED), "mysite.com");
  assert.equal(matchOwnedDomain("www.mysite.com", OWNED), "mysite.com");
  assert.equal(matchOwnedDomain("deep.sub.mysite.com", OWNED), "mysite.com");
});

test("matchOwnedDomain returns the most specific configured domain", () => {
  const owned = ["mysite.com", "shop.mysite.com"];
  assert.equal(matchOwnedDomain("shop.mysite.com", owned), "shop.mysite.com");
  assert.equal(matchOwnedDomain("catalog.shop.mysite.com", owned), "shop.mysite.com");
  assert.equal(matchOwnedDomain("blog.mysite.com", owned), "mysite.com");
});

test("matchOwnedDomain matches only on label boundaries", () => {
  assert.equal(matchOwnedDomain("notmysite.com", OWNED), null);
  assert.equal(matchOwnedDomain("mysite.com.evil.com", OWNED), null);
  assert.equal(matchOwnedDomain("evil.com", OWNED), null);
});

test("matchOwnedDomain canonicalizes both sides before matching", () => {
  assert.equal(matchOwnedDomain("https://blog.mysite.com/x", ["https://mysite.com/"]), "mysite.com");
  assert.equal(matchOwnedDomain("сайт.рф", ["xn--80aswg.xn--p1ai"]), "xn--80aswg.xn--p1ai");
  assert.equal(matchOwnedDomain("mysite.com", ["!!", "", "mysite.com"]), "mysite.com"); // junk entries are skipped
  assert.equal(matchOwnedDomain("mysite.com", []), null);
  assert.equal(matchOwnedDomain("", OWNED), null);
});

// ---------------------------------------------------------------------------
// parseRel
// ---------------------------------------------------------------------------

test("parseRel: absent or empty rel is dofollow", () => {
  for (const input of [null, undefined, ""]) {
    const rel = parseRel(input);
    assert.equal(rel.raw, "");
    assert.equal(rel.nofollow, false, String(input));
    assert.equal(rel.sponsored, false);
    assert.equal(rel.ugc, false);
    assert.equal(rel.dofollow, true);
  }
});

test("parseRel: nofollow, sponsored and ugc are independent flags", () => {
  const nofollow = parseRel("nofollow");
  assert.equal(nofollow.nofollow, true);
  assert.equal(nofollow.sponsored, false);
  assert.equal(nofollow.dofollow, false);

  const sponsored = parseRel("sponsored"); // passes no weight even without nofollow
  assert.equal(sponsored.nofollow, false);
  assert.equal(sponsored.sponsored, true);
  assert.equal(sponsored.dofollow, false);

  const ugc = parseRel("ugc");
  assert.equal(ugc.ugc, true);
  assert.equal(ugc.dofollow, false);

  const all = parseRel("nofollow sponsored ugc");
  assert.equal(all.nofollow, true);
  assert.equal(all.sponsored, true);
  assert.equal(all.ugc, true);
  assert.equal(all.dofollow, false);
});

test("parseRel: case-insensitive, any whitespace, unknown tokens ignored", () => {
  const rel = parseRel("NOFOLLOW\tSPONSORED  noopener");
  assert.equal(rel.nofollow, true);
  assert.equal(rel.sponsored, true);
  assert.equal(rel.ugc, false);
  assert.equal(rel.dofollow, false);
  assert.equal(parseRel("noopener noreferrer").dofollow, true);
  assert.equal(parseRel("Bookmark NOFOLLOW").nofollow, true);
});

test("parseRel keeps the raw rel string (trimmed) for storage and dedup", () => {
  assert.equal(parseRel("  Nofollow  Sponsored ").raw, "Nofollow  Sponsored");
});

// ---------------------------------------------------------------------------
// decodeBody
// ---------------------------------------------------------------------------

test("decodeBody: UTF-8 BOM wins over everything", () => {
  const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from("Привет", "utf8")]);
  assert.equal(decodeBody(bytes.buffer, "text/html; charset=windows-1251"), "Привет");
});

test("decodeBody: UTF-16 and UTF-32 BOMs decode Cyrillic correctly", () => {
  const utf16le = Uint8Array.from([0xff, 0xfe, ...Buffer.from("Привет", "utf16le")]);
  assert.equal(decodeBody(utf16le.buffer, ""), "Привет");

  // UTF-16BE and UTF-32 have no Buffer encoder — build by hand
  const be: number[] = [0xfe, 0xff];
  for (let i = 0; i < "Привет".length; i++) {
    const code = "Привет".charCodeAt(i);
    be.push((code >> 8) & 0xff, code & 0xff);
  }
  assert.equal(decodeBody(Uint8Array.from(be).buffer, ""), "Привет");

  const le32: number[] = [0xff, 0xfe, 0x00, 0x00];
  for (const char of "Привет") {
    const code = char.codePointAt(0)!;
    le32.push(code & 0xff, (code >> 8) & 0xff, (code >> 16) & 0xff, (code >> 24) & 0xff);
  }
  assert.equal(decodeBody(Uint8Array.from(le32).buffer, ""), "Привет");

  const be32: number[] = [0x00, 0x00, 0xfe, 0xff];
  for (const char of "Привет") {
    const code = char.codePointAt(0)!;
    be32.push((code >> 24) & 0xff, (code >> 16) & 0xff, (code >> 8) & 0xff, code & 0xff);
  }
  assert.equal(decodeBody(Uint8Array.from(be32).buffer, ""), "Привет");
});

/** Minimal CP1251 encoder for test fixtures (Cyrillic + ASCII only). */
function cp1251(text: string): ArrayBuffer {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code === 0x401) bytes.push(0xa8); // Ё
    else if (code === 0x451) bytes.push(0xb8); // ё
    else if (code >= 0x410 && code <= 0x44f) bytes.push(code - 0x410 + 0xc0);
    else bytes.push(0x3f);
  }
  return Uint8Array.from(bytes).buffer;
}

test("decodeBody: HTTP header charset decodes a CP1251 page", () => {
  assert.equal(decodeBody(cp1251("Лучший сайт"), "text/html; charset=windows-1251"), "Лучший сайт");
  assert.equal(decodeBody(cp1251("Лучший сайт"), "windows-1251"), "Лучший сайт"); // bare label
});

test("decodeBody: <meta charset> rescues a CP1251 page served without header charset", () => {
  const html = '<html><head><meta charset="windows-1251"></head><body>Лучший сайт</body></html>';
  assert.equal(decodeBody(cp1251(html), "text/html"), html);
  const httpEquiv = '<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">';
  assert.ok(decodeBody(cp1251(httpEquiv + "Анкор"), "text/html").includes("Анкор"));
});

test("decodeBody: CP1251 without any declaration still reads (Russian donor fallback)", () => {
  assert.equal(decodeBody(cp1251("Анкор ссылки"), "text/html"), "Анкор ссылки");
});

test("decodeBody: plain and declared encodings", () => {
  assert.equal(decodeBody(textBytes("hello", "utf8"), ""), "hello"); // plain ASCII/UTF-8
  assert.equal(decodeBody(textBytes("héy", "utf8"), "text/html"), "héy");
  assert.equal(decodeBody(textBytes("café", "latin1"), "text/html; charset=cp1252"), "café");
  const xml = '<?xml version="1.0" encoding="utf-8"?><rss>Ok</rss>';
  assert.equal(decodeBody(textBytes(xml, "utf8"), "application/xml"), xml);
});

test("decodeBody: bogus declared charset falls through to UTF-8", () => {
  assert.equal(decodeBody(textBytes("ok", "utf8"), "text/html; charset=bogus-encoding"), "ok");
});

// ---------------------------------------------------------------------------
// extractBaseHref
// ---------------------------------------------------------------------------

test("extractBaseHref: absolute base from <head>", () => {
  const html = '<head><base href="https://cdn.example/"><base href="https://ignored.com/"></head>';
  assert.equal(extractBaseHref(html, DONOR), "https://cdn.example/");
});

test("extractBaseHref: relative base resolves against finalUrl", () => {
  assert.equal(extractBaseHref('<head><base href="/subdir/"></head>', DONOR), "https://donor.example/subdir/");
  assert.equal(extractBaseHref('<head><base href="page/"></head>', DONOR), "https://donor.example/post/page/");
});

test("extractBaseHref: no base, empty base, base outside <head>, invalid base → finalUrl", () => {
  assert.equal(extractBaseHref("<html><body>x</body></html>", DONOR), DONOR);
  assert.equal(extractBaseHref('<head><base target="_blank"></head>', DONOR), DONOR); // no href
  assert.equal(extractBaseHref('<head><base href="  "></head>', DONOR), DONOR); // blank href
  assert.equal(extractBaseHref(`</head><base href="https://late.com/">`, DONOR), DONOR); // after </head>
  assert.equal(extractBaseHref('<body><base href="https://in-body.com/"></body>', DONOR), DONOR); // after <body>
  assert.equal(extractBaseHref('<head><base href="http://[broken"></head>', DONOR), DONOR); // unresolvable
});

// ---------------------------------------------------------------------------
// findPlacements
// ---------------------------------------------------------------------------

test("findPlacements: a plain text link produces a complete hit", () => {
  const hits = findPlacements(`<html><body><a href="https://mysite.com/lp">Наш лучший сайт</a></body></html>`, DONOR, OWNED);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], {
    sourceUrl: DONOR,
    finalUrl: DONOR,
    matchedDomain: "mysite.com",
    linkUrl: "https://mysite.com/lp",
    anchor: "Наш лучший сайт",
    isImage: false,
    rel: { raw: "", nofollow: false, sponsored: false, ugc: false, dofollow: true },
  });
});

test("findPlacements: relative hrefs resolve against the final (post-redirect) URL", () => {
  // The page was requested at /old/path but /post/about-us is what answered;
  // resolution must use the latter. Our own domain as the host makes the
  // resolved link observable.
  const finalUrl = "https://mysite.com/post/about-us";
  let hits = findPlacements('<a href="/go">x</a>', finalUrl, OWNED);
  assert.equal(hits[0].linkUrl, "https://mysite.com/go");
  hits = findPlacements('<a href="../go">x</a>', finalUrl, OWNED);
  assert.equal(hits[0].linkUrl, "https://mysite.com/go");
  hits = findPlacements('<a href="?ref=1">x</a>', finalUrl, OWNED);
  assert.equal(hits[0].linkUrl, "https://mysite.com/post/about-us?ref=1");
});

test("findPlacements: <base href> redirects resolution away from finalUrl", () => {
  const html = '<head><base href="https://cdn.example/"></head><a href="/page">x</a>';
  // The owned list has to include the base host for the link to be ours —
  // the point under test is WHERE "/page" resolves, not who owns it.
  const hits = findPlacements(html, DONOR, ["cdn.example"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].linkUrl, "https://cdn.example/page");

  // Same page, donor's own domain in the list: "/page" via base is NOT
  // https://donor.example/page, so nothing matches.
  assert.equal(findPlacements(html, DONOR, OWNED).length, 0);
});

test("findPlacements: skips non-http schemes and in-page fragments", () => {
  const html = [
    `<a href="mailto:info@mysite.com">mail</a>`,
    `<a href="tel:+79990001122">tel</a>`,
    `<a href="javascript:go('mysite.com')">js</a>`,
    `<a href="data:text/html,mysite">data</a>`,
    `<a href="#oursite">frag</a>`,
  ].join("");
  assert.equal(findPlacements(html, DONOR, OWNED).length, 0);
});

test("findPlacements: protocol-relative href inherits the final URL's scheme", () => {
  const hits = findPlacements('<a href="//mysite.com/x">x</a>', "https://donor.example/", OWNED);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].linkUrl, "https://mysite.com/x");
});

test("findPlacements: subdomains match; foreign look-alikes do not", () => {
  const html = `<a href="https://blog.mysite.com/a">1</a><a href="https://notmysite.com/a">2</a><a href="https://mysite.com.evil.com/a">3</a><a href="https://other.example/">4</a>`;
  const hits = findPlacements(html, DONOR, OWNED);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].matchedDomain, "mysite.com");
  assert.equal(hits[0].linkUrl, "https://blog.mysite.com/a");
});

test("findPlacements: the most specific owned domain wins", () => {
  const html = `<a href="https://catalog.shop.mysite.com/p">x</a>`;
  const hits = findPlacements(html, DONOR, ["mysite.com", "shop.mysite.com"]);
  assert.equal(hits[0].matchedDomain, "shop.mysite.com");
});

test("findPlacements: nested <a> closes like a browser — no text leaking between links", () => {
  const hits = findPlacements(`<a href="https://a.mysite.com/">раз<a href="https://b.mysite.com/">два</a></a>`, DONOR, OWNED);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].anchor, "раз");
  assert.equal(hits[1].anchor, "два");
});

test("findPlacements: text after </a> never joins the anchor", () => {
  const hits = findPlacements(`<a href="https://mysite.com/">раз</a> обычный текст`, DONOR, OWNED);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].anchor, "раз");
});

test("findPlacements: an unclosed <a> keeps collecting until the next tag boundary", () => {
  const html = `<p><a href="https://mysite.com/">анкор без закрытия <b>жирный</b></p><a href="https://other.example/">чужой</a>`;
  const hits = findPlacements(html, DONOR, OWNED);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].anchor, "анкор без закрытия жирный");
});

test("findPlacements: dedup by (linkUrl, anchor, rel)", () => {
  const sameTwice = `<a href="https://mysite.com/a">анкор</a><a href="https://mysite.com/a">анкор</a>`;
  assert.equal(findPlacements(sameTwice, DONOR, OWNED).length, 1);

  const differentAnchors = `<a href="https://mysite.com/a">первый</a><a href="https://mysite.com/a">второй</a>`;
  const two = findPlacements(differentAnchors, DONOR, OWNED);
  assert.equal(two.length, 2);
  assert.equal(two[0].anchor, "первый");
  assert.equal(two[1].anchor, "второй");

  const differentRel = `<a href="https://mysite.com/a">анкор</a><a href="https://mysite.com/a" rel="nofollow">анкор</a>`;
  assert.equal(findPlacements(differentRel, DONOR, OWNED).length, 2);

  // URL normalization makes cosmetic spellings the same link
  const normalized = `<a href="https://mysite.com">x</a><a href="https://MYSITE.com/">x</a>`;
  assert.equal(findPlacements(normalized, DONOR, OWNED).length, 1);
});

test("findPlacements: image link takes its anchor from alt and sets isImage", () => {
  const hits = findPlacements(`<a href="https://mysite.com/"><img src="x.png" alt="Наш логотип"></a>`, DONOR, OWNED);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].anchor, "Наш логотип");
  assert.equal(hits[0].isImage, true);
});

test("findPlacements: image without alt still yields a hit with an empty anchor", () => {
  const hits = findPlacements(`<a href="https://mysite.com/"><img src="x.png"></a>`, DONOR, OWNED);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].anchor, "");
  assert.equal(hits[0].isImage, true);
});

test("findPlacements: image alt and text combine like the reference parser", () => {
  const hits = findPlacements(`<a href="https://mysite.com/"><img alt="Фото"> текст</a>`, DONOR, OWNED);
  assert.equal(hits[0].anchor, "Фото текст");
  const altOnlyAfter = findPlacements(`<a href="https://mysite.com/">текст <img alt="Фото"></a>`, DONOR, OWNED);
  assert.equal(altOnlyAfter[0].anchor, "текст Фото");
});

test("findPlacements: anchor strips inner tags and decodes entities", () => {
  const hits = findPlacements(`<a href="https://mysite.com/"><b>жирный</b> &amp; <i>курсив</i> &#171;цитата&#187;</a>`, DONOR, OWNED);
  assert.equal(hits[0].anchor, "жирный & курсив «цитата»");
});

test("findPlacements: anchor whitespace collapses, truncates at 200", () => {
  const messy = findPlacements(`<a href="https://mysite.com/">  раз\n\tдва   три  </a>`, DONOR, OWNED);
  assert.equal(messy[0].anchor, "раз два три");

  const long = "а".repeat(600);
  const truncated = findPlacements(`<a href="https://mysite.com/">${long}</a>`, DONOR, OWNED);
  assert.equal(truncated[0].anchor.length, 200);

  const nbsp = findPlacements(`<a href="https://mysite.com/">раз&nbsp;два</a>`, DONOR, OWNED);
  assert.equal(nbsp[0].anchor, "раз два");
});

test("findPlacements: rel survives the trip, flags parsed", () => {
  const hits = findPlacements(`<a href="https://mysite.com/" rel="sponsored">x</a>`, DONOR, OWNED);
  assert.equal(hits[0].rel.raw, "sponsored");
  assert.equal(hits[0].rel.sponsored, true);
  assert.equal(hits[0].rel.dofollow, false);
  assert.equal(hits[0].rel.nofollow, false);

  const mixed = findPlacements(`<a href="https://mysite.com/" rel="bookmark nofollow noopener">x</a>`, DONOR, OWNED);
  assert.equal(mixed[0].rel.nofollow, true);
  assert.equal(mixed[0].rel.dofollow, false);
});

test("findPlacements: href entities and unquoted/uppercase attributes parse", () => {
  const hits = findPlacements(`<A HREF="https://mysite.com/a?x=1&amp;y=2" REL=nofollow>x</A>`, DONOR, OWNED);
  assert.equal(hits[0].linkUrl, "https://mysite.com/a?x=1&y=2");
  assert.equal(hits[0].rel.nofollow, true);

  const spaced = findPlacements(`<a href = 'https://mysite.com/' >x</a>`, DONOR, OWNED);
  assert.equal(spaced[0].linkUrl, "https://mysite.com/");
});

test("findPlacements: links inside <script>, <style> and comments are invisible", () => {
  const html = [
    `<script>document.write('<a href="https://mysite.com/">js</a>')</script>`,
    `<style>a[href="https://mysite.com/"]{color:red}</style>`,
    `<!-- <a href="https://mysite.com/">commented</a> -->`,
  ].join("");
  assert.equal(findPlacements(html, DONOR, OWNED).length, 0);
});

test("findPlacements: anchors without a usable href are skipped", () => {
  const html = `<a>нет href</a><a href="">пустой</a><a name="anchor">именной</a>`;
  assert.equal(findPlacements(html, DONOR, OWNED).length, 0);
});

test("findPlacements: non-anchor elements pointing at us are not links", () => {
  const html = `<iframe src="https://mysite.com/embed"></iframe><img src="https://mysite.com/pixel.png">`;
  assert.equal(findPlacements(html, DONOR, OWNED).length, 0);
});

test("findPlacements: opts.sourceUrl overrides the reported source", () => {
  const hits = findPlacements('<a href="https://mysite.com/">x</a>', "https://final.example/", OWNED, {
    sourceUrl: "https://requested.example/original",
  });
  assert.equal(hits[0].sourceUrl, "https://requested.example/original");
  assert.equal(hits[0].finalUrl, "https://final.example/");
});

test("findPlacements: owned list may be unicode; href hosts are punycoded", () => {
  const hits = findPlacements(`<a href="https://сайт.рф/page">x</a>`, DONOR, ["сайт.рф"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].matchedDomain, "xn--80aswg.xn--p1ai");
  assert.equal(hits[0].linkUrl, "https://xn--80aswg.xn--p1ai/page");
});

test("findPlacements: full realistic donor page keeps only our links", () => {
  const html = `<!DOCTYPE html>
<html><head><title>Донор</title><meta charset="utf-8"><base href="https://donor.example/">
</head><body>
<nav><a href="/">home</a> <a href="/about" rel="nofollow">about</a></nav>
<article><p>Текст про <a href="https://www.mysite.com/guide" rel="noopener">гайд по SEO</a>
и ещё <a href="https://blog.mysite.com/news">новости</a>,
а тут <a href="https://competitor.net/x">конкурент</a>.</p>
<a href="https://mysite.com/guide"><img src="banner.gif" alt="Наш баннер"></a>
</article>
<script>var x = '<a href="https://mysite.com/nope">nope</a>';</script>
</body></html>`;
  const hits = findPlacements(html, DONOR, OWNED);
  assert.deepEqual(
    hits.map((hit) => [hit.linkUrl, hit.anchor, hit.isImage, hit.rel.raw]),
    [
      ["https://www.mysite.com/guide", "гайд по SEO", false, "noopener"],
      ["https://blog.mysite.com/news", "новости", false, ""],
      ["https://mysite.com/guide", "Наш баннер", true, ""],
    ],
  );
});

test("findPlacements: CP1251 body decoded via decodeBody yields a readable anchor", () => {
  const page = '<html><head><meta charset="windows-1251"></head><body><a href="https://mysite.com/">Лучший каталог</a></body></html>';
  const html = decodeBody(cp1251(page), "text/html");
  const hits = findPlacements(html, DONOR, OWNED);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].anchor, "Лучший каталог");
});

test("findPlacements: the solidus in <a/> is ignored, as in HTML browsers", () => {
  // HTML5: a trailing "/" only self-closes void elements; <a/> stays open,
  // so the following text is its anchor.
  const hits = findPlacements(`<a href="https://mysite.com/"/>хвост становится анкором`, DONOR, OWNED);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].anchor, "хвост становится анкором");
});

test("findPlacements: empty owned list or junk owned list finds nothing", () => {
  const html = '<a href="https://mysite.com/">x</a>';
  assert.equal(findPlacements(html, DONOR, []).length, 0);
  assert.equal(findPlacements(html, DONOR, ["not a domain", ""]).length, 0);
});
