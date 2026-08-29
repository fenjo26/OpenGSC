import { test } from "node:test";
import assert from "node:assert/strict";
import { withCallContext } from "./context";
import { BODY_MAX_CHARS } from "./redact";
import {
  flushProviderLog, loggedFetch, startProviderCall,
  __rows, __setWriterForTests, __writeToTableForTests,
} from "./log";

function stubFetch(impl: (url: string, init: any) => Promise<Response>) {
  const original = globalThis.fetch;
  const seen: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    return impl(String(url), init);
  }) as any;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

test("a call is one row per fetch, opened at the request and closed after parsing", async () => {
  __setWriterForTests();
  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  try {
    await withCallContext({ userId: "u1", feature: "/api/x", captureBodies: false }, async () => {
      const { res, call } = await loggedFetch("https://api.example.com/v1/chat?key=SECRET", { method: "POST" }, { provider: "openai", model: "gpt-5" });
      await res.json();
      call.finish({ promptTokens: 11, completionTokens: 22 });
    });
    const row = __rows()[0];
    assert.equal(row.userId, "u1");
    assert.equal(row.endpoint, "https://api.example.com/v1/chat");
    assert.equal(row.status, 200);
    assert.equal(row.promptTokens, 11);
  } finally { stub.restore(); }
});

test("a call that is never finished is still recorded, as incomplete", async () => {
  // An early return between the fetch and the parse must not delete the evidence that a paid
  // request happened. The row exists from the moment status is known.
  __setWriterForTests();
  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  try {
    await loggedFetch("https://api.example.com/v1", {}, { provider: "openai" });
    await flushProviderLog();
    assert.equal(__rows().length, 1);
    assert.equal(__rows()[0].promptTokens, null);
  } finally { stub.restore(); }
});

test("tokens still land when parsing takes longer than a tick", async () => {
  // The previous revision self-finished on the next tick. A real await res.json() crosses one,
  // so every row would have been written token-less and the real finish() rejected as a
  // duplicate — the feature defeated by its own safety net.
  __setWriterForTests();
  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  try {
    const { res, call } = await loggedFetch("https://api.example.com/v1", {}, { provider: "openai" });
    await res.json();
    await new Promise(r => setTimeout(r, 20));
    call.finish({ promptTokens: 9, completionTokens: 8 });
    await flushProviderLog();
    assert.equal(__rows().length, 1, "one row, not two");
    assert.equal(__rows()[0].promptTokens, 9);
  } finally { stub.restore(); }
});

test("pending writes are drained rather than lost at exit", async () => {
  __setWriterForTests(async () => { await new Promise(r => setTimeout(r, 30)); });
  startProviderCall({ provider: "openai", endpoint: "https://x/y" }).finish();
  await flushProviderLog();
  assert.equal(__rows().length, 1);
});

test("the handler shutdown runs is the one that drains a pending write", async () => {
  // Counting listeners proved nothing: tsx registers its own beforeExit handler ("exitHandler"),
  // so the old assertion passed with our registration deleted. Find ours by name and make it do
  // the work.
  let written = false;
  __setWriterForTests(async () => { await new Promise(r => setTimeout(r, 20)); written = true; });
  startProviderCall({ provider: "openai", endpoint: "https://x/y" }).finish();
  const drain = process.listeners("beforeExit").find(l => l.name === "drainProviderLogOnExit");
  assert.ok(drain, "nothing registered on beforeExit");
  assert.equal(written, false, "the write should still be in flight");
  await (drain as (...args: any[]) => any)("beforeExit");
  assert.equal(written, true);
});

test("nothing is registered on SIGTERM", () => {
  // Registering any SIGTERM listener suppresses Node's default terminate for the whole process.
  // One other passive listener anywhere then keeps ours from reaching its exit, and a container
  // stop becomes a wait for SIGKILL; a flush blocked on a locked write does the same on its own.
  // This module does not own process lifetime.
  assert.deepEqual(process.listeners("SIGTERM"), []);
});

test("an update can never be attempted before its own insert", async () => {
  // The queue is FIFO per row, not merely per process: finish() chains onto the insert promise.
  // Without that, a slow insert and a fast finish race, and the completed facts hit a row that
  // does not exist yet — a row silently stuck at complete:false forever.
  const order: string[] = [];
  __setWriterForTests(async (op: any) => {
    order.push(op.kind);
    if (op.kind === "insert") await new Promise(r => setTimeout(r, 30));
  });
  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  try {
    const { call } = await loggedFetch("https://api.example.com/v1", {}, { provider: "openai" });
    call.finish({ promptTokens: 1 });
    await flushProviderLog();
    assert.deepEqual(order, ["insert", "update"]);
  } finally { stub.restore(); }
});

test("two concurrent calls write two rows and never touch each other's", async () => {
  __setWriterForTests();
  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  try {
    const [a, b] = await Promise.all([
      loggedFetch("https://api.example.com/a", {}, { provider: "openai" }),
      loggedFetch("https://api.example.com/b", {}, { provider: "serper" }),
    ]);
    a.call.finish({ promptTokens: 1 });
    b.call.finish({ promptTokens: 2 });
    await flushProviderLog();
    const rows = __rows();
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map(r => r.id)).size, 2);
    assert.equal(rows.find(r => r.provider === "openai").promptTokens, 1);
    assert.equal(rows.find(r => r.provider === "serper").promptTokens, 2);
  } finally { stub.restore(); }
});

test("the real writer completes a row with updateMany, so a deleted row is a count and not a throw", async () => {
  // Every other test in this file replaces the writer, so the choice that actually protects a
  // long call from its own retention — updateMany rather than update — was never executed. A
  // stub whose update() raises the way Prisma's does on a missing row keeps it that way.
  const seen: any[] = [];
  const table = {
    create: (arg: any) => { seen.push(["create", arg]); return Promise.resolve(arg.data); },
    updateMany: (arg: any) => { seen.push(["updateMany", arg]); return Promise.resolve({ count: 0 }); },
    update: () => { throw new Error("update() raises on a row retention has already deleted"); },
  };
  await __writeToTableForTests(table, { kind: "insert", row: { id: "c1", provider: "openai" } });
  const res: any = await __writeToTableForTests(table, { kind: "update", id: "c1", data: { complete: true } });
  assert.deepEqual(seen.map(s => s[0]), ["create", "updateMany"]);
  assert.deepEqual(seen[0][1], { data: { id: "c1", provider: "openai" } });
  assert.deepEqual(seen[1][1], { where: { id: "c1" }, data: { complete: true } });
  assert.equal(res.count, 0);
});

test("the real writer is a no-op when the generated client has no providerCall model", () => {
  assert.equal(__writeToTableForTests(undefined, { kind: "insert", row: { id: "c1" } }), undefined);
});

test("a finish whose row retention already deleted is a no-op, not a throw", async () => {
  // A very long call can outlive its own row. Losing an old log row is not a reason to raise
  // into the provider call that is still running.
  __setWriterForTests(async (op: any) => { if (op.kind === "update") return { count: 0 }; });
  const h = startProviderCall({ provider: "openai", endpoint: "https://x/y" });
  await assert.doesNotReject(async () => { h.finish({ promptTokens: 1 }); await flushProviderLog(); });
});

test("an unfinished row is distinguishable from one whose provider sent no usage", () => {
  __setWriterForTests();
  startProviderCall({ provider: "openai", endpoint: "https://x/y" });            // never finished
  startProviderCall({ provider: "serper", endpoint: "https://x/z" }).finish();   // finished, no usage
  const [unfinished, finished] = __rows();
  assert.equal(unfinished.complete, false);
  assert.equal(finished.complete, true);
  assert.equal(finished.promptTokens, null);
});

test("finish is idempotent, so a self-finished call is not double-counted", async () => {
  __setWriterForTests();
  const h = startProviderCall({ provider: "openai", endpoint: "https://x/y" });
  h.finish({ promptTokens: 1 });
  h.finish({ promptTokens: 2 });
  assert.equal(__rows().length, 1);
  assert.equal(__rows()[0].promptTokens, 1);
});

test("a transport failure is recorded rather than lost, and still throws", async () => {
  // The provider may well have billed it. A call that vanishes because it failed is the exact
  // gap this feature exists to close.
  __setWriterForTests();
  const stub = stubFetch(async () => { throw new TypeError("fetch failed"); });
  try {
    await assert.rejects(() => loggedFetch("https://api.example.com/v1", {}, { provider: "openai" }));
    assert.equal(__rows()[0].status, 0);
    assert.match(__rows()[0].error ?? "", /fetch failed/);
  } finally { stub.restore(); }
});

test("cost is written only when a provider stated one, and never invented when it did not", () => {
  // Reading the column default proved nothing: it would have passed against an implementation
  // that dropped costUsd on the floor. Watch the write instead.
  const ops: any[] = [];
  __setWriterForTests((op: any) => { ops.push(op); });
  startProviderCall({ provider: "openai", endpoint: "https://x/y" }).finish();
  startProviderCall({ provider: "openrouter", endpoint: "https://x/y" }).finish({ costUsd: 0.0012 });
  const [, unpriced, , priced] = ops;
  assert.equal(unpriced.kind, "update");
  assert.ok(!("costUsd" in unpriced.data), "a finish with no stated cost must not write one at all");
  assert.equal(__rows()[0].costUsd, null);
  assert.equal(priced.data.costUsd, 0.0012);
  assert.equal(__rows()[1].costUsd, 0.0012);
});

test("a hand-opened call records the status it reports, not the 0 that means no response", () => {
  // The schema documents 0 as "a transport failure that never got one", so a consumer filtering
  // failures by status would read every SDK-path call as one if finish could not set it.
  __setWriterForTests();
  startProviderCall({ provider: "openai", endpoint: "https://x/y" }).finish({ status: 200 });
  assert.equal(__rows()[0].status, 200);
  startProviderCall({ provider: "openai", endpoint: "https://x/y" }).finish();
  assert.equal(__rows()[1].status, 0, "a call that never reported a status keeps 0");
});

test("ms is the time to the caller's finish, not the time to the response headers", async () => {
  // await fetch resolves on headers, and for an LLM the generation happens inside the caller's
  // res.json(). Fixing ms at header arrival left the provider's own time out of every row.
  __setWriterForTests();
  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  try {
    const { res, call } = await loggedFetch("https://api.example.com/v1", {}, { provider: "openai" });
    await res.json();
    await new Promise(r => setTimeout(r, 40));
    call.finish();
    assert.ok(__rows()[0].ms >= 35, `ms was ${__rows()[0].ms}`);
  } finally { stub.restore(); }
});

test("a call nobody finishes still records how long the response took to arrive", async () => {
  __setWriterForTests();
  const stub = stubFetch(async () => { await new Promise(r => setTimeout(r, 30)); return new Response("{}", { status: 200 }); });
  try {
    await loggedFetch("https://api.example.com/v1", {}, { provider: "openai" });
    assert.ok(__rows()[0].ms >= 25, `ms was ${__rows()[0].ms}`);
  } finally { stub.restore(); }
});

test("a call with no context is still recorded, with nobody attached", async () => {
  __setWriterForTests();
  startProviderCall({ provider: "serper", endpoint: "https://x/y" }).finish();
  assert.equal(__rows()[0].userId, null);
});

test("bodies are absent unless capture is on for this context", async () => {
  __setWriterForTests();
  startProviderCall({ provider: "openai", endpoint: "https://x/y", requestBody: { prompt: "hi" } }).finish();
  assert.equal(__rows()[0].requestBody, null);
  await withCallContext({ userId: "u", feature: "f", captureBodies: true }, () => {
    startProviderCall({ provider: "openai", endpoint: "https://x/y", requestBody: { prompt: "hi", apiKey: "sk-secret-value" } }).finish();
  });
  const r = __rows()[1];
  assert.match(r.requestBody, /hi/);
  assert.ok(!r.requestBody.includes("sk-secret-value"));
});

test("a request body is parsed before redaction, so its field names can be seen", async () => {
  // A body left as a JSON string is one opaque value to redact(), which blanks fields by name:
  // an apiKey whose value happens not to be vendor-shaped would go straight into the log.
  __setWriterForTests();
  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  try {
    await withCallContext({ userId: "u", feature: "f", captureBodies: true }, async () => {
      await loggedFetch(
        "https://api.example.com/v1",
        { method: "POST", body: JSON.stringify({ apiKey: "plain-not-vendor-shaped", prompt: "hi" }) },
        { provider: "openai" },
      );
    });
    const body = __rows()[0].requestBody;
    assert.match(body, /hi/);
    assert.ok(!body.includes("plain-not-vendor-shaped"));
  } finally { stub.restore(); }
});

test("a request body that is not JSON is kept as it is, with its vendor-shaped key still stripped", async () => {
  __setWriterForTests();
  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  try {
    await withCallContext({ userId: "u", feature: "f", captureBodies: true }, async () => {
      await loggedFetch(
        "https://api.example.com/v1",
        { method: "POST", body: "key=sk-secret-value-1234567890&q=weather" },
        { provider: "serper" },
      );
    });
    const body = __rows()[0].requestBody;
    assert.match(body, /weather/);
    assert.ok(!body.includes("sk-secret-value-1234567890"));
  } finally { stub.restore(); }
});

test("a request body that is not a string is never touched", async () => {
  // Reading a stream or a FormData here would consume the body the request itself still needs.
  __setWriterForTests();
  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); c.close(); } });
  const form = new FormData();
  form.append("q", "weather");
  try {
    await withCallContext({ userId: "u", feature: "f", captureBodies: true }, async () => {
      for (const body of [undefined, Buffer.from("x"), form, stream] as any[]) {
        await loggedFetch("https://api.example.com/v1", { method: "POST", body }, { provider: "openai" });
      }
    });
    assert.deepEqual(__rows().map(r => r.requestBody), [null, null, null, null]);
    assert.equal(stream.locked, false, "the request stream must not have been read");
  } finally { stub.restore(); }
});

test("an oversized request body is truncated rather than stored whole", async () => {
  __setWriterForTests();
  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  try {
    await withCallContext({ userId: "u", feature: "f", captureBodies: true }, async () => {
      await loggedFetch(
        "https://api.example.com/v1",
        { method: "POST", body: JSON.stringify({ prompt: "x".repeat(BODY_MAX_CHARS * 3) }) },
        { provider: "openai" },
      );
    });
    const body = __rows()[0].requestBody;
    assert.ok(body.length < BODY_MAX_CHARS + 32, `kept ${body.length} chars`);
    assert.match(body, /truncated/);
  } finally { stub.restore(); }
});

test("a body that cannot be serialized costs its own capture, never the row or the call", async () => {
  // redact() falls back to String(value) when JSON.stringify throws, and String() itself throws
  // on a null-prototype object. Building the row sits outside the writer's guard, so this threw
  // straight into the caller — and only ever when an operator had switched capture on to debug
  // something.
  __setWriterForTests();
  const circular: any = Object.create(null);
  circular.self = circular;
  withCallContext({ userId: "u", feature: "f", captureBodies: true }, () => {
    const h = startProviderCall({ provider: "openai", endpoint: "https://x/y", requestBody: circular });
    h.finish({ responseBody: circular, promptTokens: 3 });
  });
  const row = __rows()[0];
  assert.equal(row.requestBody, "[unserializable]");
  assert.equal(row.responseBody, "[unserializable]");
  assert.equal(row.promptTokens, 3, "the facts that could be recorded still were");
  assert.equal(row.complete, true);
});

test("a body that breaks redaction does not fail a call whose fetch already succeeded", async () => {
  // A 20 000-deep array parses and then overflows the stringifier. The provider has been paid by
  // this point; losing the response to a logging RangeError is the worst possible trade.
  __setWriterForTests();
  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  try {
    await withCallContext({ userId: "u", feature: "f", captureBodies: true }, async () => {
      const deep = "[".repeat(20_000) + "]".repeat(20_000);
      const { res, call } = await loggedFetch("https://api.example.com/v1", { method: "POST", body: deep }, { provider: "openai" });
      assert.equal(res.status, 200);
      call.finish({ promptTokens: 1 });
    });
    assert.equal(__rows().length, 1);
    assert.equal(__rows()[0].requestBody, "[unserializable]");
    assert.equal(__rows()[0].promptTokens, 1);
  } finally { stub.restore(); }
});

test("a transport failure reports the network error, not a failure of the logging", async () => {
  // A throw while building the row would otherwise replace the caller's real error with ours.
  __setWriterForTests();
  const circular: any = Object.create(null);
  circular.self = circular;
  const stub = stubFetch(async () => { throw new TypeError("fetch failed"); });
  try {
    await withCallContext({ userId: "u", feature: "f", captureBodies: true }, async () => {
      await assert.rejects(
        () => loggedFetch("https://api.example.com/v1", { method: "POST", body: JSON.stringify({ a: 1 }) }, { provider: "openai" }),
        /fetch failed/,
      );
    });
  } finally { stub.restore(); }
});

test("a writer that rejects asynchronously never breaks the caller", async () => {
  // The first draft only tested a synchronous throw. Prisma rejects.
  __setWriterForTests(async () => { throw new Error("db is gone"); });
  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  try {
    const { res } = await loggedFetch("https://api.example.com/v1", {}, { provider: "openai" });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 5));
  } finally { stub.restore(); }
});

test("the caller is not made to wait for the write", async () => {
  // Logging is bookkeeping. rankScheduler does up to 50 sequential checks per site; adding a
  // synchronous SQLite write to each one would be a self-inflicted slowdown.
  __setWriterForTests(async () => { await new Promise(r => setTimeout(r, 200)); });
  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  try {
    const t0 = Date.now();
    const { call } = await loggedFetch("https://api.example.com/v1", {}, { provider: "openai" });
    call.finish();
    assert.ok(Date.now() - t0 < 100, "finish() must not await the write");
  } finally { stub.restore(); }
});
