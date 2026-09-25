import assert from "node:assert/strict";
import test from "node:test";
import {
  toDiscordChunks, telegramToDiscordMarkdown, discordBody,
  toTeamsCard, toEmail, emailSubject,
  toWebhookBody, signWebhook, eventAllowed,
  isDiscordWebhookUrl, isTeamsWebhookUrl,
} from "./format";
import type { NotifyChannelsConfig } from "./types";

interface TeamsEnvelope {
  type: string;
  attachments: {
    contentType: string;
    content: {
      type: string;
      version: string;
      body: { type: string; text: string; weight?: string; wrap: boolean }[];
    };
  }[];
}

// ─── Discord ──────────────────────────────────────────────────────────────────

test("toDiscordChunks: 5000 chars of paragraphs → 3 chunks ≤ 2000, cut on paragraph boundaries", () => {
  // 25 paragraphs of 200 chars + blank lines = 25*202 ≈ 5050 chars.
  const paras = Array.from({ length: 25 }, (_, i) => `${String(i).padStart(2, "0")} ${"x".repeat(197)}`);
  const text = paras.join("\n\n");
  assert.ok(text.length > 5000);
  const chunks = toDiscordChunks(text);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.length <= 2000, `chunk ${c.length} > 2000`);
  // Cut on boundaries: every paragraph is 200 chars, so a chunk of n whole paragraphs joined by
  // "\n\n" is 202n − 2 long — length mod 202 must be 200, never a partial paragraph.
  for (const c of chunks) assert.equal(c.length % 202, 200);
  // Round-trip: joining chunks with the paragraph separator preserves all paragraphs.
  assert.equal(chunks.join("\n\n"), text);
});

test("toDiscordChunks: short text → one chunk", () => {
  assert.deepEqual(toDiscordChunks("hello"), ["hello"]);
});

test("toDiscordChunks: one pathological paragraph > 2000 is hard-cut", () => {
  const chunks = toDiscordChunks("y".repeat(4500));
  assert.equal(chunks.length, 3);
  assert.equal(chunks.reduce((n, c) => n + c.length, 0), 4500);
});

test("toDiscordChunks converts *bold* → **bold** and measures AFTER conversion", () => {
  // 10 bold pairs of 100 chars inside → each *x* gains 2 chars on conversion.
  const para = Array.from({ length: 10 }, () => "*" + "b".repeat(98) + "*").join(" ");
  const text = `${para}\n\n${para}\n\n${para}`;
  const chunks = toDiscordChunks(text);
  for (const c of chunks) {
    assert.ok(c.length <= 2000);
    assert.ok(!/\*[^*]+\*/.test(c.replace(/\*\*[^*]+\*\*/g, "")), "single-* markdown left");
  }
  assert.ok(chunks.every(c => c.includes("**")));
});

test("telegramToDiscordMarkdown: *x* → **x**, _x_ and links untouched", () => {
  assert.equal(telegramToDiscordMarkdown("*site* is _slow_ [link](https://a.b)"), "**site** is _slow_ [link](https://a.b)");
});

test("discordBody suppresses mention parsing", () => {
  assert.deepEqual(discordBody("hi @everyone"), { content: "hi @everyone", allowed_mentions: { parse: [] } });
});

// ─── Teams ────────────────────────────────────────────────────────────────────

test("toTeamsCard: Workflows envelope structure", () => {
  const card = toTeamsCard("🔴 *Title*", "*body* with [link](https://a.b)") as TeamsEnvelope;
  assert.equal(card.type, "message");
  assert.equal(card.attachments.length, 1);
  const a = card.attachments[0];
  assert.equal(a.contentType, "application/vnd.microsoft.card.adaptive");
  assert.equal(a.content.type, "AdaptiveCard");
  assert.equal(a.content.version, "1.4");
  const body = a.content.body;
  assert.equal(body.length, 2);
  assert.equal(body[0].type, "TextBlock");
  assert.equal(body[0].weight, "Bolder");
  assert.equal(body[0].wrap, true);
  assert.equal(body[1].type, "TextBlock");
  assert.equal(body[1].wrap, true);
  // Flat text: no Telegram-markdown survives into the card (the emoji stays).
  assert.equal(body[0].text, "🔴 Title");
  assert.equal(body[1].text, "body with link (https://a.b)");
});

// ─── E-mail ───────────────────────────────────────────────────────────────────

test("emailSubject: strips markdown, leading emoji, collapses spaces, ≤ 120 code points", () => {
  assert.equal(emailSubject("🔴 *Site* is down"), "Site is down");
  assert.equal(emailSubject("📰 [ label ](https://a.b) weekly"), "label weekly");
  assert.equal(emailSubject("a" + " ".repeat(10) + "b"), "a b");
  const long = emailSubject("📉 " + "с".repeat(300));
  assert.equal(Array.from(long).length, 120);
  assert.ok(long.startsWith("с"));
});

test("toEmail: <script> escaped, link becomes <a href>, <b>/<i>/<br> only", () => {
  const { subject, text, html } = toEmail("🔴 *Alert*", "*Site* <script>alert(1)</script>\n_line_ and [docs](https://a.b/x?y=1&z=2)");
  assert.equal(subject, "Alert");
  assert.equal(text, "Site <script>alert(1)</script>\nline and docs (https://a.b/x?y=1&z=2)");
  assert.ok(html.includes("<b>Site</b>"));
  assert.ok(!html.includes("<script>"), "raw <script> leaked into HTML");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("<i>line</i>"));
  assert.ok(html.includes('<a href="https://a.b/x?y=1&amp;z=2">docs</a>'));
  assert.ok(html.includes("<br>"));
  for (const tag of ["<img", "<style", "<p>", "<div"]) assert.ok(!html.includes(tag));
});

// ─── Webhook ──────────────────────────────────────────────────────────────────

test("toWebhookBody: exact field set, flat text vs markdown, ISO date, instance", () => {
  const raw = toWebhookBody("alert", "🔴 *Title*", "*body* [x](https://a.b)", "https://opengsc.example");
  const body = JSON.parse(raw);
  assert.deepEqual(Object.keys(body).sort(), ["createdAt", "event", "instance", "markdown", "text", "title"].sort());
  assert.equal(body.event, "alert");
  assert.equal(body.title, "🔴 *Title*");
  assert.equal(body.markdown, "*body* [x](https://a.b)");
  assert.equal(body.text, "body x (https://a.b)");
  assert.equal(body.instance, "https://opengsc.example");
  assert.ok(!Number.isNaN(Date.parse(body.createdAt)));
});

test("signWebhook: known vector (secret \"s\", body \"{}\")", () => {
  // echo -n '{}' | openssl dgst -sha256 -hmac 's'
  assert.equal(signWebhook("s", "{}"), "sha256=143ca8d517ba1b181025d732b1cf275d90104fca57bb02a565542978aa18c4b6");
  // Different body → different signature; prefix is part of the contract.
  assert.notEqual(signWebhook("s", "{}"), signWebhook("s", "{} "));
  assert.ok(signWebhook("k", "x").startsWith("sha256="));
});

// ─── Event filter ─────────────────────────────────────────────────────────────

test("eventAllowed: matrix", () => {
  // empty list = all events
  assert.equal(eventAllowed([], "alert"), true);
  assert.equal(eventAllowed([], "digest"), true);
  assert.equal(eventAllowed(undefined, "uptime"), true);
  // match / no match
  assert.equal(eventAllowed(["digest", "uptime"], "digest"), true);
  assert.equal(eventAllowed(["digest", "uptime"], "alert"), false);
  // "test" passes every filter, even a non-empty one that does not list it
  assert.equal(eventAllowed(["digest"], "test"), true);
  assert.equal(eventAllowed([], "test"), true);
  assert.equal(eventAllowed(undefined, "test"), true);
});

test("eventAllowed composes with the config shape", () => {
  const cfg: NotifyChannelsConfig = {
    discord: { on: true, events: [], url: "https://discord.com/api/webhooks/1/t" },
    teams: { on: true, events: ["uptime"], url: "https://x.logic.azure.com:443/workflows/w" },
    telegramEvents: ["alert"],
    slackEvents: [],
  };
  assert.equal(eventAllowed(cfg.discord?.events, "mention"), true);
  assert.equal(eventAllowed(cfg.teams?.events, "mention"), false);
  assert.equal(eventAllowed(cfg.telegramEvents, "digest"), false);
  assert.equal(eventAllowed(cfg.slackEvents, "digest"), true);
});

// ─── Save-time URL validation ─────────────────────────────────────────────────

test("isDiscordWebhookUrl: valid, foreign host, http", () => {
  assert.equal(isDiscordWebhookUrl("https://discord.com/api/webhooks/1234567890/AbC-_token9"), true);
  assert.equal(isDiscordWebhookUrl("https://discordapp.com/api/webhooks/1/x"), true);
  assert.equal(isDiscordWebhookUrl("https://hooks.slack.com/services/T00/B00/xxx"), false); // чужой хост
  assert.equal(isDiscordWebhookUrl("http://discord.com/api/webhooks/1/x"), false);          // http
  assert.equal(isDiscordWebhookUrl("https://evil.com/api/webhooks/123/tok"), false);        // чужой хост
  assert.equal(isDiscordWebhookUrl("https://discord.com.evil.com/api/webhooks/1/x"), false);// суффикс-обход
  assert.equal(isDiscordWebhookUrl("https://discord.com/api/webhooks/1"), false);           // нет токена
  assert.equal(isDiscordWebhookUrl("not a url"), false);
});

test("isTeamsWebhookUrl: Workflows hosts, foreign host, http", () => {
  assert.equal(isTeamsWebhookUrl("https://westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=XYZ"), true);
  assert.equal(isTeamsWebhookUrl("https://prod-xx.region.logic.azure.com:443/workflows/x/triggers/manual/paths/invoke"), true);
  assert.equal(isTeamsWebhookUrl("https://xxx.powerplatform.com/webhooks/y"), true);
  assert.equal(isTeamsWebhookUrl("https://xxx.powerautomate.com/webhooks/y"), true);
  assert.equal(isTeamsWebhookUrl("https://hooks.slack.com/services/x"), false);   // чужой хост
  assert.equal(isTeamsWebhookUrl("https://logic.azure.com.evil.com/wf"), false);  // суффикс-обход
  assert.equal(isTeamsWebhookUrl("http://westeurope.logic.azure.com:443/wf"), false); // http
  assert.equal(isTeamsWebhookUrl("https://outlook.office.com/webhook/xyz"), false);   // retired O365 connector
});
