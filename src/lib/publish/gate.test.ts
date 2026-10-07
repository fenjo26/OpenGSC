import test from "node:test";
import assert from "node:assert/strict";
import { uniquenessVerdict, levelFor, blockedError, UNIQUENESS_BLOCK_THRESHOLD, UNIQUENESS_WARN_THRESHOLD } from "./gate";
import { textSimilarity } from "@/lib/seo/textSimilarity";

// The gate's math is the analyze_text engine's math — these tests pin that equivalence, the
// threshold bands, and the honest edges (empty comparison set, identical text, the twin being
// NAMED in the block error). No database: the verdict function takes the comparison set in.

const ORIGINAL = "# Casino review\n\n" + ("The golden crown casino offers a welcome package with two hundred free spins. " +
  "Wagering is thirty five times and the minimum deposit is twenty euros. ").repeat(12);

test("an empty comparison set lets the first post through with score 1", () => {
  const v = uniquenessVerdict(ORIGINAL, []);
  assert.equal(v.level, "ok");
  assert.equal(v.uniquenessScore, 1);
  assert.equal(v.maxSimilarity, 0);
  assert.equal(v.twinPostId, null);
});

test("a respin-level twin is blocked and the error names the twin post and the number", () => {
  // Same text with a few words respun — comfortably above the block threshold.
  const twinBody = ORIGINAL.replace(/welcome package/g, "greeting bundle").replace(/two hundred/g, "200");
  const v = uniquenessVerdict(ORIGINAL, [{ id: "post_123", title: "Casino review twin", markdown: twinBody }]);
  assert.equal(v.level, "blocked");
  assert.ok(v.maxSimilarity >= UNIQUENESS_BLOCK_THRESHOLD, `measured ${v.maxSimilarity}`);
  assert.equal(v.twinPostId, "post_123");
  assert.equal(v.twinTitle, "Casino review twin");
  assert.ok(Math.abs(v.uniquenessScore - (1 - v.maxSimilarity)) < 1e-12);
  const err = blockedError(v);
  assert.ok(err.includes("uniqueness_blocked"), err);
  assert.ok(err.includes("post_123"), "names the twin post id");
  assert.ok(err.includes("no override"), "says there is no override");
});

test("an identical text measures exactly 1 (the engine's normalized-equality shortcut)", () => {
  const v = uniquenessVerdict(ORIGINAL, [{ id: "p", title: "t", markdown: ORIGINAL + "\n" }]);
  assert.equal(v.maxSimilarity, 1);
  assert.equal(v.level, "blocked");
});

test("an unrelated text on a different topic stays ok, and the verdict equals textSimilarity's own number", () => {
  const other = "# Airport transfer Thessaloniki\n\n" + ("The driver waits at arrivals with a name board and the fixed rate covers luggage. ").repeat(15);
  const v = uniquenessVerdict(ORIGINAL, [{ id: "p2", title: "transfer", markdown: other }]);
  assert.equal(v.maxSimilarity, textSimilarity(ORIGINAL, other));
  assert.equal(v.level, "ok");
  assert.ok(v.uniquenessScore > 1 - UNIQUENESS_WARN_THRESHOLD);
});

test("levelFor applies the calibrated bands: ok below warn, warn in between, blocked at and above block", () => {
  assert.equal(levelFor(0), "ok");
  assert.equal(levelFor(UNIQUENESS_WARN_THRESHOLD - 0.001), "ok");
  assert.equal(levelFor(UNIQUENESS_WARN_THRESHOLD), "warn");
  assert.equal(levelFor(UNIQUENESS_BLOCK_THRESHOLD - 0.001), "warn");
  assert.equal(levelFor(UNIQUENESS_BLOCK_THRESHOLD), "blocked");
  assert.equal(levelFor(1), "blocked");
});

test("the verdict picks the WORST twin, not the first or the average", () => {
  const weakTwin = { id: "weak", title: "unrelated", markdown: "# Penguins\n\n" + "Antarctic colonies and krill. ".repeat(60) };
  const strongTwin = { id: "strong", title: "near copy", markdown: ORIGINAL.replace("golden", "golden ") };
  const v = uniquenessVerdict(ORIGINAL, [weakTwin, strongTwin]);
  assert.equal(v.twinPostId, "strong");
  assert.ok(v.maxSimilarity > 0.9);
});
