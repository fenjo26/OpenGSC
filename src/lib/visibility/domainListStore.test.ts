// R+, Wave A — sanitization rules of the aeo_domain_lists store. The DB read/write functions
// are one upsert/findUnique over InstanceSetting and are covered by the route being exercised;
// what is worth pinning is the CONTRACT between what the UI sends and what the classifier will
// actually consult: malformed entries must be normalized or silently stripped here, never
// trusted into the overlay (a "*.gr" that slips through would re-tag half a market).
import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeDomainLists } from "./domainListStore";
import { OVERLAY_CATEGORIES } from "@/lib/seo/aeoCitationClassify";

test("sanitizeDomainLists: entries normalized (scheme/www/path/case), invalid dropped, deduped", () => {
  const clean = sanitizeDomainLists({
    forum: ["https://www.GreekForum.gr/thread/1", "greekforum.gr", "", "*.gr", "justtext"],
    editorial: ["kathimerini.gr"],
  });
  assert.deepEqual(clean, { forum: ["greekforum.gr"], editorial: ["kathimerini.gr"] });
});

test("sanitizeDomainLists: unknown categories and non-array values ignored, empty categories omitted", () => {
  const clean = sanitizeDomainLists({
    brand: ["oursite.gr"],        // contextual category — not overlayable by design
    competitor: ["rival.gr"],     // ditto
    other: ["whatever.gr"],       // fallthrough — not overlayable either
    nonsense: ["x.gr"],           // not a category at all
    forum: "not-an-array",
    reviews: [],
    reference: ["sansimera.gr"],
  });
  assert.deepEqual(clean, { reference: ["sansimera.gr"] });
});

test("sanitizeDomainLists: garbage input shapes read as 'no overlay', never throw", () => {
  assert.deepEqual(sanitizeDomainLists(null), {});
  assert.deepEqual(sanitizeDomainLists(undefined), {});
  assert.deepEqual(sanitizeDomainLists("forum"), {});
  assert.deepEqual(sanitizeDomainLists(42), {});
  assert.deepEqual(sanitizeDomainLists(["a.gr"]), {});
});

test("sanitizeDomainLists: capped per category — curation, not scraping", () => {
  const many = Array.from({ length: 300 }, (_, i) => `host${i}.example`);
  const clean = sanitizeDomainLists({ forum: many });
  assert.equal(clean.forum?.length, 100);
  assert.equal(clean.forum?.[0], "host0.example");
  assert.equal(clean.forum?.[99], "host99.example");
});

test("sanitizeDomainLists: every overlay category survives a round trip", () => {
  const raw = Object.fromEntries(OVERLAY_CATEGORIES.map(c => [c, [`${c}.example.gr`]]));
  const clean = sanitizeDomainLists(raw);
  assert.deepEqual(Object.keys(clean).sort(), [...OVERLAY_CATEGORIES].sort());
  for (const c of OVERLAY_CATEGORIES) assert.deepEqual(clean[c], [`${c}.example.gr`]);
});
