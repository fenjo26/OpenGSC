import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Plain JS by design (see audit.test.ts for the why): the classic script with a module.exports
// footer is imported directly, so the tests run exactly what the extension runs. The DOM half
// of collectFacts is verified by hand; everything pure lives here.
import ExtensionAudit from "../../../extension/lib/audit.js";
import { apexOf } from "@/lib/drops/registries";

const { deriveIssues, pageScore, robotsAllows, registrableOf, TWO_LABEL_SUFFIXES, META_LIMITS } = ExtensionAudit as {
  deriveIssues: (facts: Record<string, unknown>, vitals?: Record<string, unknown>) => { id: string; severity: string; detail: string }[];
  pageScore: (issues: { severity: string }[]) => number;
  robotsAllows: (robotsTxt: string, userAgent: string, path: string) => { allowed: boolean; rule: string | null };
  registrableOf: (host: string) => string;
  TWO_LABEL_SUFFIXES: string[];
  META_LIMITS: { title: { auditMin: number; auditMax: number }; description: { auditMin: number; auditMax: number } };
};

void META_LIMITS;

// ─── fixtures ─────────────────────────────────────────────────────────────────────

function detailFacts(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/page",
    host: "example.com",
    title: "x".repeat(55),
    titleLength: 55,
    description: "x".repeat(155),
    descriptionLength: 155,
    h1Count: 1,
    h1Text: "Page",
    canonical: "https://example.com/page",
    robots: "index,follow",
    noindex: false,
    hreflang: [],
    jsonLdBlocks: 1,
    jsonLdValid: 1,
    jsonLdInvalid: 0,
    og: { title: true, description: true, image: true, url: true },
    links: { total: 40, internal: 35, external: 5 },
    images: { total: 10, noAlt: 0 },
    words: 900,
    detail: {
      lang: "en",
      charset: "UTF-8",
      viewport: "width=device-width",
      robotsMeta: "index,follow",
      xRobots: null,
      canonical: "https://example.com/page",
      title: "x".repeat(55),
      description: "x".repeat(155),
      headings: [
        { level: 1, text: "Page", hidden: false },
        { level: 2, text: "Part", hidden: false },
      ],
      links: [
        { href: "https://example.com/", text: "home", rel: [], internal: true, area: "nav", index: 0, kind: "" },
        { href: "https://other.com/", text: "out", rel: ["nofollow"], internal: false, area: "content", index: 1, kind: "" },
      ],
      images: [
        { src: "https://example.com/a.png", alt: "a", width: 10, height: 10, hasDims: true, lazy: false, ext: "png", area: "content" },
        { src: "https://example.com/b.png", alt: "", width: 10, height: 10, hasDims: true, lazy: false, ext: "png", area: "content" },
      ],
      jsonLd: [{ types: ["Article"], valid: true, error: "" }],
      microdataTypes: [],
      og: { "og:title": "t", "og:image": "i" },
      twitter: {},
      hreflang: [],
      counts: { words: 900, linksInternal: 1, linksExternal: 1, linksNofollow: 1, imagesNoAlt: 0, h1: 1 },
      truncated: {},
      scripts: ["https://example.com/app.js"],
    },
    ...overrides,
  };
}

const ids = (facts: Record<string, unknown>, vitals?: Record<string, unknown>) =>
  deriveIssues(facts, vitals).map(i => i.id);

// ─── a healthy detailed page ───────────────────────────────────────────────────────

test("a healthy detailed page produces no issues", () => {
  assert.deepEqual(deriveIssues(detailFacts()), []);
});

// ─── headings ─────────────────────────────────────────────────────────────────────

test("only hidden H1s → h1_missing (a hidden H1 is a finding, not an H1)", () => {
  const facts = detailFacts();
  facts.detail.headings = [{ level: 1, text: "Ghost", hidden: true }];
  facts.detail.counts.h1 = 0;
  const found = ids(facts);
  assert.ok(found.includes("h1_missing"));
});

test("two visible H1s → h1_multiple; hidden ones don't count", () => {
  const facts = detailFacts();
  facts.detail.headings = [
    { level: 1, text: "A", hidden: false },
    { level: 1, text: "B", hidden: true },
    { level: 1, text: "C", hidden: false },
  ];
  facts.detail.counts.h1 = 2;
  const found = ids(facts);
  assert.ok(found.includes("h1_multiple"));
  assert.equal(found.filter(i => i === "h1_missing").length, 0);
});

test("H2 → H4 flags heading_skip, H4 → H2 does not", () => {
  const down = detailFacts();
  down.detail.headings = [
    { level: 2, text: "A", hidden: false },
    { level: 4, text: "B", hidden: false },
  ];
  assert.ok(ids(down).includes("heading_skip"));

  const up = detailFacts();
  up.detail.headings = [
    { level: 4, text: "A", hidden: false },
    { level: 2, text: "B", hidden: false },
  ];
  assert.equal(ids(up).includes("heading_skip"), false);
});

test("an empty visible heading flags heading_empty", () => {
  const facts = detailFacts();
  facts.detail.headings = [{ level: 2, text: "", hidden: false }];
  assert.ok(ids(facts).includes("heading_empty"));
});

// ─── technical / accessibility ─────────────────────────────────────────────────────

test("images without width/height flags images_no_dims with the count", () => {
  const facts = detailFacts();
  facts.detail.images = [
    { src: "https://example.com/a.png", alt: "a", width: 0, height: 0, hasDims: false, lazy: false, ext: "png", area: "content" },
    { src: "https://example.com/b.png", alt: "", width: 10, height: 10, hasDims: true, lazy: false, ext: "png", area: "content" },
    { src: "https://example.com/c.png", alt: "c", width: 0, height: 0, hasDims: false, lazy: false, ext: "png", area: "content" },
  ];
  const found = deriveIssues(facts).find(i => i.id === "images_no_dims");
  assert.ok(found);
  assert.equal(found!.detail, "2");
});

test("missing html lang and viewport flag their warnings", () => {
  const facts = detailFacts();
  facts.detail.lang = "";
  facts.detail.viewport = "";
  const found = ids(facts);
  assert.ok(found.includes("html_lang_missing"));
  assert.ok(found.includes("viewport_missing"));
});

test("a link with no text, aria-label or image-alt flags link_empty_text", () => {
  const facts = detailFacts();
  facts.detail.links = facts.detail.links.concat([
    { href: "https://x.com/1", text: "", rel: [], internal: false, area: "content", index: 2, kind: "" },
    { href: "https://x.com/2", text: "", rel: [], internal: false, area: "content", index: 3, kind: "" },
  ]);
  const found = deriveIssues(facts).find(i => i.id === "link_empty_text");
  assert.ok(found);
  assert.equal(found!.detail, "2");
});

test("canonical to another URL flags canonical_other; slash/hash differences do not", () => {
  const other = detailFacts({ canonical: "https://example.com/other" });
  other.detail.canonical = "https://example.com/other";
  assert.ok(ids(other).includes("canonical_other"));

  const sameSlash = detailFacts({ canonical: "https://example.com/page/" });
  sameSlash.detail.canonical = "https://example.com/page/";
  assert.equal(ids(sameSlash).includes("canonical_other"), false);
});

test("http images/scripts on an https page flag mixed_content", () => {
  const facts = detailFacts();
  facts.detail.images = [
    { src: "http://example.com/a.png", alt: "a", width: 1, height: 1, hasDims: true, lazy: false, ext: "png", area: "content" },
  ];
  facts.detail.scripts = ["http://example.com/app.js"];
  const found = deriveIssues(facts).find(i => i.id === "mixed_content");
  assert.ok(found);
  assert.equal(found!.detail, "2");
});

// ─── vitals-driven ids ─────────────────────────────────────────────────────────────

test("lcp/cls above the upper thresholds flag warnings, good values do not", () => {
  assert.ok(ids(detailFacts(), { lcp: 5000, cls: 0.1 }).includes("lcp_poor"));
  assert.ok(ids(detailFacts(), { lcp: 2000, cls: 0.4 }).includes("cls_poor"));
  assert.deepEqual(ids(detailFacts(), { lcp: 1800, cls: 0.02 }), []);
});

test("null vitals (not measured) never flag", () => {
  assert.deepEqual(ids(detailFacts(), { lcp: null, cls: null }), []);
});

// ─── the page score ────────────────────────────────────────────────────────────────

test("page score: 100 clean, −10/−4/−1, floor 0", () => {
  assert.equal(pageScore([]), 100);
  assert.equal(pageScore([{ severity: "error" }]), 90);
  assert.equal(pageScore([{ severity: "warn" }]), 96);
  assert.equal(pageScore([{ severity: "info" }]), 99);
  assert.equal(
    pageScore(Array.from({ length: 12 }, () => ({ severity: "error" }))),
    0,
  );
});

// ─── robotsAllows ──────────────────────────────────────────────────────────────────

test("robotsAllows: empty robots allows everything", () => {
  assert.deepEqual(robotsAllows("", "Googlebot", "/x"), { allowed: true, rule: null });
});

test("robotsAllows: full Disallow blocks with the rule named", () => {
  assert.deepEqual(robotsAllows("User-agent: *\nDisallow: /", "Googlebot", "/x"), { allowed: false, rule: "Disallow: /" });
});

test("robotsAllows: an empty Disallow allows everything", () => {
  assert.deepEqual(robotsAllows("User-agent: *\nDisallow:", "Googlebot", "/x"), { allowed: true, rule: null });
});

test("robotsAllows: plain rules are prefix matches — subpaths and longer names included", () => {
  const txt = "User-agent: *\nDisallow: /private";
  assert.equal(robotsAllows(txt, "Googlebot", "/private").allowed, false);
  assert.equal(robotsAllows(txt, "Googlebot", "/private/x").allowed, false);
  assert.equal(robotsAllows(txt, "Googlebot", "/privateX").allowed, false); // prefix semantics
  assert.equal(robotsAllows(txt, "Googlebot", "/public").allowed, true);
});

test("robotsAllows: same length → Allow wins; longer Disallow beats shorter Allow", () => {
  const tie = "User-agent: *\nDisallow: /p\nAllow: /p";
  assert.equal(robotsAllows(tie, "Googlebot", "/p").allowed, true);
  const longer = "User-agent: *\nDisallow: /page\nAllow: /p";
  assert.equal(robotsAllows(longer, "Googlebot", "/page").allowed, false);
});

test("robotsAllows: wildcards and the $ anchor", () => {
  const pdf = "User-agent: *\nDisallow: /*.pdf$";
  assert.equal(robotsAllows(pdf, "Googlebot", "/doc.pdf").allowed, false);
  assert.equal(robotsAllows(pdf, "Googlebot", "/doc.pdfx").allowed, true);
  const end = "User-agent: *\nDisallow: /end$";
  assert.equal(robotsAllows(end, "Googlebot", "/end").allowed, false);
  assert.equal(robotsAllows(end, "Googlebot", "/end/1").allowed, true);
});

test("robotsAllows: groups apply per user agent, most specific wins", () => {
  const txt = "User-agent: OtherBot\nDisallow: /\n\nUser-agent: *\nDisallow: /nope";
  assert.equal(robotsAllows(txt, "Googlebot", "/fine").allowed, true);
  assert.equal(robotsAllows(txt, "OtherBot", "/fine").allowed, false);
  const specific = "User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /only";
  assert.equal(robotsAllows(specific, "Googlebot", "/other").allowed, true);
  assert.equal(robotsAllows(specific, "Googlebot", "/only").allowed, false);
});

test("robotsAllows: comments and blank lines don't break groups", () => {
  const txt = "# comment\n\nUser-agent: * # trailing\nDisallow: /p\n\nSitemap: https://x/s.xml";
  assert.equal(robotsAllows(txt, "Googlebot", "/p").allowed, false);
  assert.equal(robotsAllows(txt, "Googlebot", "/q").allowed, true);
});

// ─── registrableOf ↔ apexOf parity ────────────────────────────────────────────────

test("registrableOf agrees with apexOf on 40+ hosts, all two-label suffixes included", () => {
  const hosts = [
    "example.com", "www.example.com", "deep.sub.example.com", "example.co.uk", "www.shop.example.co.uk",
    "example.com.au", "example.gr", "www.google.gr", "example.com.tr", "example.co.jp", "example.or.jp",
    "example.com.ua", "example.in.ua", "example.kiev.ua", "example.com.ar", "example.bet.ar",
    "example.ru", "example.net.ru", "example.pp.ru", "example.za.net", "example.uk.com",
    "example.com.se", "example.com.de", "example.gb.net", "example.hu.net", "example.ae.org",
    "example.za.bz", "example.br.com", "example.co.id", "example.com.mx", "example.co.il",
    "example.com.br", "example.com.cn", "example.com.pl", "example.com.py", "example.com.eg",
    "example.co.th", "example.com.sa", "example.com.sg", "example.com.hk", "example.com.vn",
    "example.org.uk", "example.ltd.uk", "example.gob.ar", "example.gen.tr", "example.gob.pe",
  ];
  for (const host of hosts) {
    assert.equal(
      registrableOf(host),
      apexOf(host) ?? "",
      `host ${host}: extension registrableOf must match apexOf`,
    );
  }
});

test("registrableOf: junk hosts return \"\" (never a bare TLD or an IP)", () => {
  assert.equal(registrableOf("co.uk"), "");
  assert.equal(registrableOf("com"), "");
  assert.equal(registrableOf("192.168.1.1"), "");
  assert.equal(registrableOf(""), "");
  assert.equal(registrableOf("example.unknownzz"), "example.unknownzz"); // single-label TLD default
});

test("the copied TWO_LABEL_SUFFIXES match src/lib/drops/registries.ts exactly", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/drops/registries.ts"), "utf8");
  const centralnic = src.match(/CENTRALNIC_RETAIL_ZONES = \[([^\]]*)\]/)?.[1] ?? "";
  const setBody = src.match(/TWO_LABEL_SUFFIXES = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
  const stripSpread = setBody.replace(/\.\.\.CENTRALNIC_RETAIL_ZONES\s*,?/g, "");
  const quoted = (s: string) => [...s.matchAll(/"([a-z0-9.-]+)"/g)].map(m => m[1]);
  const expected = [...new Set([...quoted(centralnic), ...quoted(stripSpread)])].sort();
  assert.deepEqual([...TWO_LABEL_SUFFIXES].slice().sort(), expected);
});
