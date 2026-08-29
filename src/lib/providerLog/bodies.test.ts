// The switch that lets the log keep prompts and completions — and the three ways it must not go
// wrong.
//
// `captureBodies` is resolved once, where a context is created, and then travels on the context:
// the logger is synchronous and cannot go and ask a database mid-call. That design has exactly
// one dangerous edge, which is that the answer is now carried rather than looked up, so a context
// built with the wrong answer captures the wrong person's payloads for as long as it lives. Hence
// the three properties pinned here:
//
//   1. On means a body is stored AND redacted. A capture that reproduced the operator's own key
//      would be a worse problem than whatever it was switched on to debug.
//   2. Off means both body columns are null — not an empty string, not "{}", which would read on
//      screen as "the provider was sent nothing".
//   3. One user's setting never reaches another user's rows, and a run with no user captures
//      nothing at all. `sync-cron` has no owner whose consent could be read, and picking one of
//      the due users would be inventing it.
//
// The module graph is stubbed the way the other context tests do it: `@/lib/db/raw` and
// `@/lib/prisma` mean nothing outside a running app, and the point of the test is the decision,
// not the SQL.

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// A real key shape, so the redaction assertion is about the redactor rather than about a string
// that was never credential-shaped in the first place.
const SECRET = "sk-live-9f3a2b7c8d1e4f5a6b7c";

const world: { settings: Record<string, Record<string, string>> } = { settings: {} };
(globalThis as unknown as { __bodies: typeof world }).__bodies = world;

const dir = mkdtempSync(join(tmpdir(), "opengsc-bodies-"));
const stub = (name: string, src: string) => {
  const p = join(dir, name);
  writeFileSync(p, src);
  return pathToFileURL(p).href;
};
const STUBS: Record<string, string> = {
  "@/lib/prisma": stub("prisma.cjs", "exports.prisma = {};"),
  // The one query `resolveCaptureBodies` makes, answered from the world above: the settings
  // snapshot SeoKeysSync mirrors out of the browser, per user.
  "@/lib/db/raw": stub("raw.cjs", `
    exports.rawQuery = async (_sql, id) => {
      const s = globalThis.__bodies.settings[id];
      return s ? [{ seoSettings: JSON.stringify(s) }] : [];
    };
    exports.rawExec = async () => undefined;
  `),
};

type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (s: string, c: unknown) => unknown,
) => unknown;
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: { resolve: ResolveHook }) => void;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = STUBS[specifier];
    return url ? { url, format: "commonjs", shortCircuit: true } : nextResolve(specifier, context);
  },
});

// Loaded after the hooks are registered, for the reason schedulerCallContext.test.ts spells out:
// a static import would put the real `@/lib/prisma` in the module cache before the stub exists.
type LogModule = typeof import("./log");
type BodiesModule = typeof import("./bodies");
type ContextModule = typeof import("./context");
let log!: LogModule;
let bodies!: BodiesModule;
let ctx!: ContextModule;

before(async () => {
  log = await import("./log");
  bodies = await import("./bodies");
  ctx = await import("./context");
});

beforeEach(() => {
  world.settings = {};
  delete process.env.OPENGSC_LOG_BODIES;
  log.__setWriterForTests();
});

/**
 * One provider call made the way production makes it: the setting resolved once at the edge of
 * the work, then carried on the context the logger reads.
 */
async function callAs(userId: string | null): Promise<void> {
  const captureBodies = await bodies.resolveCaptureBodies(userId);
  await ctx.withCallContext({ userId, feature: "test", captureBodies }, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    try {
      const { call } = await log.loggedFetch(
        "https://provider.test/v1/chat",
        { method: "POST", headers: { "x-api-key": SECRET }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "the prompt" }], api_key: SECRET }) },
        { provider: "test" },
      );
      call.finish({ status: 200, responseBody: { text: "the completion", key: SECRET } });
    } finally {
      globalThis.fetch = original;
    }
  });
  await log.flushProviderLog();
}

const rowFor = (userId: string | null) => log.__rows().find(r => r.userId === userId);

test("capture on: the body is there, and the key in it is not", async () => {
  world.settings["u-on"] = { [bodies.BODY_CAPTURE_SETTING]: "1" };
  await callAs("u-on");

  const row = rowFor("u-on");
  assert.ok(row, "the call was not logged at all");
  assert.match(String(row.requestBody), /the prompt/, "the request body was not captured");
  assert.match(String(row.responseBody), /the completion/, "the response body was not captured");
  assert.ok(!String(row.requestBody).includes(SECRET), "the request body kept the API key");
  assert.ok(!String(row.responseBody).includes(SECRET), "the response body kept the API key");
});

test("capture off: both body columns are null, not empty", async () => {
  world.settings["u-off"] = { [bodies.BODY_CAPTURE_SETTING]: "0" };
  await callAs("u-off");

  const row = rowFor("u-off");
  assert.ok(row, "the call was not logged at all");
  // Null, specifically: an empty string or "{}" in this column reads as "the provider was sent
  // nothing", which is a different and false statement.
  assert.equal(row.requestBody, null);
  assert.equal(row.responseBody, null);
});

test("a user who never touched the setting captures nothing", async () => {
  await callAs("u-untouched");
  const row = rowFor("u-untouched");
  assert.equal(row.requestBody, null);
  assert.equal(row.responseBody, null);
});

test("one user's setting never reaches another user's rows", async () => {
  world.settings["u-on"] = { [bodies.BODY_CAPTURE_SETTING]: "1" };
  world.settings["u-off"] = { [bodies.BODY_CAPTURE_SETTING]: "0" };

  await callAs("u-on");
  await callAs("u-off");

  assert.match(String(rowFor("u-on").requestBody), /the prompt/);
  assert.equal(rowFor("u-off").requestBody, null, "the other user's switch turned this one on");
  assert.equal(rowFor("u-off").responseBody, null);
});

test("a run with no user captures nothing, however many users switched it on", async () => {
  // sync-cron: one instance-wide run, `userId: null`, no owner whose consent could be read. The
  // failure this guards against is a later "improvement" that reads the first due user's setting
  // and starts storing everybody's prompts on one person's say-so.
  world.settings["u-on"] = { [bodies.BODY_CAPTURE_SETTING]: "1" };

  assert.equal(await bodies.resolveCaptureBodies(null), false);
  await callAs(null);

  const row = rowFor(null);
  assert.ok(row, "the userless call was not logged at all");
  assert.equal(row.requestBody, null);
  assert.equal(row.responseBody, null);
});

test("the env override switches an entire headless instance on, users and cron alike", async () => {
  // A deployment with no browser has nobody to click the toggle, so the instance-wide override is
  // the only way to capture anything there — including on the userless runs, which is the one
  // case where an explicit operator decision is the missing consent.
  process.env.OPENGSC_LOG_BODIES = "1";
  world.settings["u-off"] = { [bodies.BODY_CAPTURE_SETTING]: "0" };

  assert.equal(await bodies.resolveCaptureBodies(null), true);
  assert.equal(await bodies.resolveCaptureBodies("u-off"), true);
});

test("the env override can also hold an instance shut", async () => {
  // The other direction matters on a shared instance: an operator who has decided this deployment
  // never stores prompts should not have that decision undone from a settings screen.
  process.env.OPENGSC_LOG_BODIES = "0";
  world.settings["u-on"] = { [bodies.BODY_CAPTURE_SETTING]: "1" };

  assert.equal(await bodies.resolveCaptureBodies("u-on"), false);
});

test("a settings read that fails captures nothing rather than guessing", async () => {
  const real = world.settings;
  // A database that cannot answer is not a licence to store payloads.
  Object.defineProperty(world, "settings", { get() { throw new Error("no database"); }, configurable: true });
  try {
    assert.equal(await bodies.resolveCaptureBodies("u-on"), false);
  } finally {
    Object.defineProperty(world, "settings", { value: real, writable: true, configurable: true });
  }
});
