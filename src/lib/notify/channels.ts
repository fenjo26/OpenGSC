// Wave-oct T3 — delivery channels beyond Telegram/Slack: Discord, Microsoft Teams (Workflows),
// SMTP e-mail and a signed generic webhook.
//
// Storage: User.notifyChannels (String column holding NotifyChannelsConfig JSON — SQLite has no
// Json type). Read/written with raw SQL exactly like getSlackWebhook: the column may be missing
// on an instance that pulled the code but did not run `prisma db push`, and that must degrade to
// "only Telegram and Slack", never crash a notification.
//
// SSRF: every user-supplied URL/host passes assertSafeTarget (safeFetch.ts) BEFORE any request.
// safeFetch itself only does GET/HEAD, so the actual send is a plain fetch with
// redirect:"manual" — a 3xx is an error, otherwise a 302 would silently defeat the address
// check. Bodies are capped at 64 KB and each request at 10 s.

import nodemailer from "nodemailer";
import { assertSafeTarget, SafeFetchError } from "@/lib/security/safeFetch";
import { rawQuery, rawExec } from "@/lib/db/raw";
import { getTelegramCreds, getSlackWebhook, sendTelegram, sendSlack } from "@/lib/notify";
import { getAlertSettings } from "@/lib/alertScheduler";
import { NOTIFY_L, normalizeLang } from "@/lib/notifyI18n";
import { pushChannelSummary, sendWorkspacePush } from "@/lib/push";
import {
  toDiscordChunks, discordBody, toTeamsCard, toEmail, toWebhookBody, signWebhook,
  isDiscordWebhookUrl, isTeamsWebhookUrl, isHttpsUrl,
} from "./format";
import type {
  NotifyChannelId, NotifyChannelView, NotifyChannelsConfig, NotifyDelivery, NotifyEvent,
} from "./types";
import { NOTIFY_EVENTS } from "./types";

/** The four channels whose whole config (secrets included) lives in User.notifyChannels.
 *  wave-nov (N0): webpush widened NotifyChannelId but is NOT a stored channel — its
 *  subscriptions live in the PushSubscription table (N10) — so it is excluded here. */
export type StoredChannelId = Exclude<NotifyChannelId, "telegram" | "slack" | "webpush">;
const STORED_IDS: readonly StoredChannelId[] = ["discord", "teams", "email", "webhook"];

const HTTP_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;
/** Cap the payload text before it is embedded (email html+text, webhook text+markdown). */
const MAX_TEXT_CHARS = 28_000;

/** Coded failure surfaced to the API as `{ error: code }` — codes are notifyChErr_* i18n keys. */
export class ChannelError extends Error {
  constructor(public readonly code: string) { super(code); }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** This deployment's public URL — NEXTAUTH_URL is the only base-URL env the project defines. */
export function instanceUrl(): string {
  return (process.env.NEXTAUTH_URL || "").trim().replace(/\/+$/, "");
}

// ─── Config storage ───────────────────────────────────────────────────────────

/** Read User.notifyChannels; missing column / corrupt JSON → {} (Telegram+Slack only). */
export async function readChannels(userId: string): Promise<NotifyChannelsConfig> {
  try {
    const rows = await rawQuery<{ notifyChannels?: string | null }[]>(`SELECT notifyChannels FROM "User" WHERE id = ?`, userId);
    const raw = rows?.[0]?.notifyChannels;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeChannels(userId: string, cfg: NotifyChannelsConfig): Promise<void> {
  await rawExec(`UPDATE "User" SET notifyChannels = ? WHERE id = ?`, JSON.stringify(cfg), userId);
}

/** Re-read the fresh JSON and merge ONLY lastOkAt/lastError — one UPDATE per delivery call,
 *  so a concurrent settings save never loses its fields and vice versa. Best-effort. */
export async function updateDeliveryStatus(userId: string, results: NotifyDelivery[]): Promise<void> {
  const touched = results.filter(r => (STORED_IDS as readonly string[]).includes(r.channel));
  if (!touched.length) return;
  try {
    const rows = await rawQuery<{ notifyChannels?: string | null }[]>(`SELECT notifyChannels FROM "User" WHERE id = ?`, userId);
    const raw = rows?.[0]?.notifyChannels;
    if (!raw) return;
    const cfg: NotifyChannelsConfig = JSON.parse(raw);
    const now = new Date().toISOString();
    let changed = false;
    for (const r of touched) {
      const ch = cfg[r.channel as StoredChannelId];
      if (!ch) continue;
      if (r.ok) { ch.lastOkAt = now; ch.lastError = null; }
      else ch.lastError = (r.error ?? "error").slice(0, 300);
      changed = true;
    }
    if (changed) await writeChannels(userId, cfg);
  } catch { /* column not migrated, or lost a write race — status is best-effort */ }
}

// ─── Views (secrets masked, never sent to the browser raw) ───────────────────

function maskWebhookUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const segs = u.pathname.split("/").filter(Boolean);
    if (!segs.length) return `${u.origin}/…`;
    const head = segs.slice(0, -1).map(s => (s.length > 12 ? `${s.slice(0, 8)}…` : s)).join("/");
    return `${u.origin}/${head}/••••`;
  } catch {
    return "••••";
  }
}

function storedView(id: StoredChannelId, cfg: NotifyChannelsConfig): NotifyChannelView {
  if (id === "email") {
    const ch = cfg.email;
    const configured = !!(ch?.host && ch.to?.length);
    return {
      id, configured,
      on: configured && ch!.on,
      events: ch?.events ?? [],
      target: configured ? `${ch!.user ? `${ch!.user}@` : ""}${ch!.host} → ${ch!.to.join(", ")}` : null,
      lastOkAt: ch?.lastOkAt ?? null,
      lastError: ch?.lastError ?? null,
    };
  }
  const ch = cfg[id];
  const configured = !!ch?.url;
  return {
    id, configured,
    on: configured && ch!.on,
    events: ch?.events ?? [],
    target: configured ? maskWebhookUrl(ch!.url) : null,
    lastOkAt: ch?.lastOkAt ?? null,
    lastError: ch?.lastError ?? null,
  };
}

export async function channelViews(userId: string): Promise<NotifyChannelView[]> {
  const cfg = await readChannels(userId);
  const [tg, slack, push] = await Promise.all([
    getTelegramCreds(userId), getSlackWebhook(userId), pushChannelSummary(userId),
  ]);
  return [
    // Telegram/Slack credentials stay in their own User columns; only the event filter lives here.
    { id: "telegram" as const, configured: !!tg, on: !!tg, events: cfg.telegramEvents ?? [], target: tg ? `chat ${tg.chatId}` : null, lastOkAt: null, lastError: null },
    { id: "slack" as const, configured: !!slack, on: !!slack, events: cfg.slackEvents ?? [], target: slack ? maskWebhookUrl(slack) : null, lastOkAt: null, lastError: null },
    ...STORED_IDS.map(id => storedView(id, cfg)),
    // wave-nov (N10): the push row. Its config is not stored JSON but PushSubscription rows —
    // one event filter per device, so the card links to PushSettingsCard instead of editing
    // here. `target` carries the device count; lastOkAt is the newest accepted delivery.
    {
      id: "webpush" as const,
      configured: push.count > 0,
      on: push.count > 0,
      events: [],
      target: push.count > 0 ? `${push.count}` : null,
      lastOkAt: push.lastOkAt,
      lastError: null,
    },
  ];
}

// ─── Save-time validation ─────────────────────────────────────────────────────

function sanitizeEvents(value: unknown): NotifyEvent[] {
  if (!Array.isArray(value)) return [];
  return NOTIFY_EVENTS.filter(e => value.includes(e));
}

function sanitizeRecipients(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = value.map(v => String(v).trim()).filter(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
  if (out.length > 10) throw new ChannelError("invalid_value"); // brief: recipients ≤ 10
  return out;
}

/** Map an assertSafeTarget failure to a UI error code. */
function targetError(e: unknown): ChannelError {
  if (e instanceof SafeFetchError && e.code === "private_address") return new ChannelError("notifyChErr_private_address");
  return new ChannelError("notifyChErr_invalid_url");
}

/** undefined/null → keep; "" → keep (notifyChKeep); non-empty → validate shape + SSRF guard. */
async function resolveUrl(patchValue: unknown, current: string | undefined, shapeOk: (u: string) => boolean): Promise<string | undefined> {
  if (patchValue === undefined || patchValue === null) return current;
  const raw = String(patchValue).trim();
  if (raw === "") return current; // "leave empty to keep the current value"
  if (!shapeOk(raw)) throw new ChannelError("notifyChErr_invalid_url");
  try {
    await assertSafeTarget(raw);
  } catch (e) {
    throw targetError(e);
  }
  return raw;
}

/** A bare hostname (no scheme, no path, no port) that resolves to a non-private address. */
async function resolveSmtpHost(patchValue: unknown, current: string | undefined): Promise<string> {
  const raw = typeof patchValue === "string" ? patchValue.trim() : (current ?? "");
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(raw)) throw new ChannelError("notifyChErr_invalid_url");
  try {
    await assertSafeTarget(`https://${raw}`);
  } catch (e) {
    throw targetError(e);
  }
  return raw;
}

function resolveSecret(patchValue: unknown, current: string): string {
  if (patchValue === undefined || patchValue === null) return current;
  const raw = String(patchValue);
  return raw === "" ? current : raw; // "" = keep
}

export async function saveChannel(userId: string, id: StoredChannelId, patch: Record<string, unknown>): Promise<NotifyChannelView> {
  const cfg = await readChannels(userId);
  const events = sanitizeEvents(patch.events);
  // Explicit null url/host removes the channel (the API's delete path; the UI keeps it configured).
  const removing = patch.url === null || patch.host === null;

  if (!removing) {
    if (id === "discord" || id === "teams") {
      const cur = cfg[id];
      const on = patch.on === undefined ? (cur?.on ?? true) : !!patch.on;
      const shape = id === "discord" ? isDiscordWebhookUrl : isTeamsWebhookUrl;
      const url = await resolveUrl(patch.url, cur?.url, shape);
      if (!url) throw new ChannelError("notifyChErr_invalid_url");
      cfg[id] = { ...(cur ?? { on: true, events: [] as NotifyEvent[] }), url, on, events };
    } else if (id === "webhook") {
      const cur = cfg.webhook;
      const on = patch.on === undefined ? (cur?.on ?? true) : !!patch.on;
      const url = await resolveUrl(patch.url, cur?.url, isHttpsUrl);
      if (!url) throw new ChannelError("notifyChErr_invalid_url");
      cfg.webhook = { ...(cur ?? { on: true, events: [] as NotifyEvent[], secret: "" }), url, secret: resolveSecret(patch.secret, cur?.secret ?? ""), on, events };
    } else {
      const prev = cfg.email ?? { on: true, events: [] as NotifyEvent[], host: "", port: 465, secure: true, user: "", pass: "", from: "", to: [] as string[] };
      const on = patch.on === undefined ? prev.on : !!patch.on;
      const host = await resolveSmtpHost(patch.host, prev.host);
      const portRaw = patch.port === undefined ? prev.port : Number(patch.port);
      const port = Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65_535 ? portRaw : NaN;
      if (!port) throw new ChannelError("invalid_value");
      const from = typeof patch.from === "string" ? patch.from.trim() : prev.from;
      const to = Array.isArray(patch.to) ? sanitizeRecipients(patch.to) : prev.to;
      if (!from || !to.length) throw new ChannelError("invalid_value");
      cfg.email = {
        host, port,
        secure: patch.secure === undefined ? prev.secure : !!patch.secure,
        user: typeof patch.user === "string" ? patch.user.trim() : prev.user,
        pass: resolveSecret(patch.pass, prev.pass),
        from, to, on, events,
      };
    }
  } else {
    delete cfg[id];
  }

  try {
    await writeChannels(userId, cfg);
  } catch {
    throw new ChannelError("not_migrated"); // column missing — prisma db push not run
  }
  return (await channelViews(userId)).find(v => v.id === id)!;
}

/** Event filters for the two channels whose credentials live in their own User columns. */
export async function saveChannelEvents(userId: string, id: "telegram" | "slack", events: unknown): Promise<void> {
  const cfg = await readChannels(userId);
  const list = sanitizeEvents(events);
  if (id === "telegram") cfg.telegramEvents = list;
  else cfg.slackEvents = list;
  try {
    await writeChannels(userId, cfg);
  } catch {
    throw new ChannelError("not_migrated");
  }
}

// ─── HTTP transport (Discord / Teams / webhook) ───────────────────────────────

interface PostResult { ok: boolean; status: number; error?: string; retryAfterMs?: number }

async function postOnce(url: string, body: string, headers: Record<string, string>): Promise<PostResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      redirect: "manual", // a 3xx would let the address check be bypassed — treat as an error
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: "redirect" };
    if (res.ok) return { ok: true, status: res.status };
    if (res.status === 429) {
      // Discord answers 429 with { retry_after } in seconds; clamp to 10 s so we never hang.
      let retryAfterMs = 2_000;
      try {
        const d = await res.json();
        const ra = Number((d as { retry_after?: number | string }).retry_after);
        if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(10_000, Math.round(ra * 1000));
      } catch { /* non-JSON body — default wait */ }
      return { ok: false, status: 429, error: "rate_limited", retryAfterMs };
    }
    const txt = (await res.text().catch(() => "")).slice(0, 120);
    return { ok: false, status: res.status, error: `http_${res.status}${txt ? ` ${txt}` : ""}` };
  } catch (e) {
    return { ok: false, status: 0, error: String(e instanceof Error && e.name === "TimeoutError" ? "timeout" : ((e as Error)?.message ?? e)).slice(0, 200) };
  }
}

async function guardedPost(url: string, body: string, headers: Record<string, string> = {}): Promise<{ ok: boolean; error?: string }> {
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return { ok: false, error: "too_large" };
  try {
    await assertSafeTarget(url); // throws before any socket is opened
  } catch (e) {
    if (e instanceof SafeFetchError) return { ok: false, error: e.code === "private_address" ? "private_address" : "invalid_url" };
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  let r = await postOnce(url, body, headers);
  if (!r.ok && r.retryAfterMs != null) {
    await sleep(r.retryAfterMs); // 429: wait retry_after (≤ 10 s), then exactly one retry
    r = await postOnce(url, body, headers);
  } else if (!r.ok && (r.status === 0 || r.status >= 500)) {
    await sleep(2_000); // network error / 5xx: one retry after 2 s
    r = await postOnce(url, body, headers);
  }
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? `http_${r.status}` };
}

/** Cut on a character boundary so the string fits the byte budget (Cyrillic is 2 bytes/char). */
function fitUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let cut = maxBytes;
  while (cut > 0 && Buffer.byteLength(s.slice(0, cut), "utf8") > maxBytes) cut--;
  return s.slice(0, cut);
}

export async function sendDiscord(url: string, text: string): Promise<{ ok: boolean; error?: string }> {
  // Chunks are sent sequentially — Discord rate-limits bursts, and order matters.
  for (const chunk of toDiscordChunks(fitUtf8(text, MAX_TEXT_CHARS))) {
    const r = await guardedPost(url, JSON.stringify(discordBody(chunk)));
    if (!r.ok) return r;
  }
  return { ok: true };
}

export async function sendTeams(url: string, title: string, text: string): Promise<{ ok: boolean; error?: string }> {
  return guardedPost(url, JSON.stringify(toTeamsCard(title.slice(0, 500), fitUtf8(text, MAX_TEXT_CHARS))));
}

export async function sendWebhook(url: string, secret: string, event: NotifyEvent, title: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const body = toWebhookBody(event, title.slice(0, 500), fitUtf8(text, MAX_TEXT_CHARS), instanceUrl());
  // The signature covers the exact bytes on the wire — build first, then sign.
  const headers: Record<string, string> = {};
  if (secret) headers["X-OpenGSC-Signature"] = signWebhook(secret, body);
  return guardedPost(url, body, headers);
}

// ─── SMTP ─────────────────────────────────────────────────────────────────────

type EmailConfig = NonNullable<NotifyChannelsConfig["email"]>;

function smtpError(e: unknown): string {
  const err = e as { code?: string; message?: string; responseCode?: number };
  const code = String(err?.code ?? "");
  if (code === "EAUTH" || err?.responseCode === 535) return "smtp_auth";
  if (["ETIMEDOUT", "ECONNECTION", "ECONNREFUSED", "EDNS", "ESOCKET", "EPROTOCOL", "EENVELOPE", "EADDRESS"].includes(code)) return "smtp_connect";
  return `smtp_error ${String(err?.message ?? e).slice(0, 150)}`.trim();
}

export async function sendEmail(cfg: EmailConfig | null, title: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!cfg?.host || !cfg.to?.length) return { ok: false, error: "not_configured" };
  // The SMTP client must not become a port scanner of the internal network either.
  try {
    await assertSafeTarget(`https://${cfg.host}`);
  } catch (e) {
    if (e instanceof SafeFetchError) return { ok: false, error: e.code === "private_address" ? "private_address" : "smtp_connect" };
    return { ok: false, error: "smtp_connect" };
  }

  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    ...(cfg.user && cfg.pass ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  const mail = () => {
    const { subject, text: flat, html } = toEmail(title, fitUtf8(text, MAX_TEXT_CHARS));
    return transport.sendMail({ from: cfg.from, to: cfg.to.slice(0, 10).join(", "), subject, text: flat, html });
  };
  try {
    try {
      await mail();
    } catch (e) {
      if (smtpError(e) === "smtp_auth") throw e; // wrong password will not fix itself — no retry
      await sleep(2_000);
      await mail(); // one retry on network errors
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: smtpError(e) };
  } finally {
    transport.close();
  }
}

// ─── Delivery of one stored channel (used by the notifyUser fan-out) ─────────

export async function deliverStoredChannel(
  cfg: NotifyChannelsConfig, id: StoredChannelId, event: NotifyEvent, title: string, text: string,
): Promise<{ ok: boolean; error?: string }> {
  switch (id) {
    case "discord": return cfg.discord?.url ? sendDiscord(cfg.discord.url, text) : { ok: false, error: "not_configured" };
    case "teams": return cfg.teams?.url ? sendTeams(cfg.teams.url, title, text) : { ok: false, error: "not_configured" };
    case "email": return sendEmail(cfg.email ?? null, title, text);
    case "webhook":
      return cfg.webhook?.url
        ? sendWebhook(cfg.webhook.url, cfg.webhook.secret ?? "", event, title, text)
        : { ok: false, error: "not_configured" };
  }
}

// ─── "Send test" ──────────────────────────────────────────────────────────────

const CHANNEL_LABEL: Record<NotifyChannelId, string> = {
  telegram: "Telegram", slack: "Slack", discord: "Discord", teams: "Microsoft Teams", email: "E-mail", webhook: "Webhook",
  webpush: "Web Push", // wave-nov (N10): real channel since N10 — see sendWorkspacePush
};

export async function testChannel(userId: string, id: NotifyChannelId): Promise<NotifyDelivery> {
  const cfg = await readChannels(userId);
  // Test messages speak the language the user picked for alerts; the column may be missing.
  const lang = normalizeLang((await getAlertSettings(userId)).lang);
  const text = NOTIFY_L[lang].notifyTestMsg(CHANNEL_LABEL[id]);
  const title = text.split("\n")[0] ?? text;

  let r: { ok: boolean; error?: string };
  switch (id) {
    case "telegram": {
      const creds = await getTelegramCreds(userId);
      r = creds ? await sendTelegram(creds.botToken, creds.chatId, text) : { ok: false, error: "not_configured" };
      break;
    }
    case "slack": {
      const url = await getSlackWebhook(userId);
      r = url ? await sendSlack(url, text) : { ok: false, error: "not_configured" };
      break;
    }
    // wave-nov (N10): real delivery — one test push to every device of the workspace. No
    // stored config exists to deliver through; the subscriptions themselves ARE the channel.
    case "webpush": {
      const report = await sendWorkspacePush(userId, title, text, "test", { url: "/" });
      if (report.sent === 0) r = { ok: false, error: "not_configured" };
      else r = report.ok > 0 ? { ok: true } : { ok: false, error: report.error ?? `delivered ${report.ok}/${report.sent}` };
      break;
    }
    default:
      // A channel being tried out is testable even while its `on` switch is off.
      r = await deliverStoredChannel(cfg, id, "test", title, text);
      break;
  }

  const delivery: NotifyDelivery = r.ok ? { channel: id, ok: true } : { channel: id, ok: false, error: r.error };
  await updateDeliveryStatus(userId, [delivery]);
  return delivery;
}
