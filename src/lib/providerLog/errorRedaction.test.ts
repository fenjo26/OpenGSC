// The `error` column is the third place a secret can reach the database, and it was the one left
// open.
//
// `requestBody` and `responseBody` go through `redact`. `error` did not: it was copied to the row
// verbatim, and almost every value it ever holds is derived from provider-controlled text —
// `extractErrorDetail` in llm.ts hands back `{error:{message}}` or, failing that, the raw body;
// demand.ts and serp.ts slice the response text straight into it; the XML River key check copies
// `data.error`. A gateway that rejects a credential and echoes it back — in the message, or in a
// URL quoted inside the message — therefore had its body redacted and the identical text stored
// in the clear beside it, and served by the log view.
//
// So these assertions are made on the ROW, through the real write path, not on the sanitizer.
// Calling `redactText` directly would prove the function works while the column stayed wide open,
// which is exactly the shape of the bug being fixed.
//
// The last test is the one that keeps the rest honest. An `error` nobody can read tells an
// operator nothing about why a call failed, and a sanitizer that eats ordinary provider prose has
// destroyed the column's only purpose to close a hole in it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { flushProviderLog, loggedFetch, startProviderCall, __rows, __setWriterForTests } from "./log";

async function errorOnRow(error: string): Promise<string> {
  __setWriterForTests();
  startProviderCall({ provider: "openai", endpoint: "https://api.example.com/v1/chat" }).finish({ error });
  await flushProviderLog();
  return String(__rows()[0].error);
}

test("a key in a shape no vendor list knows is still stripped out of error", async () => {
  // The point of the pair check: the value here matches none of the vendor prefixes, and is
  // caught only because the NAME beside it is credential-shaped. A vendor-shape pass alone would
  // have written this to the database.
  const out = await errorOnRow("xmlriver 401: bad credentials (api_key=QWERTYUIOP1234567890, user=42)");
  assert.ok(!out.includes("QWERTYUIOP1234567890"), out);
  assert.match(out, /\[redacted\]/);
});

test("a key echoed back as a JSON fragment inside the message is stripped too", async () => {
  // `extractErrorDetail` falls back to the raw body when it is not the shape it expects, so a
  // gateway that echoes the request it rejected puts a whole JSON object into `error`.
  const out = await errorOnRow(`zai 403: rejected request {"x-api-key": "CUSTOM-9911-NOT-A-VENDOR-SHAPE"}`);
  assert.ok(!out.includes("CUSTOM-9911-NOT-A-VENDOR-SHAPE"), out);
  assert.match(out, /\[redacted\]/);
});

test("a credential-bearing URL quoted in error loses its query string", async () => {
  // How Gemini's key travels, and XML River's. `safeEndpoint` strips the query from the endpoint
  // column; nothing was stripping it from a URL a provider quoted back at us in its message.
  const out = await errorOnRow(
    "xmlriver 401: request https://xmlriver.com/search_console/json/?user=42&key=SUPERSECRETKEY9911 was rejected",
  );
  assert.ok(!out.includes("SUPERSECRETKEY9911"), out);
  assert.ok(out.includes("https://xmlriver.com/search_console/json/"), out);
});

test("a vendor-shaped key loose in the prose is stripped, as it is in a body", async () => {
  const out = await errorOnRow("openai 401: Incorrect API key provided: sk-live-9f3a2b7c8d1e4f5a6b7c");
  assert.ok(!out.includes("sk-live-9f3a2b7c8d1e4f5a6b7c"), out);
});

test("the transport-failure row sanitizes its error the same way", async () => {
  // `loggedFetch` writes that row itself, from the thrown error's message. It is a second way
  // into the same column and must not be a way around the sanitizer.
  __setWriterForTests();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED via https://proxy.internal/out?token=PROXYSECRET9911");
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(loggedFetch("https://api.example.com/v1", {}, { provider: "openai" }));
    await flushProviderLog();
    const out = String(__rows()[0].error);
    assert.ok(!out.includes("PROXYSECRET9911"), out);
    assert.match(out, /ECONNREFUSED/);
  } finally { globalThis.fetch = original; }
});

test("an ordinary provider message survives readable — over-redaction is the other failure", async () => {
  // Everything the operator actually reads the column for: who failed, with what status, why,
  // and what to do. If any of this comes back blanked the column has stopped being worth having.
  const message =
    "openai 429: Rate limit reached for gpt-5 in organization org-acme on tokens per min (TPM): "
    + "Limit 30000, Used 29997, Requested 12. Please try again in 18ms.";
  assert.equal(await errorOnRow(message), message);
});

test("a null error stays null rather than becoming the string \"null\"", async () => {
  // A row whose call succeeded must read as no error at all; "null" in the column would show on
  // screen as a failure that never happened.
  __setWriterForTests();
  startProviderCall({ provider: "openai", endpoint: "https://x/y" }).finish({ error: null });
  await flushProviderLog();
  assert.equal(__rows()[0].error, null);
});
