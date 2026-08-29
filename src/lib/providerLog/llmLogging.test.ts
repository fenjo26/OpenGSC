// The AI path, seen from the log.
//
// Kept out of `llm.test.ts` on purpose: that file is about the retry ladder's own behaviour and
// should stay readable as such. What is asserted here is the one thing the log exists for — that
// every billable request leaves a row, including the ones no single "one call, one row" reading
// of `fetchLLMDetailed` would ever count.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { withCallContext } from "./context";
import { flushProviderLog, __rows, __setWriterForTests } from "./log";
import { fetchLLMDetailed, fetchLLMVision } from "../llm";

function stubFetch(impl: (url: string, init: any) => Promise<Response>) {
  const original = globalThis.fetch;
  const seen: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    return impl(String(url), init);
  }) as any;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

/**
 * Run the retry ladder to a finish on a simulated clock.
 *
 * The ladder's waits are real money on the wall clock — `retryAfterFrom` asks for 15s after any
 * 5xx, the third rung waits 20s, and each carries up to 4s of jitter — and two tests sitting
 * through them cost this suite the better part of a minute, on a gate that runs before every
 * commit. Nothing about the ladder is faked here: `delays`, the 15s floor, the jitter and
 * `attemptCapFor`'s cut to two all still execute, and because only the `setTimeout` API is
 * mocked, `Date.now()` keeps moving for real, so the rows' own `ms` stay honest.
 *
 * The pump is: let everything that can progress without the clock progress (the fetch stub
 * resolves on the microtask queue, `setImmediate` drains the turn behind it), then advance the
 * clock past the longest wait, and repeat until the call settles. The 280s per-attempt abort
 * timer never fires — the whole ladder is under a minute of simulated time.
 */
async function settleOnFakeClock<T>(t: TestContext, start: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let done = false;
  const p = start().then(v => { done = true; return v; }, e => { done = true; throw e; });
  p.catch(() => {}); // the loop does not await p; this only keeps a rejection from looking stray
  for (let i = 0; i < 200 && !done; i++) {
    await new Promise(r => setImmediate(r));
    if (done) break;
    t.mock.timers.tick(30_000);
  }
  return p;
}

test("an AI call is logged with the tokens the provider reported", async () => {
  __setWriterForTests();
  const stub = stubFetch(async () => new Response(JSON.stringify({
    choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 22 },
  }), { status: 200 }));
  try {
    const r = await withCallContext({ userId: "u1", feature: "outline", captureBodies: false }, () =>
      fetchLLMDetailed("p", "openai", "k", 100, "gpt-5-mini"));
    assert.equal(r.text, "hello");
    await flushProviderLog();
    assert.equal(__rows().length, 1);
    const row = __rows()[0];
    assert.equal(row.userId, "u1");
    assert.equal(row.feature, "outline");
    assert.equal(row.provider, "openai");
    assert.equal(row.model, "gpt-5-mini");
    assert.equal(row.endpoint, "https://api.openai.com/v1/chat/completions");
    assert.equal(row.status, 200);
    assert.equal(row.attempt, 1);
    assert.equal(row.promptTokens, 11);
    assert.equal(row.completionTokens, 22);
    // Nothing in this dialect states a price, and nothing here invents one.
    assert.equal(row.costUsd, null);
    assert.equal(row.error, null);
    assert.equal(row.complete, true);
  } finally { stub.restore(); }
});

test("OpenRouter's internal reasoning retry is a SECOND row, not a lost request", async () => {
  // llm.ts:503-514 calls orCall(true) after a 400 that mentions reasoning. Two billable HTTP
  // requests. A tail-of-function logger would have recorded one.
  __setWriterForTests();
  let n = 0;
  const stub = stubFetch(async () => {
    n++;
    return n === 1
      ? new Response(JSON.stringify({ error: { message: "reasoning not supported" } }), { status: 400 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 5, completion_tokens: 6 } }), { status: 200 });
  });
  try {
    await withCallContext({ userId: "u1", feature: "f", captureBodies: false }, () =>
      fetchLLMDetailed("p", "openrouter", "k", 100));
    await flushProviderLog();
    assert.equal(n, 2, "the fixture must actually exercise the inner retry");
    assert.equal(__rows().length, 2);
    assert.deepEqual(__rows().map(r => r.status), [400, 200]);
    assert.equal(__rows()[1].promptTokens, 5);
    // Both requests belong to the same rung of the caller's ladder.
    assert.deepEqual(__rows().map(r => r.attempt), [1, 1]);
    // The rejected request's handle is unreachable the moment `call` points at the retry, so if
    // it is not closed before the reassignment its row sits at complete:false forever — and every
    // other assertion here stays green while it does.
    assert.equal(__rows()[0].complete, true);
    assert.match(__rows()[0].error, /reasoning not supported/);
  } finally { stub.restore(); }
});

test("two fetches inside one ladder rung stay on that rung's attempt number", async (t) => {
  // The case the brief warned about and nothing covered: OpenRouter's inner retry running on
  // every rung. Six requests, three attempts. An implementation numbering raw fetches would say
  // [1,2,3,4,5,6] and claim a ladder twice as long as the one that ran.
  __setWriterForTests();
  let n = 0;
  const stub = stubFetch(async () => {
    n++;
    return n % 2 === 1
      ? new Response(JSON.stringify({ error: { message: "reasoning not supported" } }), { status: 400 })
      : new Response("boom", { status: 500 });
  });
  try {
    await settleOnFakeClock(t, () =>
      withCallContext({ userId: "u1", feature: "f", captureBodies: false }, () =>
        fetchLLMDetailed("p", "openrouter", "k", 100)));
    await flushProviderLog();
    assert.equal(n, 6, "the fixture must fire the inner retry on every rung");
    assert.deepEqual(__rows().map(r => r.attempt), [1, 1, 2, 2, 3, 3]);
    assert.deepEqual(__rows().map(r => r.status), [400, 500, 400, 500, 400, 500]);
  } finally { stub.restore(); }
});

test("the retry ladder's attempt numbers follow the ladder, not the fetch count", async (t) => {
  // The first draft asserted rows.length === observed fetch count and attempts 1..n, which is
  // tautological: an implementation numbering raw fetches passes it and is wrong the moment a
  // provider makes two per attempt. Assert the ladder's own shape instead.
  __setWriterForTests();
  const stub = stubFetch(async () => new Response("boom", { status: 500 }));
  try {
    await settleOnFakeClock(t, () =>
      withCallContext({ userId: "u1", feature: "f", captureBodies: false }, () =>
        fetchLLMDetailed("p", "openai", "k", 100)));
    await flushProviderLog();
    assert.deepEqual(__rows().map(r => r.attempt), [1, 2, 3]);
  } finally { stub.restore(); }
});

test("a cap that shortens the ladder shortens the rows with it", async (t) => {
  // attemptCapFor (llm.ts:322) cuts the ladder to two for a gateway that discarded a generation
  // for want of a usage block.
  __setWriterForTests();
  const stub = stubFetch(async () => new Response(JSON.stringify({ error: { message: "did not include usage for billing" } }), { status: 502 }));
  try {
    await settleOnFakeClock(t, () =>
      withCallContext({ userId: "u1", feature: "f", captureBodies: false }, () =>
        fetchLLMDetailed("p", "openai", "k", 100)));
    await flushProviderLog();
    assert.deepEqual(__rows().map(r => r.attempt), [1, 2]);
  } finally { stub.restore(); }
});

test("a 200 that produced no text carries the reason the caller was given", async () => {
  // The failure the log used to file as a clean success: the app returns "empty completion — the
  // token limit was reached…" and the row said status 200, tokens billed, error null. An operator
  // opening the log to ask why a run failed had nothing to go on, on the one failure
  // emptyCompletionDetail exists to explain.
  __setWriterForTests();
  const stub = stubFetch(async () => new Response(JSON.stringify({
    choices: [{ message: { content: "" }, finish_reason: "length" }],
    usage: { prompt_tokens: 9, completion_tokens: 0 },
  }), { status: 200 }));
  try {
    const r = await withCallContext({ userId: "u1", feature: "f", captureBodies: false }, () =>
      fetchLLMDetailed("p", "openai", "k", 100, "gpt-5-mini"));
    assert.equal(r.text, null);
    assert.match(r.error ?? "", /empty completion/);
    await flushProviderLog();
    assert.equal(__rows().length, 1, "an empty completion is not retryable — the ladder stops");
    const row = __rows()[0];
    assert.equal(row.status, 200);
    // The tokens were still billed, so they are still recorded.
    assert.equal(row.promptTokens, 9);
    assert.match(row.error, /empty completion/);
    assert.match(row.error, /token limit was reached/);
    assert.equal(row.complete, true);
  } finally { stub.restore(); }
});

test("with capture on, the row holds both halves of the exchange", async () => {
  // The response text is the whole reason an operator turns capture on for the AI path, and it
  // is the half `loggedFetch` cannot get on its own — reading the stream there would consume the
  // body the caller still has to parse.
  __setWriterForTests();
  const stub = stubFetch(async () => new Response(JSON.stringify({
    choices: [{ message: { content: "the answer" } }], usage: { prompt_tokens: 1, completion_tokens: 2 },
  }), { status: 200 }));
  try {
    await withCallContext({ userId: "u1", feature: "f", captureBodies: true }, () =>
      fetchLLMDetailed("the prompt", "openai", "k", 100));
    await flushProviderLog();
    assert.match(__rows()[0].requestBody, /the prompt/);
    assert.match(__rows()[0].responseBody, /the answer/);
  } finally { stub.restore(); }
});

test("a logging failure never fails the provider call", async (t) => {
  // `usageFrom` is evaluated in llm.ts, outside log.ts's own guard. Unguarded, a throw there
  // lands in fetchLLMOnce's catch and comes back RETRYABLE: bookkeeping failing a call the
  // provider has already been paid for, and then paying for it twice more.
  __setWriterForTests();
  const hostile: any = new Proxy({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }, {
    get(target: any, key) {
      if (key === "usage") throw new Error("usage is a trap");
      return target[key];
    },
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true, status: 200, headers: new Headers(),
    json: async () => hostile, text: async () => "",
  })) as any;
  try {
    const r = await settleOnFakeClock(t, () =>
      withCallContext({ userId: "u1", feature: "f", captureBodies: false }, () =>
        fetchLLMDetailed("p", "openai", "k", 100)));
    assert.equal(r.text, "hi", "a logging throw must not turn a paid answer into a failure");
    await flushProviderLog();
    assert.equal(__rows().length, 1, "nor one billed call into three");
  } finally { globalThis.fetch = original; }
});

test("the vision path is logged too — same providers, same money, no rows until now", async () => {
  __setWriterForTests();
  const stub = stubFetch(async () => new Response(JSON.stringify({
    content: [{ type: "text", text: "a screenshot" }],
    usage: { input_tokens: 700, output_tokens: 40 },
  }), { status: 200 }));
  try {
    const text = await withCallContext({ userId: "u2", feature: "landing", captureBodies: true }, () =>
      fetchLLMVision("p", "AAAA", "image/png", "anthropic", "k", 2048, "claude-x"));
    assert.equal(text, "a screenshot");
    await flushProviderLog();
    assert.equal(__rows().length, 1);
    const row = __rows()[0];
    assert.equal(row.provider, "anthropic");
    assert.equal(row.model, "claude-x");
    assert.equal(row.endpoint, "https://api.anthropic.com/v1/messages");
    assert.equal(row.promptTokens, 700);
    assert.equal(row.completionTokens, 40);
    assert.match(row.responseBody, /a screenshot/);
    assert.equal(row.complete, true);
  } finally { stub.restore(); }
});

test("a failed call is a row carrying the provider's own reason, and its body", async () => {
  __setWriterForTests();
  const stub = stubFetch(async () => new Response(JSON.stringify({ error: { message: "insufficient quota" } }), { status: 402 }));
  try {
    await withCallContext({ userId: "u1", feature: "f", captureBodies: true }, () =>
      fetchLLMDetailed("p", "cheaperinference", "k", 100));
    await flushProviderLog();
    assert.equal(__rows().length, 1, "402 is not retryable, so the ladder stops at one");
    assert.equal(__rows()[0].status, 402);
    assert.match(__rows()[0].error, /insufficient quota/);
    assert.match(__rows()[0].responseBody, /insufficient quota/);
    assert.equal(__rows()[0].complete, true);
  } finally { stub.restore(); }
});
