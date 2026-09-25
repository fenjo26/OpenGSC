
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
        if (String((d as { description?: string }).description ?? "").includes("parse")) {
          const retry = await fetch(`${TG(botToken)}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: part, disable_web_page_preview: true }),
            signal: AbortSignal.timeout(15_000),
          });
          if (!retry.ok) return { ok: false, error: `telegram ${retry.status}` };
        } else {
          return { ok: false, error: (d as { description?: string }).description ?? `telegram ${res.status}` };
        }
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

// Find the chat id: the user sends /start (or any message) to their bot, we read getUpdates.
export async function detectChatId(botToken: string): Promise<{ chatId?: string; username?: string; error?: string }> {
  try {
    const res = await fetch(`${TG(botToken)}/getUpdates?limit=20`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { error: res.status === 401 ? "invalid_token" : `telegram ${res.status}` };
    const d = await res.json();
    const updates = (Array.isArray(d?.result) ? d.result : []) as {
      message?: { chat?: { id?: number; username?: string; first_name?: string } };
      edited_message?: { chat?: { id?: number; username?: string; first_name?: string } };
    }[];
    for (let i = updates.length - 1; i >= 0; i--) {
      const msg = updates[i]?.message ?? updates[i]?.edited_message;
      const chat = msg?.chat;
      if (chat?.id) return { chatId: String(chat.id), username: chat.username ?? chat.first_name ?? "" };
    }
    return { error: "no_messages" };
  } catch (e) {
    return { error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

// Server-side read of a user's Telegram credentials (raw SQL — see seoSettings convention).
export async function getTelegramCreds(userId: string): Promise<{ botToken: string; chatId: string } | null> {
  try {
    const rows = await rawQuery<{ telegramBotToken?: string; telegramChatId?: string }[]>(
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
    const rows = await rawQuery<{ slackWebhook?: string }[]>(
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
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

export async function notifyUser(
  userId: string,
  text: string,
  // Wave-oct T3: without opts the event is "alert", so every existing two-argument caller keeps
  // its exact semantics. With opts, each channel's event filter (empty = all; "test" passes all)
  // decides whether it participates.
  opts?: import("@/lib/notify/types").NotifyOptions,
): Promise<boolean> {
  const deliveries = await notifyUserDetailed(userId, text, opts);
  return deliveries.some(d => d.ok);
}

// Wave-oct (CONTRACT.md §3): per-channel delivery detail. Fan-out is parallel (Promise.allSettled)
// so one failing channel never breaks the others; true/ok when at least one delivered.
export async function notifyUserDetailed(
  userId: string,
  text: string,
  opts?: import("@/lib/notify/types").NotifyOptions,
): Promise<import("@/lib/notify/types").NotifyDelivery[]> {
  const { readChannels, deliverStoredChannel, updateDeliveryStatus } = await import("@/lib/notify/channels");
  const { eventAllowed } = await import("@/lib/notify/format");
  const event: import("@/lib/notify/types").NotifyEvent = opts?.event ?? "alert";
  const title = (opts?.title ?? text.split("\n")[0] ?? text).slice(0, 500);

  // Raw SQL read (getSlackWebhook convention): a missing notifyChannels column on a not-yet-
  // migrated instance returns {} and delivery degrades to Telegram + Slack, as before.
  const cfg = await readChannels(userId);
  const creds = await getTelegramCreds(userId);
  const slackUrl = await getSlackWebhook(userId);

  type Job = { channel: import("@/lib/notify/types").NotifyChannelId; run: () => Promise<{ ok: boolean; error?: string }> };
  const jobs: Job[] = [];
  // Telegram/Slack have no `on` switch — configured means on; their event filters live in the
  // shared config (telegramEvents / slackEvents).
  if (creds && eventAllowed(cfg.telegramEvents, event)) {
    jobs.push({ channel: "telegram", run: () => sendTelegram(creds.botToken, creds.chatId, text) });
  }
  if (slackUrl && eventAllowed(cfg.slackEvents, event)) {
    jobs.push({ channel: "slack", run: () => sendSlack(slackUrl, text) });
  }
  for (const id of ["discord", "teams", "email", "webhook"] as const) {
    const ch = cfg[id];
    if (!ch || !ch.on) continue;
    if (!eventAllowed(ch.events, event)) continue;
    jobs.push({ channel: id, run: () => deliverStoredChannel(cfg, id, event, title, text) });
  }
  if (!jobs.length) return [];

  const settled = await Promise.allSettled(jobs.map(j => j.run()));
  const results: import("@/lib/notify/types").NotifyDelivery[] = settled.map((s, i) => {
    if (s.status === "fulfilled") {
      if (s.value.ok) return { channel: jobs[i].channel, ok: true };
      console.warn(`[notify] ${jobs[i].channel} send failed for user ${userId}: ${s.value.error}`);
      return { channel: jobs[i].channel, ok: false, error: s.value.error };
    }
    console.warn(`[notify] ${jobs[i].channel} threw for user ${userId}:`, s.reason);
    return { channel: jobs[i].channel, ok: false, error: String((s.reason as Error)?.message ?? s.reason).slice(0, 200) };
  });
  // One raw UPDATE for the whole call, merging only lastOkAt/lastError into a fresh read.
  await updateDeliveryStatus(userId, results);
  return results;
}
