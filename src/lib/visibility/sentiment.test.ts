// N7 — sentiment pass: fragment selection, reply parsing, price estimate. Pure functions;
// the one thing that touches the network (askSentiment → fetchLLM) is deliberately not tested
// here — its behaviour IS parseSentimentReply plus the provider module's own retry ladder.

import test from "node:test";
import assert from "node:assert/strict";

import {
  splitSentences, sentimentFragments, parseSentimentVerdict, parseSentimentReply,
  estimateSentimentTokens, SENTIMENT_PER_ANSWER_TOKENS,
} from "./sentiment";

// ─── splitSentences ───────────────────────────────────────────────────────────

test("splitSentences: Latin, ellipsis, newlines, Greek and CJK terminals", () => {
  assert.deepEqual(splitSentences("One. Two! Three?"), ["One.", "Two!", "Three?"]);
  assert.deepEqual(splitSentences("Wait… really?"), ["Wait…", "really?"]);
  assert.deepEqual(splitSentences("line one\nline two\n\nline three"), ["line one", "line two", "line three"]);
  assert.deepEqual(splitSentences("Καλημέρα. Τι κάνεις;"), ["Καλημέρα.", "Τι κάνεις;"]); // Greek ; is not terminal
  assert.deepEqual(splitSentences("好的。谢谢！"), ["好的。", "谢谢！"]);
  assert.deepEqual(splitSentences(""), []);
});

// ─── sentimentFragments ───────────────────────────────────────────────────────

test("sentimentFragments: ±2 sentences around each mention, gap kept as …", () => {
  const text = [
    "S0 intro.", "S1 setup.", "S2 Acme appears here.", "S3 after.", "S4 filler.", "S5 filler.",
    "S6 filler.", "S7 unrelated.", "S8 Acme again.", "S9 tail.",
  ].join(" ");
  const f = sentimentFragments(text, ["Acme"]);
  // Window 1: S0..S4 (mention at 2, ±2). Window 2: S6..S9? mention at 8 → S6..S10 → S6..S9.
  assert.ok(f.includes("S0 intro."));
  assert.ok(f.includes("S4 filler."));
  assert.ok(f.includes(" … ")); // the gap between windows is explicit
  assert.ok(f.includes("S8 Acme again."));
  assert.ok(f.includes("S9 tail."));
  assert.ok(!f.includes("S5 filler.")); // outside both windows — cut, not glued in
});

test("sentimentFragments: adjacent mentions merge into one window (no duplicated overlap)", () => {
  const text = "A one. B two. C Acme. D Acme again. E five. F six.";
  const f = sentimentFragments(text, ["Acme"]);
  assert.ok(f.includes("A one."));
  assert.ok(f.includes("F six."));
  assert.equal(f.split(" … ").length, 1); // merged, single window
});

test("sentimentFragments: character cap cuts the end, keeps the ellipsis marker", () => {
  const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} mentions Acme.`).join(" ");
  const f = sentimentFragments(sentences, ["Acme"], { maxChars: 400 });
  assert.ok(f.length <= 400);
  assert.ok(f.endsWith("…"));
  assert.ok(f.startsWith("Sentence number 0")); // earliest fragments survive the cap
});

test("sentimentFragments: no mention → empty string (nothing to analyse, nothing to spend)", () => {
  assert.equal(sentimentFragments("Nothing branded here.", ["Acme"]), "");
  assert.equal(sentimentFragments("Acmeville is a different brand.", ["Acme"]), ""); // word boundary
  assert.equal(sentimentFragments("", ["Acme"]), "");
});

test("sentimentFragments: mention detection folds case and diacritics", () => {
  assert.notEqual(sentimentFragments("Лучший CAFé в городе.", ["cafe"]), "");
  assert.notEqual(sentimentFragments("ёжики повсюду", ["Ежики"]), "");
});

// ─── parseSentimentVerdict ────────────────────────────────────────────────────

test("parseSentimentVerdict: valid", () => {
  assert.deepEqual(
    parseSentimentVerdict({ sentiment: "positive", score: 0.7, note: "praised as reliable" }),
    { sentiment: "positive", score: 0.7, note: "praised as reliable" },
  );
});

test("parseSentimentVerdict: garbage → null", () => {
  assert.equal(parseSentimentVerdict(null), null);
  assert.equal(parseSentimentVerdict("junk"), null);
  assert.equal(parseSentimentVerdict({ sentiment: "glowing" }), null);   // not in the enum
  assert.equal(parseSentimentVerdict({ score: 0.5 }), null);             // no sentiment at all
  assert.equal(parseSentimentVerdict({ sentiment: "" }), null);
});

test("parseSentimentVerdict: score out of range is clamped, not rejected", () => {
  assert.equal(parseSentimentVerdict({ sentiment: "positive", score: 5 })!.score, 1);
  assert.equal(parseSentimentVerdict({ sentiment: "negative", score: -3 })!.score, -1);
  assert.equal(parseSentimentVerdict({ sentiment: "mixed", score: "0.25" })!.score, 0.25); // numeric string ok
});

test("parseSentimentVerdict: missing/unusable score stays null (null ≠ 0 ≠ neutral)", () => {
  assert.equal(parseSentimentVerdict({ sentiment: "neutral" })!.score, null);
  assert.equal(parseSentimentVerdict({ sentiment: "neutral", score: "" })!.score, null);
  assert.equal(parseSentimentVerdict({ sentiment: "neutral", score: "high" })!.score, null);
});

test("parseSentimentVerdict: note trimmed to 300 chars", () => {
  const v = parseSentimentVerdict({ sentiment: "negative", note: "x".repeat(500) })!;
  assert.equal(v.note.length, 300);
});

// ─── parseSentimentReply (raw model output) ───────────────────────────────────

test("parseSentimentReply: fenced JSON and leading prose survive", () => {
  const raw = "Here is the verdict:\n```json\n{\"sentiment\":\"negative\",\"score\":-0.8,\"note\":\"many complaints\"}\n```";
  const r = parseSentimentReply(raw);
  assert.equal(r!.target!.sentiment, "negative");
  assert.equal(r!.target!.score, -0.8);
});

test("parseSentimentReply: outright garbage → null", () => {
  assert.equal(parseSentimentReply("I cannot judge this."), null);
  assert.equal(parseSentimentReply("{not json at all"), null);
  assert.equal(parseSentimentReply(""), null);
});

test("parseSentimentReply: multi-brand shape", () => {
  const raw = JSON.stringify({
    target: { sentiment: "positive", score: 0.6, note: "recommended" },
    competitors: {
      Acme: { sentiment: "negative", score: -0.5, note: "complaints" },
      Beta: null, // not mentioned in the fragments
    },
  });
  const r = parseSentimentReply(raw, ["Acme", "Beta"])!;
  assert.equal(r.target!.sentiment, "positive");
  assert.equal(r.competitors["Acme"]!.sentiment, "negative");
  assert.equal(r.competitors["Beta"], null);
});

test("parseSentimentReply: flat shape accepted as the target verdict", () => {
  const r = parseSentimentReply('{"sentiment":"neutral","score":0,"note":"bare mention"}');
  assert.equal(r!.target!.sentiment, "neutral");
  assert.deepEqual(r!.competitors, {});
});

// ─── estimate ─────────────────────────────────────────────────────────────────

test("estimateSentimentTokens: one cheap call's budget per answer", () => {
  assert.equal(estimateSentimentTokens(0), 0);
  assert.equal(estimateSentimentTokens(10), 10 * SENTIMENT_PER_ANSWER_TOKENS);
  assert.equal(estimateSentimentTokens(-5), 0);
});
