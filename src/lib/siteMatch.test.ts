import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSiteAccess, siteWhere } from "./siteMatch";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────
const SITE = {
  id: "cmwfyvj0x0001n7l3cam4woid",
  url: "albokl.com",
  userId: "user-owner",
  shareToken: "tok-share",
  shareEnabled: true,
};
const OTHER = {
  id: "zzz0000000000000000000zz",
  url: "velinoor.me",
  userId: "user-owner",
  shareToken: "tok-other",
  shareEnabled: false,
};

// Minimal Prisma-semantics matcher: flat AND equality + OR arrays — enough to evaluate the
// where clauses resolveSiteAccess builds, so the tests exercise real matching logic.
function makeDb(sites: Record<string, unknown>[]) {
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "OR" && Array.isArray(v)) return v.some(sub => matches(row, sub as Record<string, unknown>));
      return row[k] === v;
    });
  return (args: { where: Record<string, unknown> }) =>
    Promise.resolve(sites.find(s => matches(s, args.where)) ?? null);
}

function makeDeps(sites: Record<string, unknown>[], sessionUserId?: string) {
  const calls: { where: Record<string, unknown> }[] = [];
  return {
    calls,
    deps: {
      getSession: () => Promise.resolve(sessionUserId ? { user: { id: sessionUserId } } : null),
      findFirst: (args: { where: Record<string, unknown> }) => { calls.push(args); return makeDb(sites)(args); },
    },
  };
}

function reqWith(search: string) {
  return new Request(`https://opengsc.test/api/x?${search}`);
}

test("siteWhere: matches by id OR url", () => {
  assert.deepEqual(siteWhere("abc"), { OR: [{ id: "abc" }, { url: "abc" }] });
});

// ── authenticated access ────────────────────────────────────────────────────────────────────
test("owner session + site UUID resolves", async () => {
  const { deps } = makeDeps([SITE, OTHER], "user-owner");
  const r = await resolveSiteAccess(reqWith(""), SITE.id, deps);
  assert.equal(r?.userId, "user-owner");
  assert.equal((r?.site as typeof SITE).url, "albokl.com");
});

test("owner session + domain resolves (same account, both URL forms)", async () => {
  const { deps } = makeDeps([SITE, OTHER], "user-owner");
  const r = await resolveSiteAccess(reqWith(""), SITE.url, deps);
  assert.equal(r?.userId, "user-owner");
});

test("lookup is OR-scoped: the where clause carries both id and url keys", async () => {
  const { deps, calls } = makeDeps([SITE], "user-owner");
  await resolveSiteAccess(reqWith(""), SITE.id, deps);
  assert.deepEqual(calls[0].where.OR, [{ id: SITE.id }, { url: SITE.id }]);
  assert.equal(calls[0].where.userId, "user-owner");
});

// ── share access ────────────────────────────────────────────────────────────────────────────
test("valid share token resolves without a session, userId comes from the site", async () => {
  const { deps } = makeDeps([SITE], undefined);
  const r = await resolveSiteAccess(reqWith("shareToken=tok-share"), SITE.url, deps);
  assert.equal(r?.userId, "user-owner");
});

test("share token for a disabled share does NOT resolve", async () => {
  const { deps } = makeDeps([OTHER, SITE], undefined);
  const r = await resolveSiteAccess(reqWith("shareToken=tok-other"), OTHER.url, deps);
  assert.equal(r, null);
});

test("wrong share token does NOT resolve", async () => {
  const { deps } = makeDeps([SITE], undefined);
  const r = await resolveSiteAccess(reqWith("shareToken=nope"), SITE.url, deps);
  assert.equal(r, null);
});

// ── unauthorized / nonexistent ──────────────────────────────────────────────────────────────
test("another user's session cannot resolve a site they do not own (id OR domain)", async () => {
  const { deps } = makeDeps([SITE, OTHER], "user-intruder");
  assert.equal(await resolveSiteAccess(reqWith(""), SITE.id, deps), null);
  assert.equal(await resolveSiteAccess(reqWith(""), SITE.url, deps), null);
});

test("no session and no token -> null", async () => {
  const { deps } = makeDeps([SITE], undefined);
  assert.equal(await resolveSiteAccess(reqWith(""), SITE.id, deps), null);
});

test("nonexistent identifier -> null", async () => {
  const { deps } = makeDeps([SITE], "user-owner");
  assert.equal(await resolveSiteAccess(reqWith(""), "does-not-exist.example", deps), null);
  assert.equal(await resolveSiteAccess(reqWith(""), "000000000000000000000000", deps), null);
});
