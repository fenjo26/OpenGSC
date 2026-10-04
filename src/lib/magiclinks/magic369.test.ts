import { test } from "node:test";
import assert from "node:assert/strict";

import { Magic369Client, Magic369Error, toMagic369Rows } from "./magic369";

// 369Team's client has three things worth pinning: tokens arrive as decimals and must become
// minor units without floating-point drift, order rows must carry EXACTLY the fields the API
// accepts (anything extra is a 400), and language codes must leave as human names.

function res(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("balance maps decimal tokens into minor units exactly", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => res(200, { balance: 12.34, price_per_placement: 0.2, currency: "tokens" })) as typeof fetch;
  try {
    const b = await new Magic369Client("tok").balance();
    assert.equal(b.balanceMinor, 1234);
    assert.equal(b.priceMinor, 20); // 0.2 tokens = 20 minor — the per-post price the UI shows
  } finally {
    globalThis.fetch = orig;
  }
});

test("createOrder sends only the four fields the API accepts, languages as names", async () => {
  const orig = globalThis.fetch;
  let sent: unknown = null;
  globalThis.fetch = (async (_input: any, init?: any) => {
    sent = JSON.parse(init.body);
    return res(200, { order_id: "o9", status: "queued", total_count: 5, total_price: 1, price_per_placement: 0.2, balance: 11.34 });
  }) as typeof fetch;
  try {
    const created = await new Magic369Client("tok").createOrder(
      toMagic369Rows([{ targetUrl: "https://a.com/x", anchor: "bonus", language: "ru", count: 5 }]),
    );
    assert.deepEqual(sent, [{ url: "https://a.com/x", anchor: "bonus", language: "Русский", count: 5 }]);
    assert.equal(created.orderId, "o9");
    assert.equal(created.totalPriceMinor, 100);
    assert.equal(created.balanceAfterMinor, 1134);
  } finally {
    globalThis.fetch = orig;
  }
});

test("order status maps the progress counters out of snake_case", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => res(200, {
    order_id: "o9", status: "processing", price_per_placement: 0.2, total_price: 1,
    progress: { total: 5, published: 2, in_progress: 2, awaiting_content: 1, failed: 0, remaining: 3 },
    items: [{ url: "https://a.com/x", anchor: "bonus", language: "Русский", count: 5, published: 2, in_progress: 2, awaiting_content: 1, failed: 0 }],
  })) as typeof fetch;
  try {
    const o = await new Magic369Client("tok").order("o9");
    assert.equal(o.progress.total, 5);
    assert.equal(o.progress.published, 2);
    assert.equal(o.progress.remaining, 3);
    assert.equal(o.items[0].awaitingContent, 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test("error payloads surface the vendor's nested error shape", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => res(402, { error: { code: "insufficient_balance", message: "not enough tokens" } })) as typeof fetch;
  try {
    await assert.rejects(
      () => new Magic369Client("tok").balance(),
      (e: unknown) => e instanceof Magic369Error && e.code === "insufficient_balance" && e.status === 402,
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test("toMagic369Rows refuses a language the service does not know", () => {
  assert.throws(() => toMagic369Rows([{ targetUrl: "https://a.com", anchor: "x", language: "xx", count: 1 }]), /not on the service list/);
});
