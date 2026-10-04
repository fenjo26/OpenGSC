import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateBrief, bonusFor, idempotencyKeyFor, POST_UNIT_MINOR, FieldLinkClient, FieldLinkError,
} from "./fieldlink";

// The money contract's client side: brief validation (bad input must die in OUR UI, not as a
// provider 400), the standing bonus math, idempotency key stability, and the error mapping a
// 409 PRICE_CHANGED / redirect / plain 4xx must produce.

const brief = (over: Partial<Parameters<typeof validateBrief>[0]> = {}) => ({
  targetUrl: "https://example.com/page",
  query: "casino bonus",
  language: "en",
  count: 5,
  ...over,
});

test("validateBrief accepts a clean brief and normalizes nothing away", () => {
  const b = validateBrief(brief());
  assert.equal(b.targetUrl, "https://example.com/page");
  assert.equal(b.anchor, "casino bonus"); // anchor defaults to the query
  assert.equal(b.titleKeyword, "casino bonus");
  assert.equal(b.count, 5);
});

test("validateBrief rejects the inputs the service would 400 on", () => {
  assert.throws(() => validateBrief(brief({ targetUrl: "" })), /row 1: missing target URL/);
  assert.throws(() => validateBrief(brief({ targetUrl: "notaurl" })), /not absolute/);
  assert.throws(() => validateBrief(brief({ targetUrl: "https://a.com/x https://b.com/y" })), /whitespace/);
  assert.throws(() => validateBrief(brief({ targetUrl: "ftp://a.com/x" })), /not http/);
  assert.throws(() => validateBrief(brief({ anchor: "<b>bold</b>" })), /HTML/);
  assert.throws(() => validateBrief(brief({ language: "xx" })), /not on the service list/);
  assert.throws(() => validateBrief(brief({ count: 0 })), /count must be an integer/);
  assert.throws(() => validateBrief(brief({ count: 251 })), /count must be an integer/);
  // The row index rides into the message so a 20-row batch names its offender.
  assert.throws(() => validateBrief(brief({ count: 0 }), 6), /row 7: count/);
});

test("bonusFor rounds the 25% service bonus up", () => {
  assert.equal(bonusFor(4), 1);
  assert.equal(bonusFor(5), 2); // 1.25 → 2: the service rounds up, so must any local estimate
  assert.equal(bonusFor(8), 2);
  assert.equal(bonusFor(0), 0);
  assert.equal(POST_UNIT_MINOR, 20);
});

test("idempotencyKeyFor is stable per payload and differs across payloads", () => {
  const a = idempotencyKeyFor({ topic: "x", items: [1, 2] });
  assert.equal(a, idempotencyKeyFor({ topic: "x", items: [1, 2] }));
  assert.notEqual(a, idempotencyKeyFor({ topic: "x", items: [2, 1] }));
  assert.ok(a.startsWith("ogsc-"));
});

test("validateBrief accepts a custom anchor distinct from the query — the ledger pair stays keyed by the query", () => {
  // Anchor presets (exact / diluted / URL / domain) send anchors that differ from the query;
  // the query (titleKeyword) is what the striking-side bought-pair marking matches on.
  const b = validateBrief(brief({ anchor: "https://example.com/page" }));
  assert.equal(b.anchor, "https://example.com/page");
  assert.equal(b.titleKeyword, "casino bonus");
  const d = validateBrief(brief({ anchor: "casino bonus – example.com" }));
  assert.equal(d.anchor, "casino bonus – example.com");
});

test("validateBrief caps anchors at 300 characters and names the row", () => {
  assert.throws(() => validateBrief(brief({ anchor: "x".repeat(301) }), 2), /row 3: anchor must be 1-300/);
});

// fetch mock: enough of Response for the client's error paths.
function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("FieldLinkClient maps 409 PRICE_CHANGED onto the code submit branches on", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => res(409, { code: "PRICE_CHANGED", message: "price moved" })) as typeof fetch;
  try {
    const c = new FieldLinkClient("tok");
    await assert.rejects(
      () => c.quote("t1"),
      (e: unknown) => e instanceof FieldLinkError && e.code === "PRICE_CHANGED" && e.status === 409,
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test("FieldLinkClient refuses to follow a redirect with the token attached", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })) as typeof fetch;
  try {
    const c = new FieldLinkClient("tok");
    await assert.rejects(
      () => c.balance(),
      (e: unknown) => e instanceof FieldLinkError && e.code === "REDIRECT",
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test("FieldLinkClient sends the expected-credits header on submit", async () => {
  const orig = globalThis.fetch;
  let seen: { url: string; headers: Record<string, string> } | null = null;
  globalThis.fetch = (async (input: any, init?: any) => {
    seen = { url: String(input), headers: init.headers };
    return res(200, { order: { id: "o1", rowCount: 5, completedCount: 0, failedCount: 0, status: "queued" } });
  }) as typeof fetch;
  try {
    const c = new FieldLinkClient("tok");
    const out = await c.submitOrder("t1", 100);
    assert.equal(out.order.id, "o1");
    assert.equal(seen!.headers["X-FieldLink-Expected-Credits"], "100");
    assert.ok(seen!.url.includes("/tasks/t1/orders"));
  } finally {
    globalThis.fetch = orig;
  }
});
