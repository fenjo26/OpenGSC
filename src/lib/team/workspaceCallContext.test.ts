// Whose call is this, and what was it for — established once, for 122 routes.
//
// `workspaceUserId()` is the only place in a route's lifetime that already knows who is asking,
// so it is where the provider log's context is set. Two properties are worth a test each:
//
//   1. The context must be visible to the *caller* — the route handler that makes the provider
//      call after `await workspaceUserId()`. `enterWith` only reaches the caller when it runs
//      before the callee's first await, which is why the context is entered empty and filled in.
//      Assert it after the await, from the caller, or the test proves nothing about routes.
//   2. `feature` is a label an outsider could otherwise write. The proxy deletes any inbound
//      value before setting the matched path, and the forged-header test below is the check.
//
// The module graph is stubbed rather than mocked in place: workspace.ts pulls in `server-only`,
// next-auth and Prisma, none of which resolve or mean anything outside a Next request.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { currentCallContext } from "../providerLog/context";
import { ROUTE_HEADER as PROXY_ROUTE_HEADER, withRouteHeader } from "../../proxy";

const OWNER = { id: "owner-1", email: "owner@example.test", name: "Owner", isOwner: true, mustChangePassword: false };

const world: { session: unknown; headers: Headers; prisma: unknown; settings: Record<string, Record<string, string>> } = {
  session: { user: { id: OWNER.id } },
  headers: new Headers(),
  // The mirrored SEO settings snapshot, per user id — where the body-capture switch lives.
  settings: {},
  prisma: {
    user: {
      findFirst: async () => OWNER,
      findUnique: async () => OWNER,
      update: async () => OWNER,
    },
  },
};
(globalThis as unknown as { __ws: typeof world }).__ws = world;

const dir = mkdtempSync(join(tmpdir(), "opengsc-ws-"));
const stub = (name: string, src: string) => {
  const p = join(dir, name);
  writeFileSync(p, src);
  return pathToFileURL(p).href;
};
const STUBS: Record<string, string> = {
  "server-only": stub("server-only.cjs", "module.exports = {};"),
  "next-auth": stub("next-auth.cjs", "exports.getServerSession = async () => globalThis.__ws.session;"),
  "@/lib/auth": stub("auth.cjs", "exports.authOptions = {};"),
  "@/lib/prisma": stub("prisma.cjs", "exports.prisma = new Proxy({}, { get: (_t, k) => globalThis.__ws.prisma[k] });"),
  "next/headers": stub("headers.cjs", "exports.headers = async () => globalThis.__ws.headers;"),
  "@/lib/db/raw": stub("raw.cjs", `
    exports.rawQuery = async (_sql, id) => {
      const s = globalThis.__ws.settings[id];
      return s ? [{ seoSettings: JSON.stringify(s) }] : [];
    };
    exports.rawExec = async () => undefined;
  `),
};
// `module.registerHooks` is newer than this project's @types/node (^20), and typing it here is
// cheaper than an upgrade the rest of the codebase has not asked for.
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

type WorkspaceModule = typeof import("./workspace");

/**
 * One request, as a route handler experiences it: the proxy runs, the handler runs its guard,
 * and only then does the provider call happen.
 *
 * The guard is a parameter because there are three of them — `workspaceUserId`, `requireWorkspace`
 * and a bare `getWorkspace` — and the context has to reach the handler through all three. It used
 * to reach it through only the first, which left the seven routes on the other two exempt.
 */
async function request<T>(
  pathname: string,
  guard: (m: WorkspaceModule) => Promise<T>,
  { inbound = {} as Record<string, string>, viaProxy = true } = {},
) {
  const req = { headers: new Headers(inbound), nextUrl: { pathname } };
  world.headers = viaProxy ? withRouteHeader(req) : req.headers;

  const result = await guard(await import("./workspace"));

  // Where the log actually reads it: after the await, one frame deeper, past a turn of the loop.
  await new Promise(r => setImmediate(r));
  const seen = await (async () => currentCallContext())();
  return { result, ctx: seen };
}

test("a route's provider calls carry the owner and the path the proxy matched", async () => {
  const { result: userId, ctx } = await request("/api/keywords/suggest", m => m.workspaceUserId());
  assert.equal(userId, OWNER.id);
  assert.equal(ctx.userId, OWNER.id);
  assert.equal(ctx.feature, "/api/keywords/suggest");
  // Off unless the owner asked for it: a switch that stores prompts and completions is not
  // something a request may turn on for itself.
  assert.equal(ctx.captureBodies, false);
});

test("the owner's body-capture switch is resolved once, here, and carried on the context", async () => {
  // The logger is synchronous and cannot read a settings snapshot from inside a provider call, so
  // the answer has to be on the context before the handler runs. Resolve it anywhere later and
  // every route captures nothing, silently, forever.
  world.settings[OWNER.id] = { seoProviderLogBodies: "1" };
  try {
    const { ctx } = await request("/api/seo/text", m => m.workspaceUserId());
    assert.equal(ctx.captureBodies, true);
  } finally {
    world.settings = {};
  }
});

test("a member's request is governed by the owner's switch, not their own", async () => {
  // A member's calls spend the owner's money and land in the owner's log, so it is the owner's
  // decision whether the payloads are kept. Reading the actor's row instead would let anyone
  // invited into a workspace start storing that workspace's prompts.
  const MEMBER = { id: "member-1", email: "m@example.test", name: "M", isOwner: false, mustChangePassword: false };
  const real = world.prisma;
  world.session = { user: { id: MEMBER.id } };
  world.settings[OWNER.id] = { seoProviderLogBodies: "1" };
  world.settings[MEMBER.id] = { seoProviderLogBodies: "0" };
  world.prisma = {
    user: { findFirst: async () => OWNER, findUnique: async () => MEMBER, update: async () => OWNER },
    membership: { findFirst: async () => ({ id: "mem-1", role: "admin", status: "active", userId: MEMBER.id }), update: async () => ({}) },
  };
  try {
    const { ctx } = await request("/api/seo/text", m => m.workspaceUserId());
    assert.equal(ctx.userId, OWNER.id);
    assert.equal(ctx.captureBodies, true);
  } finally {
    world.prisma = real;
    world.session = { user: { id: OWNER.id } };
    world.settings = {};
  }
});

test("a forged route header is overwritten, never believed", async () => {
  // `feature` is only a label, but a label an outsider can write is worse than no label: it puts
  // a name of their choosing on rows an operator reads to decide what a user was doing.
  const { ctx } = await request("/api/keywords/suggest", m => m.workspaceUserId(), {
    inbound: { [PROXY_ROUTE_HEADER]: "/api/team/members" },
  });
  assert.equal(ctx.feature, "/api/keywords/suggest");

  // Two inbound copies, in case a future edit ever reaches for `append`: neither survives.
  const forged = new Headers();
  forged.append(PROXY_ROUTE_HEADER, "/spoofed");
  forged.append(PROXY_ROUTE_HEADER, "/spoofed-again");
  const out = withRouteHeader({ headers: forged, nextUrl: { pathname: "/api/sites" } });
  assert.deepEqual(
    [...out].filter(([k]) => k === PROXY_ROUTE_HEADER),
    [[PROXY_ROUTE_HEADER, "/api/sites"]],
  );
});

test("no header, no proxy — the label is lost but the attribution is not", async () => {
  const { result: userId, ctx } = await request("/api/keywords/suggest", m => m.workspaceUserId(), { viaProxy: false });
  assert.equal(userId, OWNER.id);
  assert.equal(ctx.userId, OWNER.id);
  assert.equal(ctx.feature, null);
});

test("a caller who may not act is attributed to nobody, not to whoever came before", async () => {
  world.session = null;
  try {
    const { result: userId, ctx } = await request("/api/keywords/suggest", m => m.workspaceUserId());
    assert.equal(userId, null);
    assert.equal(ctx.userId, null);
    assert.equal(ctx.feature, null);
  } finally {
    world.session = { user: { id: OWNER.id } };
  }
});

test("requireWorkspace — the other guard idiom — establishes the same context", async () => {
  // Seven routes reach the workspace through `requireWorkspace()` or `getWorkspace()` rather than
  // `workspaceUserId()`. None makes a provider call today; the first one to grow an AI call would
  // have logged a null user, and nothing would have failed. Hence the context lives in
  // getWorkspace(), and hence this test.
  const { result, ctx } = await request("/api/scan", m => m.requireWorkspace("read"));
  assert.equal(result.ok, true);
  assert.equal(ctx.userId, OWNER.id);
  assert.equal(ctx.feature, "/api/scan");
});

test("getWorkspace called directly gives the handler the same context", async () => {
  const { result, ctx } = await request("/api/team", m => m.getWorkspace());
  assert.equal(result?.ownerId, OWNER.id);
  assert.equal(ctx.userId, OWNER.id);
  assert.equal(ctx.feature, "/api/team");
});

test("a row opened before the workspace resolves names nobody, not the caller before it", async () => {
  // The context is entered empty and filled in, so for the length of the resolution it exists and
  // says `userId: null`. That is an invariant rather than a guarantee — it holds because no
  // provider call can happen before the guard returns — so it is worth pinning: the answer during
  // the window must be "nobody", never the previous request's user. This test runs after four
  // that resolved OWNER, so a leaked store would show up here.
  const during: { userId: string | null; feature: string | null }[] = [];
  const watch = async <T>(v: T): Promise<T> => {
    const { userId, feature } = currentCallContext();
    during.push({ userId, feature });
    return v;
  };
  const real = world.prisma;
  world.prisma = {
    user: {
      findFirst: () => watch(OWNER),
      findUnique: () => watch(OWNER),
      update: async () => OWNER,
    },
  };
  try {
    const { ctx } = await request("/api/keywords/suggest", m => m.workspaceUserId());
    assert.ok(during.length > 0, "the stubbed resolution never ran");
    for (const seen of during) {
      assert.deepEqual(seen, { userId: null, feature: null });
    }
    assert.equal(ctx.userId, OWNER.id);
  } finally {
    world.prisma = real;
  }
});

test("the header the proxy writes is the header workspace.ts reads", async () => {
  // The name is spelled out in both files rather than imported across them — src/proxy.ts must
  // not drag next-auth/middleware into every route bundle — so the agreement is asserted here.
  const { ROUTE_HEADER } = await import("./workspace");
  assert.equal(typeof PROXY_ROUTE_HEADER, "string");
  assert.ok(PROXY_ROUTE_HEADER.length > 0);
  assert.equal(ROUTE_HEADER, PROXY_ROUTE_HEADER);
});
