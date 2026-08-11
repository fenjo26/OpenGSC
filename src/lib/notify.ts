
import { rawQuery } from "@/lib/db/raw";// Telegram delivery for alerts & digests. The user brings their own bot (created via
// @BotFather, token pasted in Settings → Notifications) — free, no third-party service,
// messages go straight from this server to Telegram's Bot API.
const TG = (token: string) => `https://api.telegram.org/bot${token}`;

// Telegram hard-caps messages at 4096 chars — split long digests on paragraph boundaries.
function chunks(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let buf = "";
  for (const para of text.split("\n\n")) {
    if ((buf + "\n\n" + para).length > max) {
      if (buf) out.push(buf);
      buf = para.length > max ? para.slice(0, max) : para;
    } else {
      buf = buf ? buf + "\n\n" + para : para;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export async function sendTelegram(botToken: string, chatId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    for (const part of chunks(text)) {
      const res = await fetch(`${TG(botToken)}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: part, parse_mode: "Markdown", disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        // Markdown parse errors are common with user data ("_" in URLs, etc.) — retry plain.
        if (String((d as any)?.description ?? "").includes("parse")) {
          const retry = await fetch(`${TG(botToken)}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: part, disable_web_page_preview: true }),
            signal: AbortSignal.timeout(15_000),
          });
          if (!retry.ok) return { ok: false, error: `telegram ${retry.status}` };
        } else {
          return { ok: false, error: (d as any)?.description ?? `telegram ${res.status}` };
        }
      }
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

// Find the chat id: the user sends /start (or any message) to their bot, we read getUpdates.
export async function detectChatId(botToken: string): Promise<{ chatId?: string; username?: string; error?: string }> {
  try {
    const res = await fetch(`${TG(botToken)}/getUpdates?limit=20`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { error: res.status === 401 ? "invalid_token" : `telegram ${res.status}` };
    const d = await res.json();
    const updates: any[] = Array.isArray(d?.result) ? d.result : [];
    for (let i = updates.length - 1; i >= 0; i--) {
      const msg = updates[i]?.message ?? updates[i]?.edited_message;
      const chat = msg?.chat;
      if (chat?.id) return { chatId: String(chat.id), username: chat.username ?? chat.first_name ?? "" };
    }
    return { error: "no_messages" };
  } catch (e: any) {
    return { error: String(e?.message ?? e).slice(0, 200) };
  }
}

// Server-side read of a user's Telegram credentials (raw SQL — see seoSettings convention).
export async function getTelegramCreds(userId: string): Promise<{ botToken: string; chatId: string } | null> {
  try {
    const rows: any[] = await rawQuery(
      `SELECT telegramBotToken, telegramChatId FROM "User" WHERE id = ?`, userId);
    const r = rows?.[0];
    if (!r?.telegramBotToken || !r?.telegramChatId) return null;
    return { botToken: r.telegramBotToken, chatId: r.telegramChatId };
  } catch {
    return null;
  }
}

export async function getSlackWebhook(userId: string): Promise<string | null> {
  try {
    const rows: any[] = await rawQuery(
      `SELECT slackWebhook FROM "User" WHERE id = ?`, userId);
    return rows?.[0]?.slackWebhook || null;
  } catch {
    return null;
  }
}

export function telegramToSlackMarkdown(text: string): string {
  // Replace **bold** with *bold*
  let out = text.replace(/\*\*(.*?)\*\*/g, "*$1*");
  // Replace [text](url) with <url|text>
  out = out.replace(/\[(.*?)\]\((.*?)\)/g, "<$2|$1>");
  return out;
}

export async function sendSlack(webhookUrl: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const target = new URL(webhookUrl);
    if (target.protocol !== "https:" || target.hostname.toLowerCase() !== "hooks.slack.com" || !target.pathname.startsWith("/services/")) {
      return { ok: false, error: "invalid_webhook_format" };
    }
    const slackText = telegramToSlackMarkdown(text);
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: slackText }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, error: `slack error ${res.status}: ${txt}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function notifyUser(userId: string, text: string): Promise<boolean> {
  const creds = await getTelegramCreds(userId);
  const slackUrl = await getSlackWebhook(userId);

  if (!creds && !slackUrl) return false;

  let ok = false;
  if (creds) {
    const r = await sendTelegram(creds.botToken, creds.chatId, text);
    if (r.ok) ok = true;
    else console.warn(`[notify] telegram send failed for user ${userId}: ${r.error}`);
  }
  if (slackUrl) {
    const r = await sendSlack(slackUrl, text);
    if (r.ok) ok = true;
    else console.warn(`[notify] slack send failed for user ${userId}: ${r.error}`);
  }
  return ok;
}
