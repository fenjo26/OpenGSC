import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CWV_POOR, PSI_SAMPLE_MAX, isCwvPoor, parsePsiResponse, pickPsiSample } from "./psi";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "psi-mobile.json");

test("parses a real PageSpeed response with field data (LCP, INP, CLS in hundredths, lab score/TTFB)", () => {
  const data = JSON.parse(readFileSync(fixturePath, "utf8"));
  // The fixture must never grow an API key — it is committed.
  assert.equal(JSON.stringify(data).includes("key="), false);

  const parsed = parsePsiResponse(data);
  assert.equal(parsed.source, "field");
  assert.equal(parsed.lcp, 4310);          // LARGEST_CONTENTFUL_PAINT_MS percentile, ms
  assert.equal(parsed.inp, 612);           // INTERACTION_TO_NEXT_PAINT_MS percentile, ms
  assert.equal(parsed.cls, 0.28);          // CUMULATIVE_LAYOUT_SHIFT_SCORE 28 → 0.28
  assert.equal(parsed.ttfb, 570);          // lab server-response-time, ms
  assert.equal(parsed.score, 62);          // lighthouse categories.performance.score 0.62
  // Every poor band is crossed: the audit's cwv_poor must fire on this page.
  assert.equal(isCwvPoor(parsed), true);
  assert.equal(parsed.lcp! > CWV_POOR.lcpMs, true);
  assert.equal(parsed.inp! > CWV_POOR.inpMs, true);
  assert.equal(parsed.cls! > CWV_POOR.cls, true);
});

test("parses lab-only responses (no loadingExperience.metrics) with INP staying null", () => {
  const data = JSON.parse(readFileSync(fixturePath, "utf8"));
  const labOnly = { ...data, loadingExperience: { metrics: {} } };
  const parsed = parsePsiResponse(labOnly);
  assert.equal(parsed.source, "lab");
  assert.equal(parsed.lcp, 4103);          // lab largest-contentful-paint, ms
  assert.equal(parsed.cls, 0.278);         // lab CLS is unitless already
  assert.equal(parsed.inp, null);          // lab INP is not comparable field data
  assert.equal(parsed.score, 62);
  // Lab verdicts judge LCP and CLS only — 4.1 s LCP alone is poor.
  assert.equal(isCwvPoor(parsed), true);
});

test("a healthy lab page is not poor, and empty input yields all-null metrics", () => {
  const good = parsePsiResponse({
    lighthouseResult: {
      categories: { performance: { score: 0.95 } },
      audits: { "largest-contentful-paint": { numericValue: 1800 }, "cumulative-layout-shift": { numericValue: 0.05 } },
    },
  });
  assert.equal(isCwvPoor(good), false);
  assert.deepEqual(
    { ...parsePsiResponse({}), source: null },
    { source: null, lcp: null, inp: null, cls: null, ttfb: null, score: null },
  );
});

test("sampling: home first, one page per ≥3-page template by inbound links, capped at 5", () => {
  const page = (url: string, depth: number, links: number, extra: Partial<Parameters<typeof pickPsiSample>[0][number]> = {}) => ({
    url, depth, httpStatus: 200, hasHtml: true, noindex: false, internalInboundLinks: links, ...extra,
  });
  const crawled = [
    page("https://example.com/", 0, 100),
    // /blog/ template: 3 pages — representative is the most-linked one.
    page("https://example.com/blog/a", 1, 1),
    page("https://example.com/blog/b", 1, 9),
    page("https://example.com/blog/c", 1, 3),
    // /en/ template: 3 pages.
    page("https://example.com/en/a", 1, 2),
    page("https://example.com/en/b", 1, 7),
    page("https://example.com/en/c", 1, 5),
    // /shop/ template: only 2 pages — below the threshold, never sampled.
    page("https://example.com/shop/a", 1, 50),
    page("https://example.com/shop/b", 1, 40),
    // Flat top-level pages: single-segment paths form no template.
    page("https://example.com/about", 1, 30),
    page("https://example.com/contact", 1, 20),
  ];
  const sample = pickPsiSample(crawled);
  assert.equal(sample.length, 3);
  assert.equal(sample[0], "https://example.com/");            // home first
  assert.equal(sample.includes("https://example.com/blog/b"), true);
  assert.equal(sample.includes("https://example.com/en/b"), true);
  assert.equal(sample.includes("https://example.com/shop/a"), false);
  assert.equal(sample.includes("https://example.com/about"), false);

  // With six qualifying templates the cap holds: home + 4 templates.
  const many = [
    page("https://example.com/", 0, 0),
    ...["a", "b", "c", "d", "e", "f"].map(seg => [
      page(`https://example.com/${seg}/1`, 1, 1),
      page(`https://example.com/${seg}/2`, 1, 2),
      page(`https://example.com/${seg}/3`, 1, 3),
    ]).flat(),
  ];
  assert.equal(pickPsiSample(many).length, PSI_SAMPLE_MAX);

  // Only 200 + non-noindex + fetched-HTML pages qualify: redirects, noindex and failures never sample.
  const dirty = pickPsiSample([
    page("https://example.com/", 0, 10),
    page("https://example.com/r/", 1, 9, { httpStatus: 301 }),
    page("https://example.com/n/", 1, 9, { noindex: true }),
    page("https://example.com/h/", 1, 9, { hasHtml: false }),
  ]);
  assert.deepEqual(dirty, ["https://example.com/"]);
});
