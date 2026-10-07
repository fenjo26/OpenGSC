// Wave A — AEO citation classification. The classifier is pure string work over the citations
// JSON the tracker already stores, so what is worth pinning is the SILENT failure mode: a
// competitor filed under "forum", or Reddit filed under "other", changes the answer to "who
// crowds us out of AI answers" without any error anywhere. Precedence (brand/competitor beat
// every platform rule) and the conservative fallthrough to "other" carry most of the value.
//
// R+ adds the operator overlay (extra per-category lists) and the GR starter built-ins — the
// precedence question gets sharper there: identity (brand/competitor) vs operator intent
// (overlay) vs defaults (built-ins), in that order.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  categorizeDomain, classifyPageType, classifyCitations, categoryCounts, redditCut,
  isRedditDomain, extractSubreddit, otherShare, normalizeOverlayHost,
  type ExtraDomainLists,
} from "./aeoCitationClassify";

const BRAND = ["oursite.gr"];
const RIVALS = ["bigcompetitor.com"];

// ── categorizeDomain: one probe per category rule ─────────────────────────────

test("forum: reddit (any subdomain), quora, stackexchange, label 'forum(s)'; stackoverflow is NOT forum", () => {
  assert.equal(categorizeDomain("reddit.com", BRAND, RIVALS), "forum");
  assert.equal(categorizeDomain("old.reddit.com"), "forum");
  assert.equal(categorizeDomain("quora.com"), "forum");
  assert.equal(categorizeDomain("gardening.stackexchange.com"), "forum");
  assert.equal(categorizeDomain("forums.whirlpool.net.au"), "forum");
  assert.equal(categorizeDomain("community.example.forum.io"), "forum");
  // The deliberate split: SO is a developer site, SE sites are Q&A communities.
  assert.equal(categorizeDomain("stackoverflow.com"), "developer");
});

test("social: the major networks; a lookalike .social host is NOT social", () => {
  for (const d of ["facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "linkedin.com", "pinterest.com", "threads.net", "mastodon.social", "m.facebook.com"]) {
    assert.equal(categorizeDomain(d), "social", d);
  }
  // Conservative on purpose: unknown instances on other hosts are "other", not guesses.
  assert.equal(categorizeDomain("fosstodon.org"), "other");
  assert.equal(categorizeDomain("news.ycombinator.com"), "other");
});

test("video / developer / ecommerce / reviews / reference / editorial", () => {
  assert.equal(categorizeDomain("youtube.com"), "video");
  assert.equal(categorizeDomain("m.youtube.com"), "video");
  assert.equal(categorizeDomain("vimeo.com"), "video");
  for (const d of ["github.com", "gist.github.com", "stackoverflow.com", "gitlab.com", "developer.mozilla.org", "npmjs.com"]) {
    assert.equal(categorizeDomain(d), "developer", d);
  }
  // First-label matching covers the regional marketplaces without enumerating them.
  for (const d of ["amazon.com", "amazon.de", "amazon.co.uk", "ebay.com", "ebay.com.au", "etsy.com", "aliexpress.com", "walmart.com", "alibaba.com"]) {
    assert.equal(categorizeDomain(d), "ecommerce", d);
  }
  for (const d of ["trustpilot.com", "sitejabber.com", "g2.com", "capterra.com", "reviews.io", "yelp.com"]) {
    assert.equal(categorizeDomain(d), "reviews", d);
  }
  for (const d of ["en.wikipedia.org", "de.wikipedia.org", "wikipedia.org", "wikimedia.org", "britannica.com", "dictionary.com"]) {
    assert.equal(categorizeDomain(d), "reference", d);
  }
  for (const d of ["nytimes.com", "bbc.com", "bbc.co.uk", "theguardian.com", "cnn.com", "reuters.com", "bloomberg.com", "forbes.com", "spiegel.de", "lemonde.fr"]) {
    assert.equal(categorizeDomain(d), "editorial", d);
  }
});

test("institutional: edu/gov TLDs and second-level suffixes (.edu.au, .gov.uk, .ac.jp)", () => {
  for (const d of ["harvard.edu", "www.harvard.edu", "mit.edu.au", "cabinetoffice.gov.uk", "usa.gov", "imperial.ac.uk", "u-tokyo.ac.jp"]) {
    assert.equal(categorizeDomain(d), "institutional", d);
  }
  // Bare .ac is the Ascension Islands ccTLD, not academia — the rule wants a code after ac/edu/gov.
  assert.equal(categorizeDomain("example.ac"), "other");
});

test("brand and competitor beat every platform rule, on apex or subdomain", () => {
  assert.equal(categorizeDomain("oursite.gr", BRAND, RIVALS), "brand");
  assert.equal(categorizeDomain("blog.oursite.gr", BRAND, RIVALS), "brand");
  assert.equal(categorizeDomain("bigcompetitor.com", BRAND, RIVALS), "competitor");
  assert.equal(categorizeDomain("shop.bigcompetitor.com", BRAND, RIVALS), "competitor");
  // A rival's community hosted on a reddit subdomain is still "who crowds us out".
  assert.equal(categorizeDomain("old.reddit.com", BRAND, ["reddit.com"]), "competitor");
  // Host-boundary: a lookalike is neither brand nor competitor.
  assert.equal(categorizeDomain("notoursite.gr", BRAND, RIVALS), "other");
  assert.equal(categorizeDomain("bigcompetitor.com.evil.io", BRAND, RIVALS), "other");
});

test("unknown domains fall through to other; inputs are normalized (scheme, www, case, path)", () => {
  assert.equal(categorizeDomain("some-random-shop.example"), "other");
  assert.equal(categorizeDomain("https://WWW.Reddit.Com/r/foo"), "forum");
  assert.equal(categorizeDomain(""), "other");
});

// ── R+: GR starter built-ins ──────────────────────────────────────────────────

test("GR starter set: Greek forums, aggregators, reference and news are named, not 'other'", () => {
  for (const d of ["insomnia.gr", "www.insomnia.gr", "adslgr.com"]) {
    assert.equal(categorizeDomain(d), "forum", d);
  }
  for (const d of ["skroutz.gr", "bestprice.gr"]) {
    assert.equal(categorizeDomain(d), "ecommerce", d);
  }
  assert.equal(categorizeDomain("sansimera.gr"), "reference");
  for (const d of [
    "kathimerini.gr", "tovima.gr", "protothema.gr", "naftemporiki.gr", "in.gr",
    "newsit.gr", "tanea.gr", "ethnos.gr", "skai.gr", "efsyn.gr",
  ]) {
    assert.equal(categorizeDomain(d), "editorial", d);
  }
  // Host boundary still applies to the starter set: a lookalike is not the outlet.
  assert.equal(categorizeDomain("notskroutz.gr"), "other");
  assert.equal(categorizeDomain("skroutz.gr.evil.io"), "other");
});

// ── R+: the operator overlay ──────────────────────────────────────────────────

test("overlay adds a category to an otherwise unknown domain, subdomains included", () => {
  const lists: ExtraDomainLists = { editorial: ["localnews.example"] };
  assert.equal(categorizeDomain("localnews.example", [], [], lists), "editorial");
  assert.equal(categorizeDomain("www.localnews.example", [], [], lists), "editorial");
  assert.equal(categorizeDomain("localnews.example", [], [], undefined), "other"); // no overlay → unchanged
  // A sibling on a DIFFERENT subdomain depth still needs the host boundary, not substring.
  assert.equal(categorizeDomain("notlocalnews.example", [], [], lists), "other");
});

test("operator intent beats a built-in match in a different category", () => {
  // youtube.com is built-in video; the operator who lists it as editorial has looked at it.
  const lists: ExtraDomainLists = { editorial: ["youtube.com"] };
  assert.equal(categorizeDomain("youtube.com", [], [], lists), "editorial");
  assert.equal(categorizeDomain("m.youtube.com", [], [], lists), "editorial");
  // Without the overlay the built-in verdict stands.
  assert.equal(categorizeDomain("youtube.com"), "video");
});

test("brand and competitor still win over the overlay (identity beats taxonomy)", () => {
  const lists: ExtraDomainLists = { forum: ["oursite.gr", "bigcompetitor.com", "reddit.com"] };
  assert.equal(categorizeDomain("oursite.gr", BRAND, RIVALS, lists), "brand");
  assert.equal(categorizeDomain("bigcompetitor.com", BRAND, RIVALS, lists), "competitor");
  // The same reddit.com entry DOES take effect for a domain that is neither — the overlay is
  // consulted after identity, not ignored.
  assert.equal(categorizeDomain("reddit.com", BRAND, RIVALS, lists), "forum"); // built-in agrees
});

test("a domain listed under two overlay categories resolves by the fixed category order", () => {
  // "forum" precedes "editorial" in OVERLAY_CATEGORIES — deterministic regardless of the
  // object's key order at the call site.
  const lists: ExtraDomainLists = { editorial: ["multi.example"], forum: ["multi.example"] };
  assert.equal(categorizeDomain("multi.example", [], [], lists), "forum");
  const reversed: ExtraDomainLists = { forum: ["multi.example"], editorial: ["multi.example"] };
  assert.equal(categorizeDomain("multi.example", [], [], reversed), "forum");
});

test("classifyCitations threads the overlay through", () => {
  const raw = [{ url: "https://localnews.example/story", domain: "localnews.example", title: "S" }];
  assert.equal(classifyCitations(raw)[0].category, "other");
  assert.equal(classifyCitations(raw, [], [], { editorial: ["localnews.example"] })[0].category, "editorial");
});

// ── R+: normalizeOverlayHost (the rule the editor and the save path share) ─────

test("normalizeOverlayHost: scheme/www/path/port stripped, case folded", () => {
  assert.equal(normalizeOverlayHost("https://Example.gr/Path?x=1"), "example.gr");
  assert.equal(normalizeOverlayHost("http://www.example.gr:8080/a"), "example.gr");
  assert.equal(normalizeOverlayHost("  Example.GR  "), "example.gr");
  assert.equal(normalizeOverlayHost("forums.example.gr"), "forums.example.gr"); // subdomain kept, host-boundary matched later
});

test("normalizeOverlayHost rejects what is not a registrable-ish ASCII host", () => {
  assert.equal(normalizeOverlayHost("*.gr"), "");       // wildcard breadth — by design
  assert.equal(normalizeOverlayHost("gr"), "");         // single label
  assert.equal(normalizeOverlayHost(""), "");
  assert.equal(normalizeOverlayHost(null), "");
  assert.equal(normalizeOverlayHost(42), "");
  assert.equal(normalizeOverlayHost("δοκιμή.gr"), "");   // unicode/IDN — citations arrive punycoded
  assert.equal(normalizeOverlayHost("-bad.example"), "");
  assert.equal(normalizeOverlayHost("example..gr"), "");
});

// ── R+: otherShare ────────────────────────────────────────────────────────────

test("otherShare: the 'other' slice of categoryCounts, 0 when nothing fell through", () => {
  const counts = categoryCounts([
    { category: "forum" as const }, { category: "forum" as const },
    { category: "other" as const }, { category: "editorial" as const },
  ]);
  assert.equal(otherShare(counts), 0.25);
  assert.equal(otherShare(categoryCounts([{ category: "brand" as const }, { category: "forum" as const }])), 0);
  assert.equal(otherShare(categoryCounts([{ category: "other" as const }])), 1);
  assert.equal(otherShare(categoryCounts([])), 0);
});

// ── classifyPageType ──────────────────────────────────────────────────────────

test("page types: one probe per rule", () => {
  assert.equal(classifyPageType("https://example.com/"), "homepage");
  assert.equal(classifyPageType("https://example.com"), "homepage");
  assert.equal(classifyPageType("https://example.com/top-10-chairs"), "listicle");
  assert.equal(classifyPageType("https://example.com/best-chairs"), "listicle");
  assert.equal(classifyPageType("https://example.com/guides/top-10-chairs"), "listicle");
  assert.equal(classifyPageType("https://example.com/how-to-clean-leather"), "howto");
  assert.equal(classifyPageType("https://example.com/guides/buying-guide"), "howto");
  assert.equal(classifyPageType("https://example.com/chairs-vs-sofas"), "comparison");
  assert.equal(classifyPageType("https://example.com/compare/a-b"), "comparison");
  assert.equal(classifyPageType("https://example.com/reviews/ergo-chair"), "review");
  assert.equal(classifyPageType("https://example.com/ergo-chair-review"), "review");
  assert.equal(classifyPageType("https://shop.example.com/product/ergo-chair"), "product");
  assert.equal(classifyPageType("https://shop.example.com/dp/B01ABC"), "product");
  assert.equal(classifyPageType("https://example.com/docs/api"), "doc");
  assert.equal(classifyPageType("https://developer.mozilla.org/en-US/docs/Web/API"), "doc");
  assert.equal(classifyPageType("https://forum.example.com/t/some-thread/12345"), "forum-thread");
  assert.equal(classifyPageType("https://forum.example.com/viewtopic.php?t=42"), "forum-thread");
  assert.equal(classifyPageType("https://www.youtube.com/watch?v=abc123"), "video");
  assert.equal(classifyPageType("https://example.com/2026/03/07/news-roundup"), "article");
  assert.equal(classifyPageType("https://example.com/blog/what-we-learned"), "article");
  assert.equal(classifyPageType("https://example.com/random/page-x"), "other");
});

test("reddit thread URLs are forum-threads (the /comments/ segment), homepage otherwise", () => {
  assert.equal(classifyPageType("https://www.reddit.com/r/Cars/comments/abc123/best_suv/"), "forum-thread");
  assert.equal(classifyPageType("https://www.reddit.com/"), "homepage");
});

test("title hints only as fallback when the URL carries no path", () => {
  assert.equal(classifyPageType("https://example.com", "Top 10 Best Chairs"), "listicle");
  assert.equal(classifyPageType("https://example.com", "How to Clean Leather"), "howto");
  assert.equal(classifyPageType("https://example.com", "A vs B"), "comparison");
  assert.equal(classifyPageType("https://example.com", "Ergo Chair Review"), "review");
  assert.equal(classifyPageType("https://example.com", "Just a homepage"), "homepage");
  // A real path beats the title: the URL is the stronger evidence.
  assert.equal(classifyPageType("https://example.com/reviews/x", "Top 10 things"), "review");
});

// ── Reddit helpers ────────────────────────────────────────────────────────────

test("isRedditDomain / extractSubreddit", () => {
  assert.equal(isRedditDomain("reddit.com"), true);
  assert.equal(isRedditDomain("old.reddit.com"), true);
  assert.equal(isRedditDomain("https://www.reddit.com/r/foo"), true);
  assert.equal(isRedditDomain("redditcomment.com"), false, "host boundary, not substring");
  assert.equal(isRedditDomain("notreddit.com"), false);
  assert.equal(extractSubreddit("https://www.reddit.com/r/Cars/comments/abc/x/"), "Cars");
  assert.equal(extractSubreddit("https://old.reddit.com/r/explainlikeimfive/"), "explainlikeimfive");
  assert.equal(extractSubreddit("https://www.reddit.com/"), null);
  // Subreddit names are [A-Za-z0-9_] by Reddit's own rules, so the capture stops at a hyphen.
  assert.equal(extractSubreddit("https://example.com/r/not-reddit"), "not", "parses the shape — the caller scopes it to reddit domains");
});

// ── classifyCitations + aggregates ────────────────────────────────────────────

test("classifyCitations fills category/pageType and recomputes against the CURRENT brand/rival lists", () => {
  const raw = [
    { url: "https://www.reddit.com/r/Cars/comments/a/b/", domain: "www.reddit.com", title: "B" },
    { url: "https://oursite.gr/", domain: "oursite.gr", title: "" },
  ];
  const out = classifyCitations(raw, BRAND, RIVALS);
  assert.deepEqual(out[0], { url: "https://www.reddit.com/r/Cars/comments/a/b/", domain: "www.reddit.com", title: "B", category: "forum", pageType: "forum-thread" });
  assert.equal(out[1].category, "brand");
  assert.equal(out[1].pageType, "homepage");
  // A newly added rival re-tags the stored history — the same free-recompute promise share of
  // voice makes. Classification is never trusted from stale stored fields.
  assert.equal(classifyCitations(raw, BRAND, ["reddit.com"])[0].category, "competitor");
});

test("categoryCounts: shares over the total, sorted by count with a stable tiebreak", () => {
  const citations = [
    { category: "forum" as const }, { category: "forum" as const }, { category: "video" as const },
  ];
  const counts = categoryCounts(citations);
  assert.deepEqual(counts.map(c => c.category), ["forum", "video"]);
  assert.equal(counts[0].count, 2);
  assert.equal(counts[0].share, 2 / 3);
  assert.equal(counts[1].share, 1 / 3);
  // Equal counts fall back to the fixed category order, not insertion order.
  const tied = categoryCounts([{ category: "other" as const }, { category: "brand" as const }]);
  assert.deepEqual(tied.map(c => c.category), ["brand", "other"]);
  assert.deepEqual(categoryCounts([]), []);
});

test("redditCut: count + ranked subreddits, grouped case-insensitively", () => {
  const cut = redditCut([
    { url: "https://www.reddit.com/r/Cars/comments/a/x/", domain: "www.reddit.com" },
    { url: "https://www.reddit.com/r/cars/comments/b/y/", domain: "www.reddit.com" },
    { url: "https://old.reddit.com/r/BuyItForLife/", domain: "old.reddit.com" },
    { url: "https://www.reddit.com/", domain: "www.reddit.com" }, // reddit, but no subreddit
    { url: "https://example.com/r/Cars/", domain: "example.com" }, // shape match, wrong domain
  ]);
  assert.equal(cut.count, 4);
  assert.deepEqual(cut.subreddits, [
    { name: "cars", count: 2 },
    { name: "buyitforlife", count: 1 },
  ]);
  assert.deepEqual(redditCut([]), { count: 0, subreddits: [] });
});
