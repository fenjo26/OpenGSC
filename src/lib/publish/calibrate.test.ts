import test from "node:test";
import assert from "node:assert/strict";
import { samplePairs, percentile, summarize, historyBuckets, topicKeyOf, generateRespinPairs, MAX_RESPIN_CALLS } from "./calibrate";
import { textSimilarity } from "@/lib/seo/textSimilarity";

// The calibration tool's PURE half: sampling, percentiles and bucket assignment — the parts
// that decide which pairs get measured. The DB/AI half is covered by the run itself (its
// output is pasted into gate.ts's threshold comment), so these tests pin the math the numbers
// rest on. No network, no credits, no database.

const A = (id: string, keyword: string, markdown: string) => ({ id, keyword, title: id, markdown });

test("samplePairs enumerates all pairs below the cap and is deterministic above it", () => {
  assert.deepEqual(samplePairs(0), []);
  assert.deepEqual(samplePairs(1), []);
  assert.equal(samplePairs(4).length, 6); // 4·3/2
  assert.deepEqual(samplePairs(3), [[0, 1], [0, 2], [1, 2]]);
  // Above the cap the sample is seeded: same seed → same pairs, all distinct, exactly cap of them.
  const a = samplePairs(200, 50, 7);
  const b = samplePairs(200, 50, 7);
  assert.equal(a.length, 50);
  assert.deepEqual(a, b);
  const keys = new Set(a.map(([i, j]) => `${i}:${j}`));
  assert.equal(keys.size, 50, "no duplicate pairs");
  for (const [i, j] of a) assert.ok(i < j, "ordered pairs");
});

test("percentile interpolates linearly and summarize matches the numpy convention", () => {
  assert.ok(Number.isNaN(percentile([], 50)));
  assert.equal(percentile([5], 50), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5); // (0.5·3)=1.5 → between 2 and 3
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 100), 4);
  const s = summarize([1, 2, 3, 4, 5]);
  assert.equal(s.n, 5);
  assert.equal(s.min, 1);
  assert.equal(s.max, 5);
  assert.equal(s.median, 3);
});

test("topicKeyOf folds case and whitespace so 'Casino Bonus ' and 'casino bonus' are one topic", () => {
  assert.equal(topicKeyOf("  Casino Bonus "), topicKeyOf("casino bonus"));
  assert.equal(topicKeyOf(""), "");
});

test("historyBuckets: same-keyword articles pair together, different keywords pair apart", () => {
  const articles = [
    A("a1", "casino bonus", "# Casino bonus guide\n\nOne two three four five six seven eight."),
    A("a2", "casino bonus", "# Casino bonus guide 2026\n\nCompletely different wording here, nothing shared at all."),
    A("b1", "airport transfer", "# Airport transfer\n\nThessaloniki taxi rates and meeting points at SKG."),
  ];
  const buckets = historyBuckets(articles);
  const same = buckets.find(b => b.name === "same-topic")!;
  const different = buckets.find(b => b.name === "different-topic")!;
  assert.equal(same.values.length, 1, "the one same-keyword pair");
  assert.equal(different.values.length, 2, "a1–b1 and a2–b1");
  // The measured value IS the engine's value — the calibration never re-implements similarity.
  assert.equal(same.values[0], textSimilarity(articles[0].markdown, articles[1].markdown));
  assert.ok(different.values.every(v => v < same.values[0] + 1));
});

test("historyBuckets: identical texts across topics land only in different-topic at similarity 1", () => {
  const body = "# Same\n\nIdentical body across two different keywords measures exactly 1.";
  const buckets = historyBuckets([A("x", "kw one", body), A("y", "kw two", body)]);
  assert.equal(buckets.find(b => b.name === "different-topic")!.values[0], 1);
  assert.equal(buckets.find(b => b.name === "same-topic")!.values.length, 0);
});

test("generateRespinPairs caps attempts and reports provider errors without throwing", async () => {
  const articles = Array.from({ length: 8 }, (_, i) => A(`a${i}`, `kw${i}`, `# T${i}\n\n` + "word ".repeat(200 + i)));
  let calls = 0;
  const stub = async () => {
    calls++;
    if (calls === 1) throw new Error("provider exploded");
    return { title: "adapted", body: "# adapted\n\n" + "other ".repeat(150) };
  };
  const out = await generateRespinPairs(articles, { aiProvider: "x", aiApiKey: "k" }, stub);
  assert.equal(calls, MAX_RESPIN_CALLS, "hard ceiling of 5 AI calls");
  assert.equal(out.callsSpent, MAX_RESPIN_CALLS);
  assert.equal(out.values.length, MAX_RESPIN_CALLS - 1, "one call errored");
  assert.equal(out.errors.length, 1);
  // The measured value is again the engine's, original vs adaptation.
  assert.equal(out.values[0], textSimilarity(articles[0].markdown, "# adapted\n\n" + "other ".repeat(150)));
});
