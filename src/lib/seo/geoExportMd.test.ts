import test from "node:test";
import assert from "node:assert/strict";
import { buildGeoMarkdown } from "./geoExportMd";
import type { GeoReport } from "./geo";

// Minimal valid report — every required field of the GeoReport shape, empty where the audit
// found nothing, so both the "bare" and the "full" variants branch off the same base.
const base: GeoReport = {
  query: "best crypto casino no kyc",
  language: "en",
  country: "us",
  model: "gpt-5-5",
  createdAt: Date.parse("2026-08-30T12:00:00Z"),
  classification: { intent: "Commercial", intentConfidence: 0.9, stage: "Decision", topic: "crypto_casino" },
  metrics: {
    searchBatches: 3, uniqueQueries: 4, pagesOpened: 2, sourcesScanned: 18, uniqueDomains: 11,
    citations: 7, scannedToCitedPct: 39, top3ConcentrationPct: 57,
    dominantType: { type: "listicle_editorial", label: "Listicle / editorial", pct: 43 },
  },
  batches: [],
  openPages: [],
  brands: [{
    rank: 1, name: "BrandOne", domain: "brandone.com", dominant: true, mentions: 2, score: 2.5,
    tags: ["no kyc", "fast payout"], pricing: "2x rakeback", support: "24/7 chat", featureBreadth: "wide",
    surfacedIn: [1], totalQueries: 4,
  }],
  selectionFactors: [],
  keyEntities: [{ category: "Concepts", items: [{ name: "VPN friendly", count: 3, brands: ["BrandOne"] }] }],
  sourceTypes: [{ type: "listicle_editorial", label: "Listicle / editorial", pct: 43, cites: 3, domains: 4 }],
  trustSignals: [],
  inclusion: { stability: "high confidence", topCount: 1, signals: [] },
  coverageGaps: { missingFactors: ["withdrawal limits"], missingEntities: [], missingSourceTypes: [] },
  insights: {
    userSearchBehavior: "b", dominantSource: "d",
    strategicEngagement: "s", opportunityGaps: "o",
  },
  answer: {
    text: "Line one.\nLine two.",
    chars: 19,
    citations: [{ n: 1, domain: "brandone.com", url: "https://brandone.com/x", title: "BrandOne review" }],
  },
};

test("markdown carries the header, metrics, brands and citations", () => {
  const md = buildGeoMarkdown(base);
  assert.match(md, /# GEO Audit: best crypto casino no kyc/);
  assert.match(md, /- Model: gpt-5-5/);
  assert.match(md, /\| Citations \| 7 \(39% of scanned\) \|/);
  assert.match(md, /\| 1 \| BrandOne \| brandone\.com \|/);
  assert.match(md, /\[BrandOne review\]\(https:\/\/brandone\.com\/x\)/);
  // Blockquoted answer keeps its line breaks.
  assert.match(md, /> Line one\.\n> Line two\./);
});

test("yourPage section appears only when a page verdict exists", () => {
  const withPage: GeoReport = {
    ...base,
    pageUrl: "https://mysite.com/no-kyc",
    yourPage: {
      cited: false,
      citedCompetitors: ["rival1.com", "rival2.org"],
      gaps: ["No payout-speed table"],
      fixes: ["Add a comparison table with withdrawal limits"],
      summary: "Thin page relative to the cited listicles.",
    },
  };
  const md = buildGeoMarkdown(withPage);
  assert.match(md, /## Your page/);
  assert.match(md, /\*\*Not cited in this answer\.\*\* Thin page relative to the cited listicles\./);
  assert.match(md, /- No payout-speed table/);
  assert.match(md, /Competitors cited instead: rival1\.com, rival2\.org/);

  // Without a verdict there is no section at all — not an empty one.
  assert.doesNotMatch(buildGeoMarkdown(base), /## Your page/);

  // A pageUrl whose fetch failed says so instead of going silent.
  const unfetchable: GeoReport = { ...base, pageUrl: "https://mysite.com/no-kyc" };
  assert.match(buildGeoMarkdown(unfetchable), /could not be fetched/);
});
