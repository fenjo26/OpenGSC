// Pure formatting + validation for the wave-oct delivery channels (T3). No Prisma, no fetch —
// everything here is unit-tested with node:test (src/lib/notify/format.test.ts) and reused by
// channels.ts (transport) and notify.ts (fan-out).
//
// Input convention: notification text is Telegram-markdown, the dialect the notifyI18n.ts
// templates write — *bold*, _italic_, [label](url), blank-line-separated paragraphs.

import { createHmac } from "node:crypto";
import type { NotifyEvent } from "./types";

// ─── Markdown helpers ─────────────────────────────────────────────────────────

/** `[label](url)` → `label (url)` — the flat-text shape used by e-mail bodies and webhook `text`. */
function linksToFlat(text: string): string {
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)");
}

/** `[label](url)` → `label` — links become bare labels (subjects, Teams card titles). */
function linksToLabels(text: string): string {
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1");
}

/** Drop the `*`/`_` emphasis markers Telegram-markdown uses. */
function stripEmphasis(text: string): string {
  return text.replace(/(\*+|_+)/g, "");
}

/** Flat plain text: links spelled out, emphasis markers gone. */
export function toFlatText(text: string): string {
  return stripEmphasis(linksToFlat(text));
}

// ─── Discord ──────────────────────────────────────────────────────────────────

/** Telegram-markdown → Discord-markdown: `*x*` → `**x**` (italic `_x_` is valid in both). */
export function telegramToDiscordMarkdown(text: string): string {
  return text.replace(/\*([^*\n]+)\*/g, "**$1**");
}

/**
 * Discord caps a message at 2000 chars. Split on paragraph boundaries exactly the way
 * sendTelegram splits at 4096: accumulate `\n\n`-separated paragraphs, cut a pathological
 * single paragraph longer than the cap.
 */
export function toDiscordChunks(text: string, max = 2000): string[] {
  const converted = telegramToDiscordMarkdown(text);
  if (converted.length <= max) return [converted];
  const out: string[] = [];
  let buf = "";
  for (const para of converted.split("\n\n")) {
    if ((buf + "\n\n" + para).length > max) {
      if (buf) out.push(buf);
      buf = "";
      // A single paragraph longer than the cap has no boundary to cut on — hard-cut it,
      // keeping every char (a notification that silently drops its tail is worse).
      let p = para;
      while (p.length > max) { out.push(p.slice(0, max)); p = p.slice(max); }
      buf = p;
    } else {
      buf = buf ? buf + "\n\n" + para : para;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** The POST body for one Discord chunk — `allowed_mentions` so text saying `@everyone` pings nobody. */
export function discordBody(chunk: string): { content: string; allowed_mentions: { parse: string[] } } {
  return { content: chunk, allowed_mentions: { parse: [] } };
}

// ─── Teams ────────────────────────────────────────────────────────────────────

/**
 * Adaptive Card 1.4 in the envelope Teams "Workflows" (Power Automate) webhooks accept. The old
 * Office 365 connector format is retired by Microsoft — the hint key is notifyChTeamsHint.
 * Text is flat: Adaptive Card TextBlocks do not render Telegram-markdown.
 */
export function toTeamsCard(title: string, text: string): object {
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          { type: "TextBlock", text: stripEmphasis(linksToLabels(title)), weight: "Bolder", wrap: true },
          { type: "TextBlock", text: toFlatText(text), wrap: true },
        ],
      },
    }],
  };
}

// ─── E-mail ───────────────────────────────────────────────────────────────────

const EMOJI_LEAD = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D|\u20E3)+\s*/u;

/** Subject line: markdown stripped, leading emoji dropped, ≤ 120 chars (code points). */
export function emailSubject(title: string): string {
  const stripped = stripEmphasis(linksToLabels(title)).replace(EMOJI_LEAD, "");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  return Array.from(collapsed).slice(0, 120).join("");
}

/** Escape everything, then re-introduce the four tags e-mail clients are allowed to keep. */
export function emailHtml(text: string): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const br = (s: string) => escape(s).replace(/\n/g, "<br>");
  // Scan for the next markdown token anywhere in the text, escape the plain run before it, then
  // emit the tag. Untrusted text is therefore ALWAYS escaped before a tag is produced from it,
  // and only <b>, <i>, <a href> (http/https) and <br> ever leave this function — no images, no
  // styles: mail clients strip both and some flag them as phishing.
  const TOKEN = /(\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let html = "";
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    html += br(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("*")) html += `<b>${escape(tok.slice(1, -1))}</b>`;
    else if (tok.startsWith("_")) html += `<i>${escape(tok.slice(1, -1))}</i>`;
    else {
      const link = tok.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/)!;
      html += `<a href="${escape(link[2])}">${escape(link[1])}</a>`;
    }
    last = m.index + tok.length;
  }
  html += br(text.slice(last));
  return html;
}

export function toEmail(title: string, text: string): { subject: string; text: string; html: string } {
  return { subject: emailSubject(title), text: toFlatText(text), html: emailHtml(text) };
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

/**
 * The JSON body of a generic webhook notification. `markdown` keeps the original
 * Telegram-markdown, `text` is the flat form, `createdAt` is ISO, `instance` is this
 * deployment's public URL (NEXTAUTH_URL — the only base-URL env the project has).
 */
export function toWebhookBody(event: NotifyEvent, title: string, text: string, instance: string): string {
  return JSON.stringify({
    event,
    title,
    text: toFlatText(text),
    markdown: text,
    createdAt: new Date().toISOString(),
    instance,
  });
}

/** `sha256=` + hex HMAC-SHA256 of the raw body with the shared secret (X-OpenGSC-Signature). */
export function signWebhook(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

// ─── Event filter ─────────────────────────────────────────────────────────────

/**
 * Empty/missing list = every event. The "test" event bypasses every filter — a channel the user
 * is trying out must be reachable regardless of what it subscribed to.
 */
export function eventAllowed(events: NotifyEvent[] | undefined, event: NotifyEvent): boolean {
  if (event === "test") return true;
  if (!events || events.length === 0) return true;
  return events.includes(event);
}

// ─── Save-time URL validation (pure half; the DNS/private-address half is
// assertSafeTarget, called by channels.ts before any request) ─────────────────

function httpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Discord: https://discord.com/api/webhooks/… (or the legacy discordapp.com host). */
export function isDiscordWebhookUrl(raw: string): boolean {
  const url = httpsUrl(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (host !== "discord.com" && host !== "discordapp.com") return false;
  return /^\/api\/webhooks\/\d+\/[\w-]+$/.test(url.pathname);
}

/**
 * Teams Workflows (Power Automate): host ends with .logic.azure.com, .powerplatform.com or
 * .powerautomate.com. Checked against the current "Post to a channel when a webhook request is
 * received" template, whose generated URL is
 * https://<region>.logic.azure.com:443/workflows/<id>/triggers/manual/paths/invoke?api-version=…&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=<sig>
 * — the port and the signed query are part of the shape, so only the host suffix is asserted.
 * Deliberately NOT weakened to "any https": a generic POST target turns the feature into an
 * SSRF/spam relay with a Teams label on it.
 */
export function isTeamsWebhookUrl(raw: string): boolean {
  const url = httpsUrl(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return host.endsWith(".logic.azure.com") || host.endsWith(".powerplatform.com") || host.endsWith(".powerautomate.com");
}

/** Generic webhook: any https URL (the DNS/private-address check still applies at send time). */
export function isHttpsUrl(raw: string): boolean {
  return httpsUrl(raw) !== null;
}
