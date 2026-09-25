// N10 — tests for the pure push logic (docs/tasks/wave-nov/N10-pwa-push.md):
// payload building (trim, markdown strip, URL by event) and the subscription rules
// (event filter; delete on 404/410 and after 5 consecutive failures).
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPushPayload, stripMarkdown, matchSiteDomain, hostnameOf, parseEventsFilter, MAX_BODY_CHARS, MAX_TITLE_CHARS,
} from "./payload";
import { subscriptionAllows, outcomeForAttempt, isGoneStatus, MAX_CONSECUTIVE_FAILURES } from "./subscription";

// ─── payload ──────────────────────────────────────────────────────────────────

test("stripMarkdown flattens bold, links, code, headers and bullets", () => {
  const src = "## Heading\n**bold** and `code`\n[OpenGSC](https://opengsc.dev) and __under__\n* one\n• two";
  assert.equal(
    stripMarkdown(src),
    "Heading\nbold and code\nOpenGSC and under\n- one\n- two",
  );
});

test("buildPushPayload: title from the text's first line is not repeated in the body", () => {
  const p = buildPushPayload({ title: "", text: "⚠️ example.com: traffic drop\n\nClicks fell 40% today.", event: "alert" });
  assert.equal(p.title, "⚠️ example.com: traffic drop");
  assert.equal(p.body, "Clicks fell 40% today.");
  assert.equal(p.url, "/");
});

test("buildPushPayload: explicit title wins and the full text becomes the body", () => {
  const p = buildPushPayload({ title: "Digest", text: "line one\nline two", event: "digest" });
  assert.equal(p.title, "Digest");
  assert.equal(p.body, "line one\nline two");
});

test("buildPushPayload: body is capped at MAX_BODY_CHARS with an ellipsis, no markdown inside", () => {
  const long = `**${"x".repeat(600)}**`;
  const p = buildPushPayload({ title: "t", text: long, event: "alert" });
  assert.ok(p.body.length <= MAX_BODY_CHARS);
  assert.ok(!p.body.includes("**"));
  assert.ok(p.body.endsWith("…"));
});

test("buildPushPayload: title is capped too", () => {
  const p = buildPushPayload({ title: "y".repeat(500), text: "body", event: "alert" });
  assert.ok(p.title.length <= MAX_TITLE_CHARS);
});

test("buildPushPayload: URL by event — lead opens /leads, the rest the dashboard, explicit url wins", () => {
  assert.equal(buildPushPayload({ title: "t", text: "b", event: "lead" }).url, "/leads");
  assert.equal(buildPushPayload({ title: "t", text: "b", event: "uptime" }).url, "/");
  assert.equal(buildPushPayload({ title: "t", text: "b", event: "alert", url: "/site/42" }).url, "/site/42");
});

test("buildPushPayload: markdown link in the body keeps only its text", () => {
  const p = buildPushPayload({ title: "t", text: "See [the report](https://x.dev/r) now", event: "digest" });
  assert.equal(p.body, "See the report now");
});

// ─── alert → /site/<id> domain matching ───────────────────────────────────────

test("matchSiteDomain: longest domain wins so a subdomain is not stolen by its parent", () => {
  const sites = [
    { id: "parent", domain: "example.com" },
    { id: "blog", domain: "blog.example.com" },
  ];
  assert.equal(matchSiteDomain("📉 blog.example.com: clicks up", sites), "blog");
  assert.equal(matchSiteDomain("📉 example.com: clicks up", sites), "parent");
  assert.equal(matchSiteDomain("no site here", sites), null);
  assert.equal(matchSiteDomain("anything", []), null);
});

test("matchSiteDomain is case-insensitive and ignores www.", () => {
  const sites = [{ id: "s1", domain: "WWW.Example.COM" }];
  assert.equal(matchSiteDomain("check example.com today", sites), "s1");
});

test("hostnameOf parses url properties, sc-domain roots and bare hosts; rejects junk", () => {
  assert.equal(hostnameOf("https://a.example.com/x?y=1"), "a.example.com");
  assert.equal(hostnameOf("sc-domain:example.gr"), "example.gr");
  assert.equal(hostnameOf("example.org/path"), "example.org");
  assert.equal(hostnameOf("https://example.org:8080/"), "example.org");
  assert.equal(hostnameOf("not a host"), "");
  assert.equal(hostnameOf(""), "");
});

test("parseEventsFilter keeps only known events", () => {
  assert.deepEqual(parseEventsFilter("alert, uptime, bogus"), ["alert", "uptime"]);
  assert.deepEqual(parseEventsFilter(""), []);
  assert.deepEqual(parseEventsFilter(",,,")!, []);
});

// ─── per-subscription rules ───────────────────────────────────────────────────

test("subscriptionAllows: empty filter = all events, unknown values are literal, test bypasses", () => {
  assert.equal(subscriptionAllows("", "alert"), true);
  assert.equal(subscriptionAllows("   ", "digest"), true);
  assert.equal(subscriptionAllows("alert,uptime", "digest"), false);
  assert.equal(subscriptionAllows("alert, uptime", "uptime"), true);
  assert.equal(subscriptionAllows("alert", "test"), true); // trying a channel out must reach it
});

test("404/410 delete the subscription immediately; other statuses count failures", () => {
  assert.ok(isGoneStatus(404));
  assert.ok(isGoneStatus(410));
  assert.ok(!isGoneStatus(500));
  assert.ok(!isGoneStatus(null));

  assert.deepEqual(outcomeForAttempt({ ok: false, statusCode: 404, failures: 0 }), { action: "delete", reason: "gone" });
  assert.deepEqual(outcomeForAttempt({ ok: false, statusCode: 410, failures: 2 }), { action: "delete", reason: "gone" });
  assert.deepEqual(outcomeForAttempt({ ok: false, statusCode: 500, failures: 0 }), { action: "count_failure" });
  assert.deepEqual(outcomeForAttempt({ ok: false, statusCode: null, failures: 3 }), { action: "count_failure" });
});

test("five consecutive failures delete the subscription; success resets it first", () => {
  assert.equal(MAX_CONSECUTIVE_FAILURES, 5);
  assert.deepEqual(outcomeForAttempt({ ok: false, statusCode: 500, failures: 4 }), { action: "delete", reason: "too_many_failures" });
  assert.deepEqual(outcomeForAttempt({ ok: true, statusCode: null, failures: 4 }), { action: "mark_ok" });
  // failures counts PAST attempts; +1 makes five only from four.
  assert.deepEqual(outcomeForAttempt({ ok: false, statusCode: 500, failures: 3 }), { action: "count_failure" });
});
