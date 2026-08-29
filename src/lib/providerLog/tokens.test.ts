import { test } from "node:test";
import assert from "node:assert/strict";
import { usageFrom } from "./tokens";

test("anthropic reports input and output tokens", () => {
  assert.deepEqual(usageFrom("anthropic", { usage: { input_tokens: 10, output_tokens: 20 } }),
    { promptTokens: 10, completionTokens: 20, costUsd: null });
});

test("the openai family reports prompt and completion tokens", () => {
  for (const p of ["openai", "deepseek", "qwen", "zai", "kimi", "cheaperinference", "custom"]) {
    assert.deepEqual(usageFrom(p, { usage: { prompt_tokens: 1, completion_tokens: 2 } }),
      { promptTokens: 1, completionTokens: 2, costUsd: null }, p);
  }
});

test("gemini spells it differently", () => {
  assert.deepEqual(usageFrom("gemini", { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6 } }),
    { promptTokens: 5, completionTokens: 6, costUsd: null });
});

test("kie uses the Responses shape", () => {
  assert.deepEqual(usageFrom("kie", { usage: { input_tokens: 3, output_tokens: 4 } }),
    { promptTokens: 3, completionTokens: 4, costUsd: null });
});

test("openrouter states a cost, and that is the only cost we ever record", () => {
  // Every other provider leaves costUsd null. It is never derived from tokens and a price
  // table, because a stale table shows a wrong number that looks exactly like a right one.
  assert.deepEqual(usageFrom("openrouter", { usage: { prompt_tokens: 7, completion_tokens: 8, cost: 0.0012 } }),
    { promptTokens: 7, completionTokens: 8, costUsd: 0.0012 });
});

test("a response with no usage block yields nulls, not zeros", () => {
  // Zero tokens is a measurement and a false one. Absent is absent.
  assert.deepEqual(usageFrom("openai", { choices: [] }),
    { promptTokens: null, completionTokens: null, costUsd: null });
  assert.deepEqual(usageFrom("openai", null),
    { promptTokens: null, completionTokens: null, costUsd: null });
});

test("an unknown provider does not throw", () => {
  assert.deepEqual(usageFrom("something-new", { usage: { prompt_tokens: 1 } }).completionTokens, null);
});
