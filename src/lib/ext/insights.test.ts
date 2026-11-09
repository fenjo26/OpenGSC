import assert from "node:assert/strict";
import test from "node:test";
import { pickMainQuery, footprintHits } from "./insights";
import { similarGroups, skeletonOf, MIN_SKELETON_WORDS, SIMILARITY_THRESHOLD, type FootprintItem } from "@/lib/footprint";

// ─── pickMainQuery ─────────────────────────────────────────────────────────────────

test("pickMainQuery: empty input → null", () => {
  assert.equal(pickMainQuery([]), null);
  assert.equal(pickMainQuery([{ query: "", clicks: 5, impressions: 5, position: 1 }]), null);
});

test("pickMainQuery: more clicks wins", () => {
  const out = pickMainQuery([
    { query: "a", clicks: 1, impressions: 900, position: 1 },
    { query: "b", clicks: 9, impressions: 10, position: 8 },
  ]);
  assert.equal(out?.query, "b");
});

test("pickMainQuery: clicks tie → impressions; both tie → lower position; all tie → alphabetical", () => {
  assert.equal(pickMainQuery([
    { query: "b", clicks: 5, impressions: 10, position: 3 },
    { query: "a", clicks: 5, impressions: 99, position: 9 },
  ])?.query, "a");

  assert.equal(pickMainQuery([
    { query: "far", clicks: 5, impressions: 10, position: 9 },
    { query: "near", clicks: 5, impressions: 10, position: 2 },
  ])?.query, "near");

  assert.equal(pickMainQuery([
    { query: "zzz", clicks: 5, impressions: 10, position: 2 },
    { query: "aaa", clicks: 5, impressions: 10, position: 2 },
  ])?.query, "aaa");
});

// ─── footprintHits ─────────────────────────────────────────────────────────────────

const ENTITIES = ["example"];

function item(skeleton: string, identity: string, label = identity, kind: FootprintItem["kind"] = "title"): FootprintItem {
  return { skeleton, kind, source: "published", identity, label, example: `https://${label}/page` };
}

function pageOf(title: string, siteId = "site-1") {
  return { siteId, url: "https://example.com/p", title, description: "", h1: "", entities: ENTITIES };
}

test("footprintHits: the page's own site identity is never a match", () => {
  const skeleton = skeletonOf("Example transfers from Athens to Thessaloniki in {n} hours", ENTITIES);
  const hits = footprintHits(pageOf("Example transfers from Athens to Thessaloniki in 4 hours"), [
    item(skeleton, "site-1", "example.com"),
  ]);
  assert.equal(hits.length, 0);
});

test("footprintHits: the same skeleton on another site is an exact 1.0 match", () => {
  const hits = footprintHits(pageOf("Example transfers from Athens to Thessaloniki in 4 hours"), [
    item(skeletonOf("Example transfers from Athens to Thessaloniki in {n} hours", ENTITIES), "site-2", "other.gr"),
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "title");
  assert.equal(hits[0].matches.length, 1);
  assert.equal(hits[0].matches[0].similarity, 1);
  assert.equal(hits[0].matches[0].siteLabel, "other.gr");
});

test("footprintHits: skeletons shorter than MIN_SKELETON_WORDS are skipped", () => {
  const shortTitle = "Example home page"; // skeleton ≈ "{x} home page" → 3 words < 4
  const hits = footprintHits(pageOf(shortTitle), [
    item(skeletonOf("{x} home page", ENTITIES), "site-2", "other.gr"),
  ]);
  assert.equal(hits.length, 0);
  assert.ok(skeletonOf(shortTitle, ENTITIES).split(/\s+/).length < MIN_SKELETON_WORDS + 1);
});

test("footprintHits: near-duplicates above the threshold match, below it do not", () => {
  const page = pageOf("Example airport taxi transfers Athens guide and prices list for every traveler in 2026");
  const close = skeletonOf("Example airport taxi transfers Athens guide and costs list for every traveler in 2026", ENTITIES);
  const far = skeletonOf("Example casino review best bonus guide for players online", ENTITIES);
  const hits = footprintHits(page, [item(close, "site-2", "close.gr"), item(far, "site-3", "far.gr")]);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].matches[0].similarity >= SIMILARITY_THRESHOLD);
  assert.equal(hits[0].matches[0].siteLabel, "close.gr");
});

test("footprintHits: generated-history rows are candidates (their identity is a keyword)", () => {
  const skeleton = skeletonOf("Example transfers from Athens to Thessaloniki in {n} hours", ENTITIES);
  const generated: FootprintItem = {
    skeleton, kind: "title", source: "generated",
    identity: "athens thessaloniki transfer", label: "athens thessaloniki transfer",
    example: "history:1",
  };
  const hits = footprintHits(pageOf("Example transfers from Athens to Thessaloniki in 4 hours"), [generated]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].matches[0].siteLabel, "athens thessaloniki transfer");
});

test("footprintHits: at most 5 matches per kind, sorted by similarity", () => {
  const skeleton = skeletonOf("Example transfers from Athens to Thessaloniki in {n} hours", ENTITIES);
  const items: FootprintItem[] = [];
  for (let i = 0; i < 8; i++) {
    items.push(item(skeleton, `site-${i + 2}`, `site${i}.gr`));
  }
  const hits = footprintHits(pageOf("Example transfers from Athens to Thessaloniki in 4 hours"), items);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].matches.length, 5);
});

test("footprintHits: kinds are independent — a description match does not need a title match", () => {
  const hits = footprintHits(
    { ...pageOf("Unique title nothing like anything"), description: "Example full guide with prices and hours inside" },
    [
      {
        skeleton: skeletonOf("Example full guide with prices and hours inside", ENTITIES),
        kind: "description", source: "published", identity: "site-2", label: "other.gr", example: "https://other.gr/p",
      },
    ],
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "description");
});

// ─── the copied jaccard agrees with similarGroups' clustering ──────────────────────

test("the copied similarity finds exactly the pairs similarGroups clusters together", () => {
  const base = "example airport shuttle taxi transfers athens guide prices hours list booking in greece";
  const near = "example airport shuttle taxi transfers athens guide prices hours table booking in greece";
  const different = "example casino online review bonus free spins wagering";
  const mk = (text: string, identity: string): FootprintItem => ({
    skeleton: text, kind: "title", source: "published", identity, label: identity, example: `https://${identity}/`,
  });
  const items = [mk(base, "a.com"), mk(near, "b.com"), mk(different, "c.com")];

  // similarGroups: base+near form one cluster; different stands alone.
  const clusters = similarGroups(items);
  const clusterWith = clusters.find(c => c.skeletons.includes(base));
  assert.ok(clusterWith, "similarGroups clusters base with near");
  assert.ok(clusterWith!.skeletons.includes(near));
  assert.equal(clusterWith!.skeletons.includes(different), false);

  // my copy: the page carrying `base` matches `near` (and not `different`).
  const page = { siteId: "site-1", url: "https://example.com/", title: "", description: "", h1: "", entities: [] };
  const baseItem = items[0];
  const hits = footprintHits({ ...page, title: baseItem.skeleton }, items.slice(1));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].matches.length, 1);
  assert.equal(hits[0].matches[0].siteLabel, "b.com");
});
