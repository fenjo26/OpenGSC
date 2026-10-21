// Unit tests for the pure batch-planning helpers — the policy that decides
// what a batch order means (dedupe, dependency wiring, secret stripping,
// estimates, settings bounds) lives in plain functions precisely so it can be
// pinned here without a database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planBatch, stripSecrets, estimateBatchCalls, normalizeKeyword, ESTIMATED_CALLS } from "./plan";
import { parseGenQueueSettings, DEFAULT_GEN_QUEUE_SETTINGS } from "./settings";

let seq = 0;
const newId = () => `id-${++seq}`;

test("planBatch: outline_text wires every text item to its outline item", () => {
  const plan = planBatch({ name: "b", pipeline: "outline_text", items: [{ keyword: "best casino" }] }, newId);
  assert.equal(plan.items.length, 2);
  const [outline, text] = plan.items;
  assert.equal(outline.phase, "outline");
  assert.equal(text.phase, "text");
  assert.equal(text.dependsOnItemId, outline.id);
  assert.equal(text.keyword, outline.keyword);
});

test("planBatch: outline-only pipeline creates no text items", () => {
  const plan = planBatch({ name: "b", pipeline: "outline", items: [{ keyword: "a" }, { keyword: "b" }] }, newId);
  assert.equal(plan.items.length, 2);
  assert.ok(plan.items.every(i => i.phase === "outline" && !i.dependsOnItemId));
});

test("planBatch: exact duplicates (keyword + market) are dropped and reported", () => {
  const plan = planBatch({
    name: "b", pipeline: "outline",
    items: [
      { keyword: "best casino" },
      { keyword: "  best   casino " },            // same after normalization
      { keyword: "best casino", payload: { country: "de" } }, // different market — kept
      { keyword: "best casino", payload: { tone: "dry" } },    // same market, tone differs — duplicate
    ],
  }, newId);
  assert.equal(plan.items.length, 2);
  assert.deepEqual(plan.skippedDuplicates, ["best casino", "best casino"]);
});

test("planBatch: defaults merge under per-item overrides", () => {
  const plan = planBatch({
    name: "b", pipeline: "outline",
    defaults: { country: "us", language: "en", tone: "warm" },
    items: [{ keyword: "k", payload: { tone: "dry" } }],
  }, newId);
  const knobs = JSON.parse(plan.items[0].payload!);
  assert.equal(knobs.country, "us");
  assert.equal(knobs.language, "en");
  assert.equal(knobs.tone, "dry"); // the item wins
});

test("planBatch: empty and blank keywords are dropped, empty batch throws upstream", () => {
  const plan = planBatch({ name: "b", pipeline: "outline", items: [{ keyword: "   " }, { keyword: "" }, { keyword: "ok" }] }, newId);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].keyword, "ok");
});

test("planBatch: priority is clamped to -100..100 and inherited by the text item", () => {
  const plan = planBatch({
    name: "b", pipeline: "outline_text",
    items: [{ keyword: "k", priority: 999 }, { keyword: "k2", priority: -999 }],
  }, newId);
  assert.equal(plan.items.find(i => i.phase === "outline" && i.keyword === "k")!.priority, 100);
  assert.equal(plan.items.find(i => i.phase === "text" && i.keyword === "k")!.priority, 100);
  assert.equal(plan.items.find(i => i.phase === "outline" && i.keyword === "k2")!.priority, -100);
});

test("planBatch: pauseAfterErrors is clamped, default 5", () => {
  assert.equal(planBatch({ name: "b", pipeline: "outline", items: [{ keyword: "k" }] }, newId).pauseAfterErrors, 5);
  assert.equal(planBatch({ name: "b", pipeline: "outline", items: [{ keyword: "k" }], pauseAfterErrors: -3 }, newId).pauseAfterErrors, 0);
  assert.equal(planBatch({ name: "b", pipeline: "outline", items: [{ keyword: "k" }], pauseAfterErrors: 1000 }, newId).pauseAfterErrors, 100);
});

test("stripSecrets: credential-shaped keys never persist, knobs survive", () => {
  const out = stripSecrets({
    aiApiKey: "sk-1", serpKey: "k", judgeApiKey: "k", aiFallbacks: [], token: "t", password: "p",
    keyword: "k", country: "us", custom: "instruction",
  });
  assert.deepEqual(Object.keys(out).sort(), ["country", "custom", "keyword"]);
});

test("estimateBatchCalls: outline + text per page", () => {
  assert.equal(estimateBatchCalls("outline", 10), ESTIMATED_CALLS.outline * 10);
  assert.equal(estimateBatchCalls("outline_text", 10), (ESTIMATED_CALLS.outline + ESTIMATED_CALLS.text) * 10);
});

test("normalizeKeyword collapses whitespace and caps length", () => {
  assert.equal(normalizeKeyword("  best    casino \n bonus "), "best casino bonus");
  assert.equal(normalizeKeyword("x".repeat(400)).length, 300);
});

test("parseGenQueueSettings: defaults on garbage, bounds on extremes", () => {
  assert.deepEqual(parseGenQueueSettings(null), DEFAULT_GEN_QUEUE_SETTINGS);
  assert.deepEqual(parseGenQueueSettings("not json"), DEFAULT_GEN_QUEUE_SETTINGS);
  const s = parseGenQueueSettings(JSON.stringify({ concurrency: 99, providerConcurrency: -5, retryAttempts: 99, retryDelayMin: 0, paused: "yes" }));
  assert.equal(s.concurrency, 16);      // clamped high
  assert.equal(s.providerConcurrency, 0); // clamped low → gate off, not negative
  assert.equal(s.retryAttempts, 5);
  assert.equal(s.retryDelayMin, 1);
  assert.equal(s.paused, false);        // only literal true pauses
});
