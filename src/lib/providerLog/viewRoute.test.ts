// Reading the log back — where the three ways it could leak are pinned.
//
// The table is the one place in this schema whose rows are not all tenant-scoped: a call made
// outside any context is stored with `userId: null`, deliberately, because inventing an owner
// would be worse. That honesty has a cost on the way out, and this file is where it is paid.
//
//   1. An unauthenticated request is refused. A read-only view of what every provider was asked
//      is still a view of what every provider was asked.
//   2. A request never returns another workspace's rows.
//   3. `userId: null` rows go ONLY to the instance owner. An earlier revision showed them to any
//      workspace owner so the design's "visible gap" would not be invisible — which turned the
//      gap into a cross-tenant leak, because a null row has no tenant key: `sync-cron` metadata
//      and, with capture on, its bodies, shown to everybody. The second-workspace assertion below
//      is what stops that coming back.
//
// The guard itself is stubbed rather than driven for real, and the reason is worth stating: the
// resolver in `workspace.ts` recognises exactly one owner per instance, so a second workspace
// cannot be constructed through it at all — the fake below is the only way to ask "and what does
// the OTHER workspace see?". What the real guard does with a real session is covered by
// roles.test.ts and workspaceCallContext.test.ts; what this file pins is that the route consults
// it, returns its refusal unchanged, and scopes every query to the workspace it hands back.

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Row {
  id: string;
  at: Date;
  userId: string | null;
  feature: string | null;
  provider: string;
  model: string | null;
  endpoint: string;
  status: number;
  ms: number;
  attempt: number;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  error: string | null;
  complete: boolean;
  requestBody: string | null;
  responseBody: string | null;
}

const OWNER_A = "u-a"; // the instance owner
const OWNER_B = "u-b"; // a second workspace, owner of nothing but its own rows

function row(p: Partial<Row> & { id: string }): Row {
  return {
    at: new Date("2026-08-29T12:00:00Z"), userId: OWNER_A, feature: "/api/seo/text",
    provider: "openai", model: "gpt-5", endpoint: "https://api.openai.com/v1/responses",
    status: 200, ms: 900, attempt: 1, promptTokens: 10, completionTokens: 20, costUsd: null,
    error: null, complete: true, requestBody: null, responseBody: null, ...p,
  };
}

const world: {
  rows: Row[];
  /** Who is signed in, and what they may do — the fake guard reads this. */
  actor: { ownerId: string; role: string } | null;
  users: Record<string, { isOwner: boolean }>;
  lastFindMany: any;
} = { rows: [], actor: null, users: {}, lastFindMany: null };
(globalThis as unknown as { __plog: typeof world }).__plog = world;

/** The subset of Prisma's `where` this route actually builds. Anything else is a test bug. */
function matches(r: Row, where: any): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") { if (!(v as any[]).some(w => matches(r, w))) return false; continue; }
    if (k === "at" || k === "id" || k === "userId" || k === "provider" || k === "feature") {
      const actual = (r as any)[k];
      if (v !== null && typeof v === "object") throw new Error(`unexpected operator on ${k}: ${JSON.stringify(v)}`);
      if (actual !== v) return false;
      continue;
    }
    throw new Error(`unexpected where key: ${k}`);
  }
  return true;
}

const dir = mkdtempSync(join(tmpdir(), "opengsc-plog-"));
const stub = (name: string, src: string) => {
  const p = join(dir, name);
  writeFileSync(p, src);
  return pathToFileURL(p).href;
};

const STUBS: Record<string, string> = {
  "@/lib/prisma": stub("prisma.cjs", `
    const w = () => globalThis.__plog;
    exports.prisma = {
      user: {
        findUnique: async ({ where }) => {
          const u = w().users[where.id];
          return u ? { id: where.id, isOwner: u.isOwner } : null;
        },
      },
      providerCall: {
        findMany: async (args) => {
          w().lastFindMany = args;
          const hit = w().rows.filter(r => globalThis.__plogMatches(r, args.where));
          // newest first is the route's job to ask for; honour whatever it asked for.
          const dir = args.orderBy && args.orderBy.at === "desc" ? -1 : 1;
          hit.sort((a, b) => dir * (a.at.getTime() - b.at.getTime()));
          const from = args.skip || 0;
          return hit.slice(from, args.take ? from + args.take : undefined);
        },
        count: async (args) => w().rows.filter(r => globalThis.__plogMatches(r, args.where)).length,
        findFirst: async (args) => w().rows.find(r => globalThis.__plogMatches(r, args.where)) || null,
        groupBy: async (args) => {
          const key = args.by[0];
          const seen = [];
          for (const r of w().rows.filter(x => globalThis.__plogMatches(x, args.where))) {
            if (r[key] != null && !seen.includes(r[key])) seen.push(r[key]);
          }
          return seen.map(v => ({ [key]: v }));
        },
      },
    };
  `),
  "@/lib/team/workspace": stub("workspace.cjs", `
    // A plain Response, because this stub is written to a temp directory and cannot resolve
    // \`next/server\` from there. The route only ever hands \`response\` straight back, so the two
    // are interchangeable here.
    const json = (b, init) => new Response(JSON.stringify(b), {
      status: (init && init.status) || 200, headers: { "content-type": "application/json" },
    });
    const NextResponse = { json };
    // A faithful miniature of the real guard: no session, no workspace; otherwise the workspace
    // the world says is signed in, refused if it lacks the capability asked for.
    exports.requireWorkspace = async (capability) => {
      const a = globalThis.__plog.actor;
      if (!a) return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
      if (capability === "manageSecrets" && a.role !== "owner") {
        return { ok: false, response: NextResponse.json({ error: "forbidden", capability }, { status: 403 }) };
      }
      return { ok: true, ws: { ownerId: a.ownerId, actorId: a.ownerId, role: a.role } };
    };
  `),
};
(globalThis as unknown as { __plogMatches: typeof matches }).__plogMatches = matches;

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

type RouteModule = typeof import("../../app/api/provider-log/route");
let route!: RouteModule;
before(async () => { route = await import("../../app/api/provider-log/route"); });

beforeEach(() => {
  world.actor = { ownerId: OWNER_A, role: "owner" };
  world.users = { [OWNER_A]: { isOwner: true }, [OWNER_B]: { isOwner: false } };
  world.lastFindMany = null;
  world.rows = [
    row({ id: "a1", userId: OWNER_A, at: new Date("2026-08-29T10:00:00Z") }),
    row({ id: "a2", userId: OWNER_A, at: new Date("2026-08-29T11:00:00Z"), provider: "serper", feature: "rank-cron", costUsd: 0.004 }),
    row({ id: "a3", userId: OWNER_A, at: new Date("2026-08-29T12:00:00Z"), complete: false, promptTokens: null, completionTokens: null }),
    row({ id: "b1", userId: OWNER_B, at: new Date("2026-08-29T13:00:00Z"), provider: "anthropic" }),
    row({ id: "n1", userId: null, feature: "sync-cron", at: new Date("2026-08-29T14:00:00Z"), provider: "google", requestBody: '{"q":"x"}', responseBody: '{"ok":true}' }),
  ];
});

const get = async (query = "") => {
  const res = await route.GET(new Request(`https://opengsc.test/api/provider-log${query}`));
  return { status: res.status, body: await res.json() as any };
};

const ids = (body: any) => body.rows.map((r: any) => r.id);

test("an unauthenticated request is refused", async () => {
  world.actor = null;
  const { status, body } = await get();
  assert.equal(status, 401);
  assert.equal(body.rows, undefined, "a refusal must not carry rows");
});

test("a member who may not read secrets is refused too", async () => {
  // The log holds captured prompts and what the owner was billed. It is not a dashboard.
  world.actor = { ownerId: OWNER_A, role: "editor" };
  const { status } = await get();
  assert.equal(status, 403);
});

test("a request never returns another workspace's rows", async () => {
  world.actor = { ownerId: OWNER_B, role: "owner" };
  const { body } = await get();
  assert.deepEqual(ids(body), ["b1"]);
});

test("userId: null rows go to the instance owner", async () => {
  const { body } = await get();
  assert.ok(ids(body).includes("n1"), "the instance owner cannot see the instance's own cron calls");
  assert.ok(!ids(body).includes("b1"), "the instance owner is not thereby every workspace's owner");
});

test("userId: null rows go to NO other workspace", async () => {
  // The leak this test exists for: a null row has no tenant key, so "show unattributed rows to
  // owners" means showing one instance-wide run's metadata — and its captured bodies — to every
  // workspace on the box.
  world.actor = { ownerId: OWNER_B, role: "owner" };
  const { body } = await get();
  assert.ok(!ids(body).includes("n1"));
  assert.equal(body.rows.filter((r: any) => r.userId === null).length, 0);
});

test("newest first", async () => {
  const { body } = await get();
  assert.deepEqual(ids(body), ["n1", "a3", "a2", "a1"]);
  assert.equal(world.lastFindMany.orderBy.at, "desc");
});

test("the page size is capped, whatever was asked for", async () => {
  const { body } = await get("?limit=5000");
  assert.ok(world.lastFindMany.take <= route.PAGE_SIZE_MAX, `take was ${world.lastFindMany.take}`);
  assert.ok(body.rows.length <= route.PAGE_SIZE_MAX);

  const junk = await get("?limit=not-a-number");
  assert.equal(junk.status, 200);
  assert.equal(world.lastFindMany.take, route.PAGE_SIZE_DEFAULT);
});

test("filters are checked against what the log actually holds, never interpolated", async () => {
  const ok = await get("?provider=serper");
  assert.deepEqual(ids(ok.body), ["a2"]);

  const byFeature = await get("?feature=rank-cron");
  assert.deepEqual(ids(byFeature.body), ["a2"]);

  // Not in the allowlist — and the allowlist is the set of values this caller can actually see.
  const bogus = await get("?provider=%27%20OR%201%3D1--");
  assert.equal(bogus.status, 400);
  const otherWorkspaces = await get("?provider=anthropic");
  assert.equal(otherWorkspaces.status, 400, "a provider only another workspace used is not a filter this one may name");
});

test("the facets name only providers and features this caller can see", async () => {
  world.actor = { ownerId: OWNER_B, role: "owner" };
  const { body } = await get();
  assert.deepEqual(body.providers, ["anthropic"]);
  assert.ok(!body.features.includes("sync-cron"), "the facet list leaked another tenant's features");
});

test("a null cost stays null, and an unfinished call stays unfinished", async () => {
  // The whole point of the cost constraint: `costUsd: null` means the provider stated nothing.
  // Coerced to 0 here it would render as $0.00 — a number that looks exactly like a fact.
  // `complete: false` is "we never saw this call finish", which is not an error either.
  const { body } = await get();
  const a3 = body.rows.find((r: any) => r.id === "a3");
  assert.equal(a3.costUsd, null);
  assert.equal(a3.complete, false);
  assert.equal(a3.error, null);
  assert.equal(a3.promptTokens, null);
  const a2 = body.rows.find((r: any) => r.id === "a2");
  assert.equal(a2.costUsd, 0.004);
});

test("the list carries no bodies; one row hands over its own", async () => {
  const { body } = await get();
  const n1 = body.rows.find((r: any) => r.id === "n1");
  assert.equal(n1.requestBody, undefined, "a list of fifty rows must not ship fifty prompts");
  assert.equal(n1.hasBodies, true);

  const one = await get("?id=n1");
  assert.equal(one.body.row.requestBody, '{"q":"x"}');
  assert.equal(one.body.row.responseBody, '{"ok":true}');
});

test("a row belonging to another workspace cannot be opened by id", async () => {
  world.actor = { ownerId: OWNER_B, role: "owner" };
  const guessed = await get("?id=n1");
  assert.equal(guessed.status, 404);
  const alsoGuessed = await get("?id=a1");
  assert.equal(alsoGuessed.status, 404);
});
