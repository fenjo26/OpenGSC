import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Magic369Client, Magic369Error, toMagic369Rows, toMagic369LinkRows, articlePriceFor, normalizeTiers,
  estimateBonus, linkRowProblem, quoteArticles, quoteLinks, type Magic369Balance,
} from "./magic369";

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

test("balance reads the volume tiers and the flat link price (spec v1.1)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => res(200, {
    balance: 100, currency: "tokens", price_per_placement: 0.45, link_price: 3,
    price_tiers: [{ from: 2000, price: 0.15 }, { from: 1, price: 0.45 }, { from: 100, price: 0.3 }],
  })) as typeof fetch;
  try {
    const b = await new Magic369Client("tok").balance();
    assert.deepEqual(b.tiers, [{ from: 1, priceMinor: 45 }, { from: 100, priceMinor: 30 }, { from: 2000, priceMinor: 15 }]);
    assert.equal(b.linkPriceMinor, 300);
  } finally {
    globalThis.fetch = orig;
  }
});

test("the tier is picked by the WHOLE order's paid count: largest from not exceeding it", () => {
  const tiers = normalizeTiers([{ from: 1, price: 0.45 }, { from: 100, price: 0.3 }, { from: 2000, price: 0.15 }], 45);
  assert.equal(articlePriceFor(tiers, 1), 45);
  assert.equal(articlePriceFor(tiers, 99), 45);
  assert.equal(articlePriceFor(tiers, 100), 30);
  assert.equal(articlePriceFor(tiers, 1999), 30);
  assert.equal(articlePriceFor(tiers, 5000), 15);
  // no tier list (older API) → one tier at price_per_placement, never a zero quote
  assert.deepEqual(normalizeTiers(undefined, 45), [{ from: 1, priceMinor: 45 }]);
});

test("quoteArticles sums rows before choosing the tier; bonus is +30% per row, rounded down", () => {
  const bal: Magic369Balance = {
    balanceMinor: 100000, priceMinor: 45, currency: "tokens", linkPriceMinor: 300,
    tiers: [{ from: 1, priceMinor: 45 }, { from: 100, priceMinor: 30 }],
  };
  const q = quoteArticles(bal, [60, 50]); // 110 paid → the 100+ tier for the whole order
  assert.equal(q.paid, 110);
  assert.equal(q.priceMinor, 30);
  assert.equal(q.amountMinor, 3300);
  assert.equal(q.bonus, 18 + 15);
  const l = quoteLinks(bal, [5, 3]);
  assert.ok(l);
  assert.equal(l.amountMinor, 2400);
  assert.equal(l.bonus, 1 + 0); // +20%: 5 → 1, 3 → 0.6 → 0
  assert.equal(quoteLinks({ ...bal, linkPriceMinor: null }, [1]), null);
  assert.equal(estimateBonus(10, 0.3), 3);
});

test("createOrder sends only the four fields the API accepts, languages as names", async () => {
  const orig = globalThis.fetch;
  let sent: unknown = null;
  globalThis.fetch = (async (_input: any, init?: any) => {
    sent = JSON.parse(init.body);
    return res(201, { order_id: "o9", status: "awaiting_content", total_count: 5, bonus_count: 1, total_price: 1, price_per_placement: 0.2, balance: 11.34 });
  }) as typeof fetch;
  try {
    const created = await new Magic369Client("tok").createOrder(
      toMagic369Rows([{ targetUrl: "https://a.com/x", anchor: "bonus", language: "ru", count: 5 }]),
    );
    assert.deepEqual(sent, [{ url: "https://a.com/x", anchor: "bonus", language: "Русский", count: 5 }]);
    assert.equal(created.orderId, "o9");
    assert.equal(created.totalPriceMinor, 100);
    assert.equal(created.balanceAfterMinor, 1134);
    assert.equal(created.bonusCount, 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test("language codes leave as the names the spec spells: English exonyms, Russian in Cyrillic", () => {
  const rows = toMagic369Rows(["en", "de", "nl", "ru", "es", "el"].map(language => ({ targetUrl: "https://a.com", anchor: "x", language, count: 1 })));
  assert.deepEqual(rows.map(r => r.language), ["English", "German", "Dutch", "Русский", "Spanish", "Greek"]);
});

test("createLinkOrder posts to /link-orders; text only when it wraps the link", async () => {
  const orig = globalThis.fetch;
  let sentUrl = "";
  let sent: unknown = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sentUrl = String(input);
    sent = JSON.parse(String(init?.body));
    return res(201, { order_id: "L1", status: "queued", total_count: 7, bonus_count: 1, total_price: 21, price_per_placement: 3, balance: 79 });
  }) as typeof fetch;
  try {
    const rows = toMagic369LinkRows([
      { targetUrl: "https://a.com/x", anchor: "best casino", count: 5, text: "See $LINK for details" },
      { targetUrl: "https://a.com/y", anchor: "a.com", count: 2, text: "$LINK" },
    ]);
    const created = await new Magic369Client("tok").createLinkOrder(rows);
    assert.ok(sentUrl.endsWith("/link-orders"));
    assert.deepEqual(sent, [
      { url: "https://a.com/x", anchor: "best casino", count: 5, text: "See $LINK for details" },
      { url: "https://a.com/y", anchor: "a.com", count: 2 },
    ]);
    assert.equal(created.orderId, "L1");
    assert.equal(created.totalPriceMinor, 2100);
  } finally {
    globalThis.fetch = orig;
  }
});

test("link rows the service would refuse are refused here, with the row number", () => {
  assert.equal(linkRowProblem({ anchor: "ok", text: "" }), null);
  assert.match(linkRowProblem({ anchor: "x".repeat(201) }) ?? "", /200/);
  assert.match(linkRowProblem({ anchor: "<b>x</b>" }) ?? "", /< or >/);
  assert.match(linkRowProblem({ anchor: "ok", text: "no placeholder" }) ?? "", /exactly once/);
  assert.match(linkRowProblem({ anchor: "ok", text: "$LINK and $LINK" }) ?? "", /exactly once/);
  assert.match(linkRowProblem({ anchor: "ok", text: "lower $link" }) ?? "", /exactly once/);
  assert.match(linkRowProblem({ anchor: "ok", text: "a\tb $LINK" }) ?? "", /one line/);
  assert.throws(() => toMagic369LinkRows([{ targetUrl: "https://a.com", anchor: "ok", count: 1 }, { targetUrl: "https://a.com", anchor: "ok", count: 1, text: "nope" }]), /row 2/);
});

test("order status maps the progress counters out of snake_case", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => res(200, {
    order_id: "o9", status: "in_progress", price_per_placement: 0.2, total_price: 1, total_count: 5, bonus_count: 1, refunded: 0.4,
    progress: { total: 6, published: 2, in_progress: 2, awaiting_content: 1, failed: 0, remaining: 4 },
    items: [{ url: "https://a.com/x", anchor: "bonus", language: "Русский", count: 5, bonus_count: 1, published: 2, in_progress: 2, awaiting_content: 1, failed: 0 }],
  })) as typeof fetch;
  try {
    const o = await new Magic369Client("tok").order("o9");
    assert.equal(o.progress.total, 6); // bonus included, per spec
    assert.equal(o.progress.published, 2);
    assert.equal(o.progress.remaining, 4);
    assert.equal(o.totalCount, 5);
    assert.equal(o.bonusCount, 1);
    assert.equal(o.refundedMinor, 40);
    assert.equal(o.items[0].awaitingContent, 1);
    assert.equal(o.items[0].bonusCount, 1);
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
